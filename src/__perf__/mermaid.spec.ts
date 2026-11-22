import "../__tests__/setup";
import { afterEach, describe, expect, test } from "bun:test";
import { createApp, HtmlRender } from "creo";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "../__tests__/setup";
import { createEditor, type SerializedDoc } from "../index";
import { mermaidPlugin, type MermaidEngine } from "../plugins/mermaid";
import { runtimeOf } from "../plugins/mermaid/runtime";

// "Anything running per edit must be O(mounted), not O(document)" — and for a
// diagram block the expensive thing is a draw. These count draws with a stub
// engine, so the gate is about HOW OFTEN the plugin asks for one, which is
// the part that is ours; how long one takes is Pele's.
afterEach(() => clearDom());

function countingEngine() {
  const calls = { mount: 0, update: 0 };
  const engine: MermaidEngine = {
    mount(el, source, hooks) {
      calls.mount++;
      el.innerHTML = `<svg data-src="${source.length}"></svg>`;
      hooks.onRender({ type: "flowchart", width: 100, height: 100 });
      return {
        update() {
          calls.update++;
          hooks.onRender({ type: "flowchart", width: 100, height: 100 });
        },
        refresh() {},
        destroy() {},
      };
    },
    check: () => null,
  };
  return { engine, calls };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("Performance gates — diagram blocks", () => {
  test("an edit to one block draws nothing else; an edit to text draws nothing at all", async () => {
    const N = 300;
    const { engine, calls } = countingEngine();
    const blocks: unknown[] = [];
    for (let i = 0; i < N; i++) {
      blocks.push({ id: `m${i}`, type: "mermaid", source: `flowchart TD\n  A${i} --> B${i}` });
      blocks.push({ id: `p${i}`, type: "p", runs: [{ text: `paragraph ${i}` }] });
    }
    const editor = createEditor({
      plugins: [mermaidPlugin({ engine: () => Promise.resolve(engine), preload: false, visualEditing: false })],
      initial: { blocks } as unknown as SerializedDoc,
    });
    createApp(() => editor.EditorView(), new HtmlRender(makeContainer()), SYNC_SCHEDULER).mount();
    await runtimeOf(editor)!.engine();
    await tick(40);
    // One draw per block, once.
    expect(calls.mount).toBe(N);
    expect(calls.update).toBe(0);

    // Typing in a paragraph: the diagrams are not the renderer's business.
    editor.selStore.set({ kind: "caret", at: { blockId: "p7", path: [0], offset: 0 } });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) editor.dispatch({ t: "insertText", text: "x" });
    const perKey = (performance.now() - t0) / 20;
    await tick(20);
    expect(calls.mount).toBe(N);
    expect(calls.update).toBe(0);
    // ~0.3ms measured; the budget is for a structural regression, not noise.
    expect(perKey).toBeLessThan(15);

    // Changing one diagram redraws that one.
    editor.dispatch({ t: "mermaid.setSource", payload: { blockId: "m3", source: "flowchart TD\n  X --> Y" } });
    await tick(20);
    expect(calls.mount).toBe(N);
    expect(calls.update).toBe(1);
  });

  test("the engine is not loaded for a document with no diagram", async () => {
    let loads = 0;
    const editor = createEditor({
      plugins: [mermaidPlugin({ engine: () => (loads++, Promise.resolve(countingEngine().engine)), preload: false })],
      initial: { blocks: [{ id: "a", type: "p", runs: [{ text: "no diagrams here" }] }] },
    });
    createApp(() => editor.EditorView(), new HtmlRender(makeContainer()), SYNC_SCHEDULER).mount();
    await tick(30);
    expect(loads).toBe(0);
  });
});
