import { div, ol, ul, view } from "creo";
import type { Store } from "creo";
import type {
  Block,
  BlockId,
  DocState,
  ListItemBlock,
  Selection,
} from "../model/types";
import { getView } from "../plugin/registry";
import {
  getSelfVirtualized,
  isSelfVirtualized,
} from "../plugin/selfVirtualized";
import { notifyMountedBlocksChanged } from "../dom/mountSignal";
import { scrollAncestor } from "../dom/scroll";
import { HeightIndex } from "./heightIndex";

/**
 * VirtualDoc — windowed renderer that mounts only the blocks intersecting
 * `[scrollTop − overscan, scrollTop + viewport + overscan]`.
 *
 *  - Each block's **advance** — the distance from its top to the top of
 *    whatever is laid out after it, so margins and gaps are counted — is
 *    measured off the DOM and pushed into a Fenwick tree (`HeightIndex`) for
 *    O(log n) y-position lookups. Measurements are kept by block id, so a
 *    block inserted or moved never inherits its neighbour's.
 *  - Spacer divs absorb the height of what is not mounted, so the scrollbar
 *    behaves as if the whole document were rendered.
 *  - The window is positioned from where the editor actually is inside its
 *    scroller, not from the scroller's `scrollTop` alone: an editor below a
 *    header, or nested in a block of another editor, windows correctly.
 *  - Consecutive list items are grouped in a `<ul>` / `<ol class="ce-list">`
 *    exactly as `DocView` groups them, so a host's list CSS and layout are
 *    the same in both renderers.
 *
 * Three kinds of block are mounted whatever the scroll position (**pins**):
 * while the editor has the focus, the selection's end points (with the focus
 * block's neighbours, so an arrow
 * key pressed with the caret out of sight lands in the next real block, not
 * across a spacer), the block holding the focused element (a form field in a
 * card), and a block a `scrollToBlock` is on its way to. Unmounting any of
 * them would drop the browser's own selection or focus — and the next key
 * would act somewhere else.
 *
 * Blocks in `hidden` are not drawn at all and take no height (a host folding
 * a section): hiding 2 000 blocks with CSS would still mount all of them the
 * moment the window reached their — zero-height — run.
 *
 * VirtualDoc holds the scroll position steady itself when what is above the
 * viewport changes size (a block mounted with a wrong estimate, an image
 * loading, a remote edit): it remembers where the first visible block sits
 * and puts it back. The browser's scroll anchoring is switched off inside
 * the window (`overflow-anchor: none`) so the two never both correct; not
 * every browser has it anyway.
 */

export type VirtualDocProps = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  /** Estimated default height in px for unmeasured blocks. */
  estimatedHeight?: number;
  /**
   * A per-block estimate for a block not measured yet (its text length, its
   * kind). The closer it is, the less the scrollbar moves as blocks are
   * measured. Falls back to `estimatedHeight`. Called once per block object.
   */
  estimateHeight?: (block: Block) => number;
  /** Overscan factor — multiplied by viewport height for top/bottom slack. */
  overscan?: number;
  /** Optional fixed viewport height (else read from window.innerHeight). */
  viewportHeight?: number;
  /**
   * The owning editor's `data-creo-edit` id. Without it the root is resolved
   * as "the first editor in the document", which is wrong the moment a page
   * holds two of them — the virtualizer would measure one editor's blocks and
   * announce mount changes against the other's root. `createEditor` always
   * passes it; the prop is optional only so existing direct callers keep
   * working.
   */
  editorId?: string;
  /** Blocks not drawn, taking no height. A new set (identity) per change. */
  hidden?: Store<ReadonlySet<BlockId>>;
  /** The atomic block the selection covers whole, told to its view. */
  selectedBlock?: Store<BlockId | null>;
  /**
   * Extra inline style for a spacer, given the document and the index of the
   * block drawn right after it (`order.length` for the last spacer). For
   * what a host's CSS carries from block to block through the document — CSS
   * counters numbering a list: the blocks a spacer stands for are not there
   * to count, so the spacer sets the count they would have left.
   */
  spacerStyle?: (doc: DocState, nextIndex: number) => string | undefined;
};

const DEFAULT_ESTIMATED = 32;
const DEFAULT_OVERSCAN = 1.5;
/** Fallback when a self-virtualized block's element isn't laid out yet. */
const DEFAULT_LINE_HEIGHT = 20;
/** Marks a spacer, so it is found among the blocks when measuring. */
export const VSPACER_ATTR = "data-creo-vspacer";
const BLOCK_SELECTOR = "[data-block-kind][data-block-id]";
const NONE: ReadonlySet<BlockId> = new Set();

type Reveal = {
  id: BlockId;
  block: ScrollLogicalPosition;
  behavior: ScrollBehavior;
};
type Item =
  | { spacer: number; key: string; cls: string; next: number }
  | { i: number; spacer?: undefined };

export const VirtualDoc = view<VirtualDocProps>(({ props, use }) => {
  const doc = use(props().docStore);
  const hiddenStore = props().hidden;
  if (hiddenStore) use(hiddenStore);
  const selectedStore = props().selectedBlock;
  if (selectedStore) use(selectedStore);
  // Everything else that moves the window — a scroll past the mounted slack,
  // a measurement, the selection leaving the mounted set — asks for a render
  // through this counter. The scroll position itself is a plain variable: a
  // scroll inside the slack must cost nothing.
  const tick = use(0);
  const rerender = (): void => tick.set(tick.get() + 1);

  const estimated = (): number => props().estimatedHeight ?? DEFAULT_ESTIMATED;
  let heightIndex = new HeightIndex(0, estimated());
  /** Measured advance per block. Survives the block leaving the window. */
  const heightById = new Map<BlockId, number>();
  const estimates = new WeakMap<Block, number>();
  let resizeObserver: ResizeObserver | null = null;
  // BlockId → mounted element (windowed subset), rebuilt from the live DOM
  // after render. Only this editor's own blocks: an editor nested in one of
  // them has blocks of its own under the same root.
  const elByBlock = new Map<BlockId, HTMLElement>();
  // Mounted elements of self-virtualized blocks. Tracked separately so they
  // are excluded from ResizeObserver reconciliation while still being
  // reachable for reading font metrics.
  const selfElByBlock = new Map<BlockId, HTMLElement>();
  // BlockId → order index, rebuilt only when the order array identity changes
  // (text edits keep the same `order` reference, so this is amortized cheap).
  const idToIndex = new Map<BlockId, number>();
  let lastOrder: BlockId[] | null = null;
  let lastHidden: ReadonlySet<BlockId> = NONE;

  /** Where the viewport's top is, in px below the top of the blocks. */
  let relTop = 0;
  let viewportH = props().viewportHeight ?? readViewportHeight();
  /** The window as last rendered (indices into `order`). */
  let rendered = { start: 0, end: -1 };
  let scroller: HTMLElement | null = null;
  let scrollTarget: EventTarget | null = null;
  /** The scroll position as last seen or set here: one that differs was
   *  moved by someone else, and is adopted rather than "corrected". */
  let lastScrollPos = 0;
  /** The first visible block and how far below the viewport's top it sits. */
  let anchor: { id: BlockId; top: number } | null = null;
  let reveal: Reveal | null = null;
  let unsubSel: (() => void) | null = null;

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

  /** This VirtualDoc's own editor root — exact when `editorId` is supplied. */
  const currentRoot = (): HTMLElement | null => rootFor(props().editorId);
  const owns = (root: HTMLElement, el: Element): boolean =>
    el.closest("[data-creo-edit]") === root;
  const mounted = (id: BlockId): HTMLElement | undefined =>
    elByBlock.get(id) ?? selfElByBlock.get(id);

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
      if (!id || lastHidden.has(id)) continue;
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

  const estimateOf = (block: Block): number => {
    const fn = props().estimateHeight;
    if (!fn) return estimated();
    let h = estimates.get(block);
    if (h === undefined) {
      try {
        h = fn(block);
      } catch {
        h = estimated();
      }
      if (!(h >= 0)) h = estimated();
      estimates.set(block, h);
    }
    return h;
  };

  // The index follows the document's shape: rebuilt — O(n), from the heights
  // kept by id — when blocks are added, removed, reordered, hidden or shown.
  // A text edit keeps `order`'s identity and costs nothing here.
  const syncIndex = () => {
    const d = doc.get();
    const order = d.order;
    const hid = hiddenStore?.get() ?? NONE;
    const orderChanged = order !== lastOrder;
    if (orderChanged) {
      idToIndex.clear();
      const nextSelf: number[] = [];
      for (let i = 0; i < order.length; i++) {
        const id = order[i]!;
        idToIndex.set(id, i);
        const b = d.byId.get(id);
        if (b && isSelfVirtualized(b.type)) nextSelf.push(i);
      }
      selfIndices = nextSelf;
      // Drop what is kept for blocks that left the doc.
      for (const id of selfHeights.keys()) {
        if (!idToIndex.has(id)) selfHeights.delete(id);
      }
      for (const id of heightById.keys()) {
        if (!idToIndex.has(id)) heightById.delete(id);
      }
    }
    if (orderChanged || hid !== lastHidden || heightIndex.size !== order.length) {
      const heights = new Float64Array(order.length);
      for (let i = 0; i < order.length; i++) {
        const id = order[i]!;
        if (hid.has(id)) continue; // 0
        const measured = heightById.get(id);
        if (measured !== undefined) {
          heights[i] = measured;
          continue;
        }
        const self = selfHeights.get(id);
        const b = d.byId.get(id);
        heights[i] = self ? self.height : b ? estimateOf(b) : estimated();
      }
      heightIndex = HeightIndex.from(heights, estimated());
      lastOrder = order;
      lastHidden = hid;
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
  //
  // It also reports whether the mounted SET changed, which is the signal the
  // overlay managers subscribe to (see dom/mountSignal.ts). A text edit
  // re-renders one block in place and leaves the set alone, so this stays
  // quiet on the typing path.
  const refreshObservations = (root: HTMLElement): boolean => {
    const els = root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR);
    let changed = false;
    const seen = new Set<BlockId>();
    const seenSelf = new Set<BlockId>();
    for (let k = 0; k < els.length; k++) {
      const el = els[k]!;
      const id = el.getAttribute("data-block-id") as BlockId | null;
      if (!id || !owns(root, el)) continue;
      const kind = el.getAttribute("data-block-kind") ?? "";
      if (isSelfVirtualized(kind)) {
        if (selfElByBlock.get(id) !== el) changed = true;
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
        // A block drawn anew counts too: what hangs off its element (an
        // overlay, the page's selection) has to be put back.
        changed = true;
        if (prev) resizeObserver?.unobserve(prev);
        elByBlock.set(id, el);
        resizeObserver?.observe(el);
      }
    }
    for (const [id, el] of elByBlock) {
      if (!seen.has(id)) {
        resizeObserver?.unobserve(el);
        elByBlock.delete(id);
        changed = true;
      }
    }
    for (const id of selfElByBlock.keys()) {
      if (!seenSelf.has(id)) {
        selfElByBlock.delete(id);
        changed = true;
      }
    }
    return changed;
  };

  const vrootOf = (root: HTMLElement): HTMLElement => {
    for (let c = root.firstElementChild; c; c = c.nextElementSibling) {
      if (c.classList.contains("creo-vroot")) return c as HTMLElement;
    }
    return root;
  };

  // Each mounted block's advance, read off the layout in one pass: the
  // distance to the top of the next thing in flow (a block, a spacer, the end
  // of the blocks). A block's own box would leave out the margins between
  // blocks, and the index — the sum of them — would drift from the page by
  // that much per block: far enough, in a long document, to window the wrong
  // blocks. Returns whether any advance changed.
  const measure = (root: HTMLElement): boolean => {
    const vroot = vrootOf(root);
    const box = vroot.getBoundingClientRect();
    // No layout (a headless test, a detached or `display: none` editor):
    // nothing here is a measurement.
    if (!(box.height > 0)) return false;
    const flow = root.querySelectorAll<HTMLElement>(
      `${BLOCK_SELECTOR}, [${VSPACER_ATTR}]`,
    );
    const els: HTMLElement[] = [];
    const tops: number[] = [];
    let changed = false;
    for (let k = 0; k < flow.length; k++) {
      const el = flow[k]!;
      if (!owns(root, el)) continue;
      if (el.getClientRects().length === 0) {
        // Not laid out (`display: none`): it takes no room.
        changed = setMeasured(el, 0) || changed;
        continue;
      }
      els.push(el);
      tops.push(el.getBoundingClientRect().top);
    }
    for (let k = 0; k < els.length; k++) {
      const next = k + 1 < els.length ? tops[k + 1]! : box.bottom;
      const advance = next - tops[k]!;
      if (advance >= 0) changed = setMeasured(els[k]!, advance) || changed;
    }
    return changed;
  };
  const setMeasured = (el: HTMLElement, h: number): boolean => {
    const id = el.getAttribute("data-block-id") as BlockId | null;
    if (!id || el.hasAttribute(VSPACER_ATTR) || selfElByBlock.has(id)) return false;
    const i = idToIndex.get(id);
    if (i === undefined || lastHidden.has(id)) return false;
    const prev = heightIndex.heightAt(i);
    heightById.set(id, h);
    if (prev === h) return false;
    heightIndex.setHeight(i, h);
    return Math.abs(prev - h) >= 0.5;
  };

  // ---- where the viewport is --------------------------------------------

  // The scroll position of whichever element actually scrolls — a custom
  // overflow ancestor if there is one, else the window.
  const readScrollPos = (): number =>
    scroller
      ? scroller.scrollTop
      : (window.scrollY ?? document.documentElement.scrollTop ?? 0);
  /** The viewport's top edge on screen: the scroller's content edge. */
  const viewTop = (): number =>
    scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;

  /** Re-reads how far the viewport's top is below the top of the blocks. */
  const syncRel = (root: HTMLElement): void => {
    const box = vrootOf(root).getBoundingClientRect();
    // Without layout the rects are all zero; the scroll position is the best
    // there is (an editor at the very top of its scroller — tests).
    relTop = box.height > 0 ? viewTop() - box.top : readScrollPos();
    lastScrollPos = readScrollPos();
  };

  const pickAnchor = (): void => {
    anchor = null;
    const order = lastOrder;
    if (!order || order.length === 0) return;
    const edge = viewTop();
    const from = heightIndex.findIndexAtY(Math.max(0, relTop));
    for (let i = from; i < order.length && i < from + 64; i++) {
      const el = mounted(order[i]!);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.top === 0) continue;
      if (r.bottom > edge + 1) {
        anchor = { id: order[i]!, top: r.top - edge };
        return;
      }
    }
  };

  // Puts the first visible block back where it was when something above it
  // changed size. A scroll position someone else moved is taken as it is.
  const holdAnchor = (root: HTMLElement): void => {
    if (readScrollPos() !== lastScrollPos) {
      syncRel(root);
      pickAnchor();
      return;
    }
    const el = anchor ? mounted(anchor.id) : undefined;
    if (!anchor || !el || !el.isConnected) {
      pickAnchor();
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.height === 0 && r.top === 0) {
      pickAnchor();
      return;
    }
    const delta = r.top - viewTop() - anchor.top;
    if (Math.abs(delta) < 1) return;
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);
    syncRel(root);
    // Clamped at an end of the scroller: it sits where it could be put.
    pickAnchor();
  };

  const onScroll = (): void => {
    const root = currentRoot();
    if (!root) return;
    syncRel(root);
    pickAnchor();
    if (needsWindow()) rerender();
  };

  const onResize = () => {
    viewportH = props().viewportHeight ?? readViewportHeight();
    const root = currentRoot();
    if (root) syncRel(root);
    if (needsWindow()) rerender();
  };

  const onResized = (): void => {
    const root = currentRoot();
    if (!root) return;
    measure(root);
    holdAnchor(root);
    if (needsWindow()) rerender();
  };

  /** Whether the viewport, with half a screen to spare each way, has left
   *  what is mounted — the only time a scroll or a measurement re-renders. */
  const needsWindow = (): boolean => {
    const n = heightIndex.size;
    if (n === 0) return false;
    if (rendered.end < rendered.start) return true;
    const slack = viewportH / 2;
    const top = Math.max(0, relTop);
    if (
      rendered.start > 0 &&
      top - slack < heightIndex.prefix(rendered.start)
    ) {
      return true;
    }
    return (
      rendered.end < n - 1 &&
      top + viewportH + slack > heightIndex.prefix(rendered.end + 1)
    );
  };

  // ---- pins ---------------------------------------------------------------

  /** The block of this editor holding the focused element, if it is not the
   *  editor itself (a field or a button in a card). */
  const focusedBlock = (root: HTMLElement): BlockId | null => {
    const active = document.activeElement;
    if (!active || active === root || !root.contains(active)) return null;
    let el: Element | null = active.closest(BLOCK_SELECTOR);
    while (el && !owns(root, el)) {
      el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    }
    return (el?.getAttribute("data-block-id") as BlockId | null) ?? null;
  };

  /** The indices mounted whatever the window (see the header). */
  const pinnedIndices = (): number[] => {
    const order = lastOrder;
    if (!order) return [];
    const out = new Set<number>();
    const add = (id: BlockId | null | undefined): number => {
      const i = id ? idToIndex.get(id) : undefined;
      if (i === undefined || lastHidden.has(order[i]!)) return -1;
      out.add(i);
      return i;
    };
    const root = currentRoot();
    const active = typeof document === "undefined" ? null : document.activeElement;
    // Only while the editor has the focus: an editor nobody is in has no
    // selection on the page to lose, and its model selection (wherever a
    // host left it — the document's end, by default) mounts nothing.
    const focused = !!root && !!active && (active === root || root.contains(active));
    const sel = props().selStore.get();
    const focus = focused
      ? add(sel.kind === "caret" ? sel.at.blockId : sel.focus.blockId)
      : -1;
    if (focused && sel.kind === "range") add(sel.anchor.blockId);
    if (focus >= 0) {
      // The blocks an arrow key reaches from the caret.
      for (let i = focus - 1; i >= 0; i--) {
        if (lastHidden.has(order[i]!)) continue;
        out.add(i);
        break;
      }
      for (let i = focus + 1; i < order.length; i++) {
        if (lastHidden.has(order[i]!)) continue;
        out.add(i);
        break;
      }
    }
    if (root && focused) add(focusedBlock(root));
    if (reveal) add(reveal.id);
    return [...out].sort((a, b) => a - b);
  };

  // The selection set from outside onto a block that is not mounted (a
  // command, an undo, a host's "go to"): mount it, so the page's selection
  // can follow. A caret moved among mounted blocks — every key, every click —
  // finds them all there and renders nothing.
  const onSel = (): void => {
    const order = lastOrder;
    if (!order) return;
    for (const i of pinnedIndices()) {
      if (!mounted(order[i]!)) {
        rerender();
        return;
      }
    }
  };

  // scrollToIndex — used by `editor.scrollToBlock` for blocks that aren't
  // currently mounted. The target is where the index says the block is; once
  // it is mounted (it is pinned until then) it is put exactly in place.
  const scrollToIndex = (
    i: number,
    opts?: { block?: ScrollLogicalPosition; behavior?: ScrollBehavior },
  ): void => {
    const root = currentRoot();
    const order = lastOrder;
    if (!root || !order || i < 0 || i >= order.length) return;
    syncRel(root);
    const where = opts?.block ?? "center";
    const behavior = opts?.behavior ?? "auto";
    const blockTop = heightIndex.prefix(i);
    const blockH = heightIndex.heightAt(i);
    let target = blockTop;
    if (where === "center" || where === "nearest") {
      target = blockTop - Math.max(0, (viewportH - blockH) / 2);
    } else if (where === "end") {
      target = blockTop - Math.max(0, viewportH - blockH);
    }
    // The blocks start `readScrollPos() − relTop` into the scroller.
    const top = Math.max(0, readScrollPos() - relTop + target);
    reveal = { id: order[i]!, block: where, behavior };
    if (scroller) scroller.scrollTo({ top, behavior });
    else window.scrollTo({ top, behavior });
    rerender();
  };

  // After every render: what is mounted, how tall it is, the viewport held
  // where it was, a pending reveal finished.
  const afterRender = (root: HTMLElement): void => {
    const mountsChanged = refreshObservations(root);
    syncIndex();
    measure(root);
    holdAnchor(root);
    if (reveal) {
      const el = mounted(reveal.id);
      if (el) {
        const { block, behavior } = reveal;
        reveal = null;
        el.scrollIntoView({ block, behavior });
        syncRel(root);
        pickAnchor();
      }
    }
    // Scrolling changes which blocks exist in the DOM without changing the
    // document, so this is the only chance the overlay managers — and the
    // page's selection — get to know a block of theirs is (back) there.
    if (mountsChanged) notifyMountedBlocksChanged(root);
    if (needsWindow()) rerender();
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
      scroller = scrollAncestor(root);
      scrollTarget = scroller ?? window;
      scrollTarget.addEventListener("scroll", onScroll, { passive: true } as never);
      window.addEventListener("resize", onResize);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(onResized);
      }
      unsubSel = props().selStore.subscribe(onSel);
      // The focus arriving (a host's `editor.focus()`, Tab): the selection's
      // blocks are pinned from now on.
      root.addEventListener("focusin", onSel);
      // The first render knew nothing of where the editor is: a scroller
      // already scrolled, an editor far down its page.
      syncRel(root);
      afterRender(root);
    },
    onUpdateAfter() {
      const root = currentRoot();
      if (root) afterRender(root);
      else syncIndex();
    },
    dispose() {
      scrollTarget?.removeEventListener("scroll", onScroll);
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
      resizeObserver?.disconnect();
      resizeObserver = null;
      unsubSel?.();
      unsubSel = null;
      const root = currentRoot();
      root?.removeEventListener("focusin", onSel);
      if (root) delete (root as unknown as { __creoVirtual?: unknown }).__creoVirtual;
    },
    render() {
      void tick.get();
      syncIndex();
      const d = doc.get();
      const order = d.order;
      const total = order.length;
      if (total === 0) {
        rendered = { start: 0, end: -1 };
        return;
      }
      const overscan = (props().overscan ?? DEFAULT_OVERSCAN) * viewportH;
      const top = Math.max(0, relTop);
      const fromY = Math.max(0, top - overscan);
      const toY = top + viewportH + overscan;
      const startIdx = heightIndex.findIndexAtY(fromY);
      let endIdx = heightIndex.findIndexAtY(toY);
      if (endIdx < startIdx) endIdx = startIdx;
      rendered = { start: startIdx, end: endIdx };

      // What is drawn, in order, with a spacer wherever blocks are left out.
      const items: Item[] = [];
      let cursor = 0;
      const push = (i: number): void => {
        if (i < cursor || lastHidden.has(order[i]!)) return;
        const gap = heightIndex.prefix(i) - heightIndex.prefix(cursor);
        if (gap > 0.5) {
          items.push(
            cursor === 0
              ? { spacer: gap, key: "top-spacer", cls: "creo-vspacer-top", next: i }
              : { spacer: gap, key: `gap:${order[cursor]}`, cls: "creo-vspacer-gap", next: i },
          );
        }
        items.push({ i });
        cursor = i + 1;
      };
      const pins = pinnedIndices();
      for (const i of pins) if (i < startIdx) push(i);
      for (let i = startIdx; i <= endIdx; i++) push(i);
      for (const i of pins) if (i > endIdx) push(i);
      const tail = heightIndex.total() - heightIndex.prefix(cursor);
      if (tail > 0.5) {
        items.push({ spacer: tail, key: "bottom-spacer", cls: "creo-vspacer-bottom", next: total });
      }

      const li = (i: number): ListItemBlock | null => {
        const b = d.byId.get(order[i]!);
        return b && b.type === "li" ? (b as ListItemBlock) : null;
      };
      /** Whether list items `a` < `b` are of one run of the document's. */
      const sameRun = (a: number, b: number, ordered: boolean): boolean => {
        for (let i = a + 1; i < b; i++) {
          const x = li(i);
          if (!x || x.ordered !== ordered) return false;
        }
        return true;
      };
      /** The first block of the run of list items `i` is in. */
      const runStart = (i: number, ordered: boolean): number => {
        let s = i;
        while (s > 0) {
          const x = li(s - 1);
          if (!x || x.ordered !== ordered) break;
          s--;
        }
        return s;
      };
      const spacerStyle = props().spacerStyle;
      const drawSpacer = (s: { spacer: number; key: string; cls: string; next: number }): void => {
        let extra = "";
        if (spacerStyle) {
          try {
            extra = spacerStyle(d, s.next) ?? "";
          } catch {
            extra = "";
          }
        }
        div({
          class: s.cls,
          key: s.key,
          [VSPACER_ATTR]: "1",
          "aria-hidden": "true",
          // The caret never rests in a spacer, and never crosses one into a
          // block that is not the next one.
          contenteditable: "false",
          style: `height:${s.spacer}px;flex:none;${extra}`,
        });
      };
      const drawBlock = (i: number): void => {
        const id = order[i]!;
        const block = d.byId.get(id)!;
        // Resolve the view via the plugin registry — same dispatch as
        // DocView, so plugin-registered block kinds render identically
        // when virtualized.
        const v = getView(block.type);
        if (!v) return;
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
          return;
        }
        v(selectedStore?.get() === id ? { block, key: id, selected: true } : { block, key: id });
      };

      div(
        {
          class: "creo-vroot",
          style: "position:relative;overflow-anchor:none;",
        },
        () => {
          let k = 0;
          while (k < items.length) {
            const item = items[k]!;
            if (item.spacer !== undefined) {
              drawSpacer(item);
              k++;
              continue;
            }
            const first = li(item.i);
            if (!first) {
              drawBlock(item.i);
              k++;
              continue;
            }
            // A run of list items: one list, as DocView makes one — keyed by
            // the run's first block in the DOCUMENT, so the list (and every
            // item in it) stays the same element while the window moves
            // along it. A spacer between two items of one run is inside it.
            const ordered = first.ordered;
            const members: Item[] = [item];
            let last = item.i;
            let j = k + 1;
            while (j < items.length) {
              const next = items[j]!;
              const after = next.spacer !== undefined ? items[j + 1] : next;
              if (!after || after.spacer !== undefined) break;
              const x = li(after.i);
              if (!x || x.ordered !== ordered || !sameRun(last, after.i, ordered)) break;
              if (next.spacer !== undefined) members.push(next);
              members.push(after);
              last = after.i;
              j = next.spacer !== undefined ? j + 2 : j + 1;
            }
            const key = `list:${ordered ? "o" : "u"}:${order[runStart(item.i, ordered)]}`;
            const drawItems = (): void => {
              for (const m of members) {
                if (m.spacer !== undefined) drawSpacer(m);
                else drawBlock(m.i);
              }
            };
            if (ordered) ol({ class: "ce-list", key }, drawItems);
            else ul({ class: "ce-list", key }, drawItems);
            k = j;
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

/**
 * The editor root this VirtualDoc lives inside.
 *
 * With an `editorId` the lookup is exact. Without one it degrades to "the
 * first editor in the document" — correct for the single-editor page, and the
 * only thing available to a caller that renders VirtualDoc directly.
 */
function rootFor(editorId?: string): HTMLElement | null {
  const sel = editorId
    ? `[data-creo-edit="${editorId.replace(/(["\\])/g, "\\$1")}"]`
    : "[data-creo-edit]";
  return document.querySelector(sel) as HTMLElement | null;
}
