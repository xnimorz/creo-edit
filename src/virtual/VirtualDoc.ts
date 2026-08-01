import { div, view } from "creo";
import type { Store } from "creo";
import type { Block, BlockId, DocState, Selection } from "../model/types";
import { getView } from "../plugin/registry";
import {
  getSelfVirtualized,
  isSelfVirtualized,
} from "../plugin/selfVirtualized";
import { HeightIndex } from "./heightIndex";

/**
 * VirtualDoc — windowed renderer that mounts only the blocks intersecting
 * `[scrollTop − overscan, scrollTop + viewport + overscan]`.
 *
 *  - Heights are measured per block via ResizeObserver and pushed into a
 *    Fenwick tree (`HeightIndex`) for O(log n) y-position lookups.
 *  - Top / bottom spacer divs absorb the off-screen height so the scrollbar
 *    behaves as if the whole document is rendered.
 *
 * The caret overlay simply hides while its anchor block is scrolled out of
 * the window — VirtualDoc does not subscribe to selection, so caret motion
 * never re-runs the windowing computation.
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
/** Fallback when a self-virtualized block's element isn't laid out yet. */
const DEFAULT_LINE_HEIGHT = 20;

export const VirtualDoc = view<VirtualDocProps>(({ props, use }) => {
  const doc = use(props().docStore);
  const scrollTop = use(0);
  const viewport = use(props().viewportHeight ?? readViewportHeight());

  let heightIndex = new HeightIndex(
    doc.get().order.length,
    props().estimatedHeight ?? DEFAULT_ESTIMATED,
  );
  let resizeObserver: ResizeObserver | null = null;
  // BlockId → mounted element (windowed subset) so the ResizeObserver and
  // measureAll can resolve heights; rebuilt from the live DOM after render.
  const elByBlock = new Map<BlockId, HTMLElement>();
  // Mounted elements of self-virtualized blocks. Tracked separately so they
  // are excluded from ResizeObserver reconciliation while still being
  // reachable for reading font metrics.
  const selfElByBlock = new Map<BlockId, HTMLElement>();
  // BlockId → order index, rebuilt only when the order array identity changes
  // (text edits keep the same `order` reference, so this is amortized cheap).
  const idToIndex = new Map<BlockId, number>();
  let lastOrder: BlockId[] | null = null;

  // ---------------------------------------------------------------------
  // Self-virtualized blocks (see plugin/selfVirtualized.ts). These manage
  // their own internal windowing, so we never measure them — we ask the
  // block kind for a height instead, and we do it for EVERY such block in
  // the doc, mounted or not, so the scrollbar is right from the first frame
  // rather than only once the block scrolls into view.
  // ---------------------------------------------------------------------
  /** Positions in `order` holding a self-virtualized block. Small by nature
   *  (a handful of code blocks), rebuilt only when `order` identity changes. */
  let selfIndices: number[] = [];
  /** Memo so `measureHeight` runs on block change, not per frame. `lineHeight`
   *  is part of the key: the first frames run before any element is laid out,
   *  so the metric starts at the default and must be able to correct itself. */
  const selfHeights = new Map<
    BlockId,
    { block: Block; height: number; lineHeight: number }
  >();
  /** Per-kind line-height, read off a mounted element once. */
  const lineHeightByType = new Map<string, number>();

  const lineHeightFor = (type: string): number => {
    const cached = lineHeightByType.get(type);
    if (cached !== undefined) return cached;
    let lh = DEFAULT_LINE_HEIGHT;
    for (const el of selfElByBlock.values()) {
      if (el.getAttribute("data-block-kind") !== type) continue;
      const parsed = readLineHeight(el);
      if (parsed > 0) {
        lh = parsed;
        // Only cache once we've actually seen a laid-out element; otherwise
        // an early zero-height frame would pin the default forever.
        lineHeightByType.set(type, lh);
      }
      break;
    }
    return lh;
  };

  const applySelfHeights = () => {
    if (selfIndices.length === 0) return;
    const d = doc.get();
    for (const i of selfIndices) {
      const id = d.order[i];
      if (!id) continue;
      const block = d.byId.get(id);
      if (!block) continue;
      const lineHeight = lineHeightFor(block.type);
      const memo = selfHeights.get(id);
      if (memo && memo.block === block && memo.lineHeight === lineHeight) {
        // Same block object and same metric — height is unchanged, but its
        // INDEX may have moved, so still write it in.
        heightIndex.setHeight(i, memo.height);
        continue;
      }
      const def = getSelfVirtualized(block.type);
      if (!def) continue;
      let h: number;
      try {
        h = def.measureHeight(block, { lineHeight });
      } catch {
        continue;
      }
      if (!(h > 0)) continue;
      selfHeights.set(id, { block, height: h, lineHeight });
      heightIndex.setHeight(i, h);
    }
  };

  // Sync the index size + id→index map whenever the doc shape changes.
  const syncIndex = () => {
    const d = doc.get();
    const order = d.order;
    if (heightIndex.size !== order.length) heightIndex.resize(order.length);
    if (order !== lastOrder) {
      idToIndex.clear();
      const nextSelf: number[] = [];
      for (let i = 0; i < order.length; i++) {
        const id = order[i]!;
        idToIndex.set(id, i);
        const b = d.byId.get(id);
        if (b && isSelfVirtualized(b.type)) nextSelf.push(i);
      }
      selfIndices = nextSelf;
      lastOrder = order;
      // Drop memos for blocks that left the doc.
      if (selfHeights.size > 0) {
        for (const id of selfHeights.keys()) {
          if (!idToIndex.has(id)) selfHeights.delete(id);
        }
      }
    }
    applySelfHeights();
  };

  // Rebuild elByBlock from the mounted DOM and reconcile ResizeObserver
  // subscriptions: observe newly mounted block elements, unobserve ones that
  // scrolled out of the window. Only top-level blocks carry data-block-kind
  // (cells share their parent's data-block-id), so this selects exactly the
  // measurable block containers.
  //
  // Self-virtualized blocks are routed to `selfElByBlock` instead and are
  // never observed: the block sizes itself from its own spacers, and an
  // observer would feed that self-chosen height straight back into the index
  // the block is already authoritative for — the two would fight every frame.
  // `data-block-kind` is already on the element, so the exclusion is a plain
  // attribute test with nothing extra to thread through.
  const refreshObservations = (root: HTMLElement) => {
    const els = root.querySelectorAll<HTMLElement>(
      "[data-block-kind][data-block-id]",
    );
    const seen = new Set<BlockId>();
    const seenSelf = new Set<BlockId>();
    for (let k = 0; k < els.length; k++) {
      const el = els[k]!;
      const id = el.getAttribute("data-block-id") as BlockId | null;
      if (!id) continue;
      const kind = el.getAttribute("data-block-kind") ?? "";
      if (isSelfVirtualized(kind)) {
        seenSelf.add(id);
        // If it used to be observed (kind changed under it), stop.
        const prevObserved = elByBlock.get(id);
        if (prevObserved) {
          resizeObserver?.unobserve(prevObserved);
          elByBlock.delete(id);
        }
        selfElByBlock.set(id, el);
        continue;
      }
      seen.add(id);
      const prev = elByBlock.get(id);
      if (prev !== el) {
        if (prev) resizeObserver?.unobserve(prev);
        elByBlock.set(id, el);
        resizeObserver?.observe(el);
      }
    }
    for (const [id, el] of elByBlock) {
      if (!seen.has(id)) {
        resizeObserver?.unobserve(el);
        elByBlock.delete(id);
      }
    }
    for (const id of selfElByBlock.keys()) {
      if (!seenSelf.has(id)) selfElByBlock.delete(id);
    }
  };

  const measureAll = () => {
    for (const [id, el] of elByBlock) {
      const i = idToIndex.get(id);
      if (i === undefined) continue;
      const h = el.getBoundingClientRect().height;
      if (h > 0) heightIndex.setHeight(i, h);
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

  // scrollToIndex — used by `editor.scrollToBlock` for blocks that aren't
  // currently mounted in the windowed renderer. We compute the target Y from
  // the height index, set scrollTop on the resolved container, and the
  // existing onScroll listener picks the new viewport up on the next render.
  const scrollToIndex = (
    i: number,
    opts?: { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior },
  ): void => {
    const root = currentRoot();
    if (!root) return;
    const sc = scrollAncestor(root);
    const vh = viewport.get();
    const blockTop = heightIndex.prefix(i);
    const blockH = i + 1 <= heightIndex.size
      ? heightIndex.prefix(i + 1) - blockTop
      : 0;
    const where = opts?.block ?? "center";
    let targetTop = blockTop;
    if (where === "center") targetTop = blockTop - Math.max(0, (vh - blockH) / 2);
    else if (where === "end") targetTop = blockTop - Math.max(0, vh - blockH);
    if (sc) {
      sc.scrollTo({ top: Math.max(0, targetTop), behavior: opts?.behavior ?? "auto" });
    } else {
      // Window scroll — translate by the editor root's offset, since
      // heightIndex measures relative to the spacer (root content origin).
      const rootRect = root.getBoundingClientRect();
      const rootTopAbs = (window.scrollY ?? 0) + rootRect.top;
      window.scrollTo({
        top: Math.max(0, rootTopAbs + targetTop),
        behavior: opts?.behavior ?? "auto",
      });
    }
  };

  return {
    onMount() {
      const root = currentRoot();
      if (!root) return;
      // Expose the scroll-to-index helper so `editor.scrollToBlock` can
      // jump to virtualized off-screen blocks. Hidden field — host code
      // should always go through the editor surface.
      (root as unknown as { __creoVirtual?: unknown }).__creoVirtual = {
        scrollToIndex,
      };
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
            const idx = idToIndex.get(id as BlockId);
            if (idx === undefined) continue;
            const h = e.contentRect.height;
            if (h > 0) heightIndex.setHeight(idx, h);
          }
        });
      }
      // refreshObservations first: it populates `selfElByBlock`, which is
      // where the self-virtualized line-height metric is read from, and
      // syncIndex consumes that metric.
      refreshObservations(root);
      syncIndex();
      measureAll();
    },
    onUpdateAfter() {
      const root = currentRoot();
      if (root) refreshObservations(root);
      syncIndex();
      measureAll();
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
            if (!v) continue;
            if (isSelfVirtualized(block.type)) {
              // Translate the window into the block's own coordinate space so
              // it can slice its sub-items without knowing about the outer
              // scroll container.
              const blockTop = heightIndex.prefix(i);
              const blockH = heightIndex.prefix(i + 1) - blockTop;
              v({
                block,
                key: id,
                viewport: {
                  top: Math.max(0, fromY - blockTop),
                  bottom: Math.max(0, Math.min(blockH, toY - blockTop)),
                },
              });
              continue;
            }
            v({ block, key: id });
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
    },
  };
});

/** Computed line-height in px, or 0 when it isn't resolvable (`normal`, or a
 *  headless environment with no layout). */
function readLineHeight(el: HTMLElement): number {
  try {
    const raw = window.getComputedStyle(el).lineHeight;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

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
  return document.querySelector("[data-creo-edit]") as HTMLElement | null;
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
