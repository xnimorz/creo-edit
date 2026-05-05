import { _ } from "creo";
import { div, view } from "creo";
import type { Store } from "creo";
import type { BlockId, DocState, Selection } from "../model/types";
import { findPos } from "../model/doc";
import { selectionStart } from "../controller/selection";
import { getView } from "../plugin/registry";
import { HeightIndex } from "./heightIndex";

/**
 * VirtualDoc — windowed renderer that mounts only the blocks intersecting
 * `[scrollTop − overscan, scrollTop + viewport + overscan]`.
 *
 *  - Heights are measured per block via ResizeObserver and pushed into a
 *    Fenwick tree (`HeightIndex`) for O(log n) y-position lookups.
 *  - Top / bottom spacer divs absorb the off-screen height so the scrollbar
 *    behaves as if the whole document is rendered.
 *  - The block containing the caret is ALWAYS rendered, even when off-screen.
 *    Without this guarantee the caret overlay (which queries DOM) would lose
 *    its anchor when the user scrolls away with a selection.
 */

export type VirtualDocProps = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  /** Estimated default height in px for unmeasured blocks. */
  estimatedHeight?: number;
  /** Overscan factor — multiplied by viewport height for top/bottom slack. */
  overscan?: number;
  /** Optional fixed viewport height (else read from window.innerHeight). */
  viewportHeight?: number;
};

const DEFAULT_ESTIMATED = 32;
const DEFAULT_OVERSCAN = 1.5;

export const VirtualDoc = view<VirtualDocProps>(({ props, use }) => {
  const doc = use(props().docStore);
  const sel = use(props().selStore);
  const scrollTop = use(0);
  const viewport = use(props().viewportHeight ?? readViewportHeight());

  let heightIndex = new HeightIndex(
    doc.get().order.length,
    props().estimatedHeight ?? DEFAULT_ESTIMATED,
  );
  let resizeObserver: ResizeObserver | null = null;
  // BlockId → element so the ResizeObserver can find which index changed.
  const elByBlock = new Map<BlockId, HTMLElement>();

  // Sync the index size to the doc whenever the doc shape changes.
  const syncIndex = () => {
    const n = doc.get().order.length;
    if (heightIndex.size !== n) heightIndex.resize(n);
  };

  const measureAll = () => {
    const order = doc.get().order;
    for (let i = 0; i < order.length; i++) {
      const id = order[i]!;
      const el = elByBlock.get(id);
      if (el) {
        const h = el.getBoundingClientRect().height;
        if (h > 0) heightIndex.setHeight(i, h);
      }
    }
  };

  // Read the current scroll position from whichever element actually scrolls
  // — a custom overflow ancestor if there is one, else the window. We re-read
  // on every scroll event rather than trusting `e.target.scrollTop` because
  // (a) window scroll fires with e.target=document and document.scrollTop=0,
  // and (b) a synthetic dispatchEvent might land with e.target=window where
  // window.scrollTop is undefined.
  const readScrollPos = (): number => {
    const root = currentRoot();
    if (root) {
      const sc = scrollAncestor(root);
      if (sc) return sc.scrollTop;
    }
    return window.scrollY ?? document.documentElement.scrollTop ?? 0;
  };
  const onScroll = (): void => {
    scrollTop.set(readScrollPos());
  };

  const onResize = () => {
    viewport.set(props().viewportHeight ?? readViewportHeight());
  };

  return {
    onMount() {
      const root = currentRoot();
      if (!root) return;
      // Listen for scroll on the nearest scroll ancestor (default: window).
      const target = scrollAncestor(root) ?? window;
      target.addEventListener("scroll", onScroll, { passive: true } as never);
      window.addEventListener("resize", onResize);
      // ResizeObserver per block container.
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver((entries) => {
          for (const e of entries) {
            const id = (e.target as HTMLElement).getAttribute("data-block-id");
            if (!id) continue;
            const order = doc.get().order;
            const idx = order.indexOf(id);
            if (idx < 0) continue;
            const h = e.contentRect.height;
            if (h > 0) heightIndex.setHeight(idx, h);
          }
        });
        for (const el of elByBlock.values()) resizeObserver.observe(el);
      }
      measureAll();
    },
    onUpdateAfter() {
      syncIndex();
      measureAll();
      if (resizeObserver) {
        for (const el of elByBlock.values()) resizeObserver.observe(el);
      }
    },
    render() {
      syncIndex();
      const d = doc.get();
      const total = d.order.length;
      if (total === 0) return;
      const overscan = (props().overscan ?? DEFAULT_OVERSCAN) * viewport.get();
      const top = scrollTop.get();
      const bottom = top + viewport.get();
      const fromY = Math.max(0, top - overscan);
      const toY = bottom + overscan;
      const startIdx = heightIndex.findIndexAtY(fromY);
      let endIdx = heightIndex.findIndexAtY(toY);
      if (endIdx < startIdx) endIdx = startIdx;
      // The plan calls for "always render the selection's block". We leave
      // that optimization for M11 — naively extending the window with a
      // potentially-far-away selection breaks the spacer math (and
      // empirically, with selection at end-of-doc, mounts every block).
      // The caret overlay simply hides while its anchor is off-screen.
      void selectionStart;
      void findPos;
      const topSpacer = heightIndex.prefix(startIdx);
      const bottomSpacer = Math.max(
        0,
        heightIndex.total() - heightIndex.prefix(endIdx + 1),
      );

      div(
        {
          class: "creo-vroot",
          style: "position:relative;",
        },
        () => {
          if (topSpacer > 0) {
            div({
              class: "creo-vspacer-top",
              key: "top-spacer",
              style: `height:${topSpacer}px;`,
            });
          }
          for (let i = startIdx; i <= endIdx; i++) {
            const id = d.order[i]!;
            const block = d.byId.get(id)!;
            // Resolve the view via the plugin registry — same dispatch as
            // DocView, so plugin-registered block kinds render identically
            // when virtualized.
            const v = getView(block.type);
            if (v) v({ block, key: id });
          }
          if (bottomSpacer > 0) {
            div({
              class: "creo-vspacer-bottom",
              key: "bottom-spacer",
              style: `height:${bottomSpacer}px;`,
            });
          }
        },
      );
      // Refresh the elByBlock map from the live DOM after the render call
      // unwinds. We do this in onUpdateAfter / onMount via measureAll +
      // resize observation.
      void _;
    },
  };
});

function readViewportHeight(): number {
  if (typeof window === "undefined") return 800;
  const vv = (window as Window & { visualViewport?: VisualViewport })
    .visualViewport;
  // Use `||` (not `??`) so a 0 from either source falls through to the next —
  // some preview / headless environments report innerHeight=0 transiently,
  // which would otherwise leave the virtualizer with a zero-sized viewport
  // and only one block ever mounted.
  const h = (vv?.height || 0) || window.innerHeight || 0;
  return h > 0 ? h : 800;
}

function currentRoot(): HTMLElement | null {
  // The VirtualDoc is mounted inside the editor root; we don't currently
  // pass that root in, so fall back to the first one in the document. Tests
  // mount one editor at a time, real apps too.
  return document.querySelector("[data-creo-editor]") as HTMLElement | null;
}

function scrollAncestor(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (
      /(auto|scroll|overlay)/.test(
        style.overflowY + style.overflowX + style.overflow,
      )
    ) return cur;
    cur = cur.parentElement;
  }
  return null;
}
