import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "../../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../../createEditor";
import { onMountedBlocksChanged } from "../../dom/mountSignal";
import { caretAt } from "../../controller/selection";
import { newBlockId } from "../../model/doc";
import type { BlockSpec } from "../../model/types";

afterEach(() => clearDom());

function bigDoc(n: number): { ids: string[]; blocks: BlockSpec[] } {
  const ids = Array.from({ length: n }, () => newBlockId());
  const blocks: BlockSpec[] = ids.map((id, i) => ({
    id,
    type: "p",
    runs: [{ text: `paragraph ${i}` }],
  }));
  return { ids, blocks };
}

describe("VirtualDoc", () => {
  it("with a small viewport, only a window of blocks is in the DOM", () => {
    // Stub viewport at 240px and estimated 30px → ~8 blocks * (1 + 1.5*2)
    // overscan ≈ 32 visible. We fix viewportHeight via createEditor opts.
    const root = makeContainer();
    const { blocks } = bigDoc(500);
    const editor = createEditor({
      initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
      virtualized: true,
      virtualEstimatedHeight: 30,
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();

    const ps = root.querySelectorAll("p[data-block-id]");
    // 500 paragraphs would normally be 500 <p> nodes; virtualized should
    // mount at most ~few hundred (default viewport). Just assert it's
    // strictly less than the total.
    expect(ps.length).toBeLessThan(500);
    expect(ps.length).toBeGreaterThan(0);
  });

  it("does NOT mount blocks far outside the viewport", () => {
    const root = makeContainer();
    const { ids, blocks } = bigDoc(2000);
    const editor = createEditor({
      initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
      virtualized: true,
      virtualEstimatedHeight: 20,
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    // A block 1500 entries deep is way past the rendered window.
    const farId = ids[1500]!;
    expect(root.querySelector(`p[data-block-id="${farId}"]`)).toBeFalsy();
    // The first block (index 0) is mounted.
    expect(root.querySelector(`p[data-block-id="${ids[0]}"]`)).toBeTruthy();
  });

  it("renders top + bottom spacer divs to absorb off-screen height", () => {
    const root = makeContainer();
    const { blocks } = bigDoc(200);
    const editor = createEditor({
      initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
      virtualized: true,
      virtualEstimatedHeight: 30,
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const vroot = root.querySelector(".creo-vroot");
    expect(vroot).toBeTruthy();
    // At least one of the two spacers should exist (top: 0 if scrollTop=0,
    // but bottom should be non-zero with 200 blocks of 30px each).
    const bottom = root.querySelector(".creo-vspacer-bottom");
    expect(bottom).toBeTruthy();
  });

  it("announces when scrolling changes which blocks are mounted", () => {
    // Overlay managers (range decorations, inline widgets) repaint off this
    // signal. It used to be inferred with a subtree MutationObserver, which
    // also fired for every text node the renderer touched while typing —
    // a whole extra repaint per keystroke on top of the doc subscription
    // that already covered the edit.
    const root = makeContainer();
    const { ids, blocks } = bigDoc(2000);
    const editor = createEditor({
      initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
      virtualized: true,
      virtualEstimatedHeight: 20,
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();

    let fired = 0;
    const off = onMountedBlocksChanged(() => { fired++; });
    try {
      // Typing re-renders one block in place; the mounted set is untouched,
      // so nothing is announced.
      editor.selStore.set({ kind: "caret", at: caretAt(ids[0]!, 0) });
      editor.dispatch({ t: "insertText", text: "x" });
      expect(fired).toBe(0);

      // Scrolling does change it.
      Object.defineProperty(window, "scrollY", {
        value: 20_000,
        configurable: true,
      });
      window.dispatchEvent(new Event("scroll"));
      expect(fired).toBeGreaterThan(0);
      // The window really did move — a block that was off-screen is mounted.
      expect(root.querySelector(`p[data-block-id="${ids[1000]}"]`)).toBeTruthy();
    } finally {
      off();
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    }
  });

  it("two editors on one page each window their own document", () => {
    // The virtualizer used to resolve its root as "the first [data-creo-edit]
    // in the document", so a second editor measured the first one's blocks and
    // announced mount changes against the first one's root — which any overlay
    // manager listening on that root would then repaint for.
    const rootA = makeContainer();
    const rootB = makeContainer();
    const mk = (n: number, container: HTMLElement) => {
      const { blocks } = bigDoc(n);
      const editor = createEditor({
        initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
        virtualized: true,
        virtualEstimatedHeight: 20,
      });
      createApp(
        () => editor.EditorView(),
        new HtmlRender(container),
        SYNC_SCHEDULER,
      ).mount();
      return editor;
    };
    const a = mk(2000, rootA);
    const b = mk(2000, rootB);

    const elRootA = rootA.querySelector<HTMLElement>("[data-creo-edit]")!;
    const elRootB = rootB.querySelector<HTMLElement>("[data-creo-edit]")!;
    expect(elRootA).not.toBe(elRootB);

    const announced: HTMLElement[] = [];
    const off = onMountedBlocksChanged((r) => { announced.push(r); });
    try {
      Object.defineProperty(window, "scrollY", { value: 8_000, configurable: true });
      window.dispatchEvent(new Event("scroll"));
      // Each editor speaks for itself.
      expect(announced).toContain(elRootA);
      expect(announced).toContain(elRootB);
      // And each mounted only blocks from its own document.
      const idsIn = (el: HTMLElement) =>
        Array.from(el.querySelectorAll<HTMLElement>("p[data-block-id]"))
          .map((p) => p.getAttribute("data-block-id")!);
      const ownA = new Set(a.docStore.get().order);
      const ownB = new Set(b.docStore.get().order);
      expect(idsIn(elRootA).every((id) => ownA.has(id))).toBe(true);
      expect(idsIn(elRootB).every((id) => ownB.has(id))).toBe(true);
      expect(idsIn(elRootA).length).toBeGreaterThan(0);
      expect(idsIn(elRootB).length).toBeGreaterThan(0);
    } finally {
      off();
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    }
  });
});
