import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "../../__tests__/setup";
import { createApp, HtmlRender, store } from "creo";

import { createEditor } from "../../createEditor";
import { caretAt } from "../../controller/selection";
import { newBlockId } from "../../model/doc";
import type { BlockId, BlockSpec } from "../../model/types";
import { HeightIndex } from "../heightIndex";

afterEach(() => clearDom());

function paragraphs(n: number): { ids: string[]; blocks: BlockSpec[] } {
  const ids = Array.from({ length: n }, () => newBlockId());
  return { ids, blocks: ids.map((id, i) => ({ id, type: "p", runs: [{ text: `paragraph ${i}` }] })) };
}

function mount(opts: Parameters<typeof createEditor>[0]) {
  const root = makeContainer();
  const editor = createEditor(opts);
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  const el = root.querySelector("[data-creo-edit]") as HTMLElement;
  return { root, editor, el };
}

describe("HeightIndex.from", () => {
  it("holds exactly the heights it is given", () => {
    const heights = Float64Array.from([10, 0, 30, 5, 0, 0, 70, 1]);
    const index = HeightIndex.from(heights, 32);
    let sum = 0;
    for (let i = 0; i < heights.length; i++) {
      expect(index.prefix(i)).toBeCloseTo(sum, 6);
      expect(index.heightAt(i)).toBe(heights[i]!);
      sum += heights[i]!;
    }
    expect(index.total()).toBeCloseTo(sum, 6);
    expect(index.findIndexAtY(10)).toBe(2); // the 0-height block at 1 holds no y
    expect(index.findIndexAtY(45)).toBe(6);
    index.setHeight(1, 20);
    expect(index.prefix(3)).toBeCloseTo(60, 6);
  });
});

describe("VirtualDoc — the window", () => {
  it("hidden blocks are not drawn and take no height", () => {
    const { ids, blocks } = paragraphs(400);
    const hidden = store.new<ReadonlySet<BlockId>>(new Set());
    const { root } = mount({ initial: { blocks: blocks as never }, virtualized: true, virtualEstimatedHeight: 20, virtualHidden: hidden });
    const bottom = () => parseFloat((root.querySelector(".creo-vspacer-bottom") as HTMLElement).style.height);
    const drawn = (i: number) => !!root.querySelector(`[data-block-id="${ids[i]}"]`);
    expect(drawn(1)).toBe(true);
    const before = bottom();
    const mountedBefore = root.querySelectorAll("p[data-block-id]").length;

    // Blocks 1…300 folded away: none of them is drawn, the ones after move
    // up into the window, and the document is 300 blocks shorter.
    hidden.set(new Set(ids.slice(1, 301)));
    expect(drawn(0)).toBe(true);
    expect(drawn(1)).toBe(false);
    expect(drawn(300)).toBe(false);
    expect(drawn(301)).toBe(true);
    expect(root.querySelectorAll("p[data-block-id]").length).toBe(mountedBefore);
    expect(bottom()).toBe(before - 300 * 20);

    hidden.set(new Set());
    expect(drawn(1)).toBe(true);
    expect(bottom()).toBe(before);
  });

  it("keeps the selection's blocks mounted while the editor has the focus", () => {
    const { ids, blocks } = paragraphs(1000);
    const { root, editor, el } = mount({ initial: { blocks: blocks as never }, virtualized: true, virtualEstimatedHeight: 20 });
    const drawn = (i: number) => !!root.querySelector(`[data-block-id="${ids[i]}"]`);

    // Not focused: the model's selection mounts nothing.
    editor.selStore.set({ kind: "caret", at: caretAt(ids[700]!, 0) });
    expect(drawn(700)).toBe(false);

    el.focus();
    expect(document.activeElement).toBe(el);
    editor.selStore.set({ kind: "caret", at: caretAt(ids[600]!, 0) });
    // The caret's block, and the ones an arrow key reaches from it.
    expect(drawn(600)).toBe(true);
    expect(drawn(599)).toBe(true);
    expect(drawn(601)).toBe(true);
    expect(drawn(602)).toBe(false);
    // Between the window and the pinned blocks, and after them: spacers.
    expect(root.querySelectorAll(".creo-vspacer-gap").length).toBe(1);
    expect(root.querySelector(".creo-vspacer-bottom")).toBeTruthy();

    // A range: both ends.
    editor.selStore.set({ kind: "range", anchor: caretAt(ids[300]!, 0), focus: caretAt(ids[900]!, 0) });
    expect(drawn(300)).toBe(true);
    expect(drawn(900)).toBe(true);
    expect(drawn(600)).toBe(false);
  });

  it("groups a run of list items in one list, as the whole-document renderer does", () => {
    const blocks: BlockSpec[] = [
      { id: newBlockId(), type: "p", runs: [{ text: "before" }] },
      ...Array.from({ length: 5 }, (_, i) => ({ id: newBlockId(), type: "li" as const, ordered: true, depth: 0 as const, runs: [{ text: `step ${i}` }] })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: newBlockId(), type: "li" as const, ordered: false, depth: 0 as const, runs: [{ text: `bullet ${i}` }] })),
      { id: newBlockId(), type: "p", runs: [{ text: "after" }] },
    ];
    const whole = mount({ initial: { blocks: blocks as never } });
    const shape = (root: HTMLElement) =>
      Array.from(root.querySelectorAll("[data-creo-edit] ol.ce-list, [data-creo-edit] ul.ce-list")).map((l) => `${l.tagName}:${l.querySelectorAll("[data-block-id]").length}`);
    const expected = shape(whole.root);
    expect(expected).toEqual(["OL:5", "UL:3"]);
    clearDom();
    const windowed = mount({ initial: { blocks: blocks as never }, virtualized: true });
    expect(shape(windowed.root)).toEqual(expected);
  });

  it("a spacer carries the host's style for the blocks it stands for", () => {
    const { blocks } = paragraphs(500);
    const seen: number[] = [];
    const { root } = mount({
      initial: { blocks: blocks as never },
      virtualized: true,
      virtualEstimatedHeight: 20,
      virtualSpacerStyle: (doc, next) => {
        seen.push(next);
        return `--left-out:${doc.order.length - next};`;
      },
    });
    const bottom = root.querySelector(".creo-vspacer-bottom") as HTMLElement;
    // The last spacer is told there is nothing after it.
    expect(seen.at(-1)).toBe(500);
    expect(bottom.style.getPropertyValue("--left-out").trim()).toBe("0");
    expect(bottom.getAttribute("contenteditable")).toBe("false");
  });

  it("`virtualized` as a thunk switches renderers when the document asks", () => {
    const { blocks } = paragraphs(300);
    let windowed = false;
    const { root, editor } = mount({ initial: { blocks: blocks as never }, virtualized: () => windowed, virtualEstimatedHeight: 20 });
    expect(root.querySelector(".creo-vroot")).toBeFalsy();
    expect(root.querySelectorAll("p[data-block-id]").length).toBe(300);
    windowed = true;
    editor.selStore.set({ kind: "caret", at: caretAt(blocks[0]!.id!, 0) });
    editor.dispatch({ t: "insertText", text: "x" });
    expect(root.querySelector(".creo-vroot")).toBeTruthy();
    expect(root.querySelectorAll("p[data-block-id]").length).toBeLessThan(300);
  });
});

describe("the editor root's attributes", () => {
  it("is editable from its first render, and a root that leaves is not touched", async () => {
    const { blocks } = paragraphs(3);
    const { el, editor } = mount({ initial: { blocks: blocks as never } });
    expect(el.getAttribute("contenteditable")).toBe("true");
    expect(el.getAttribute("spellcheck")).toBe("false");

    // Destroyed with its root still on the page: no longer editable — a
    // microtask later, so a root that leaves with its editor is never
    // restyled for nothing.
    editor.destroy();
    expect(el.getAttribute("contenteditable")).toBe("true");
    await Promise.resolve();
    expect(el.hasAttribute("contenteditable")).toBe(false);
  });

  it("a root removed with its editor keeps its attributes (nothing is restyled)", async () => {
    const { blocks } = paragraphs(3);
    const { el, editor } = mount({ initial: { blocks: blocks as never } });
    editor.destroy();
    el.remove();
    await Promise.resolve();
    expect(el.getAttribute("contenteditable")).toBe("true");
  });

  it("spellcheck is the host's: off by default, on when asked for", () => {
    const { blocks } = paragraphs(3);
    expect(mount({ initial: { blocks: blocks as never } }).el.getAttribute("spellcheck")).toBe("false");
    clearDom();
    // It was forced off whatever the option said.
    expect(mount({ initial: { blocks: blocks as never }, spellcheck: true }).el.getAttribute("spellcheck")).toBe("true");
  });

  it("read-only is on the root from the first render too", () => {
    const { blocks } = paragraphs(3);
    const { el } = mount({ initial: { blocks: blocks as never }, editable: false });
    expect(el.getAttribute("contenteditable")).toBe("false");
  });
});
