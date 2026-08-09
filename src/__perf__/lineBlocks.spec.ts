import { afterEach, describe, expect, it } from "bun:test";
import "../__tests__/setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { caretAt } from "../controller/selection";
import { DecorationManager } from "../plugin/decorations";
import type { BlockSpec } from "../model/types";

// ---------------------------------------------------------------------------
// The "document is a file, lines are blocks" shape: one text block per source
// line, block-level virtualization doing the windowing.
//
// The point of these gates is that cost tracks the WINDOW, not the file. The
// number of blocks in the DOM is the same at 2 000 lines and 50 000 — so if a
// timing here scales with the file, something is walking `doc.order` that
// should be walking the mounted set. That was true of
// `DecorationManager.sync()`, which cost ~1.2s per sync at 50 000 blocks and
// ran on every keystroke.
//
// Timings are under happy-dom and therefore inflated; budgets are loose
// enough not to flake and tight enough that O(document) work blows them.
// ---------------------------------------------------------------------------

afterEach(clearDom);

const LINES = 50_000;

function lineBlocks(n: number): BlockSpec[] {
  return Array.from({ length: n }, (_v, i) => ({
    type: "p" as const,
    runs: [{ text: `  const value${i} = compute(${i}, "label ${i}"); // note ${i}` }],
  })) as BlockSpec[];
}

function mountFile(n: number) {
  const container = makeContainer();
  const editor = createEditor({
    initial: { blocks: lineBlocks(n) as never },
    virtualized: true,
    virtualEstimatedHeight: 20,
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const root = container.querySelector<HTMLElement>("[data-creo-edit]")!;
  return { editor, container, root };
}

describe("Performance gates — one block per line", () => {
  it(`opens a ${LINES.toLocaleString()}-line file in < 400ms`, () => {
    const t0 = performance.now();
    const { container } = mountFile(LINES);
    const dt = performance.now() - t0;
    const mounted = container.querySelectorAll("[data-block-kind]").length;
    // Only the window is in the DOM — that's the whole premise.
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(500);
    expect(dt).toBeLessThan(400);
  });

  it("decoration sync is O(mounted), not O(file)", () => {
    const { editor, root, container } = mountFile(LINES);
    const mounted = container.querySelectorAll("[data-block-kind]").length;
    const t0 = performance.now();
    const dm = new DecorationManager({
      registry: editor.registry,
      docStore: editor.docStore,
      editorRoot: root,
    });
    const dt = performance.now() - t0;
    dm.destroy();
    // The default plugin set contributes decorations; if it ever stops, this
    // gate would pass vacuously.
    expect(editor.registry.decorations.length).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(500);
    expect(dt).toBeLessThan(50);
  });

  it("keystroke stays flat as the file grows", () => {
    const { editor, container } = mountFile(LINES);
    const first = container
      .querySelector("[data-block-id]")!
      .getAttribute("data-block-id")!;
    editor.selStore.set({ kind: "caret", at: caretAt(first, 3) });
    const N = 20;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) editor.dispatch({ t: "insertText", text: "x" });
    const avg = (performance.now() - t0) / N;
    expect(avg).toBeLessThan(4);
  });

  it("Enter mid-file inserts a line without touching the rest", () => {
    const { editor } = mountFile(LINES);
    const order = editor.docStore.get().order;
    const mid = order[Math.floor(LINES / 2)]!;
    editor.selStore.set({ kind: "caret", at: caretAt(mid, 5) });
    const N = 10;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) editor.dispatch({ t: "splitBlock" });
    const avg = (performance.now() - t0) / N;
    expect(editor.docStore.get().order.length).toBe(LINES + N);
    expect(avg).toBeLessThan(10);
  });
});
