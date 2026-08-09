// ---------------------------------------------------------------------------
// Range-decoration manager — paints plugin-supplied anchor ranges through the
// CSS Custom Highlight API.
//
// Why highlights rather than DOM: comment ranges, LSP diagnostic squiggles,
// word-level diff and selection highlights all overlap each other AND overlap
// whatever run structure the model already has. Expressing them as elements
// would mean splitting spans, and every split is a new node for the anchor
// map's character walk to account for. `CSS.highlights` paints over the
// existing DOM and changes nothing about it.
//
// Recompute triggers, all coalesced into one rAF:
//   - doc changes            (ranges may have moved)
//   - scroll / resize        (viewport-scoped sources return different ranges)
//   - block mount / unmount  (virtualization; a range's DOM appears or goes)
//
// Scroll is listened for on the editor's own scroll container, not on
// `window` — see dom/scroll.ts for why listening on window is wrong in both
// directions. Mount changes arrive as an explicit signal from the renderer
// rather than a subtree MutationObserver, which used to fire (and repaint) on
// every keystroke — see dom/mountSignal.ts.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { Anchor, AnchorRange, BlockId, DocState } from "../model/types";
import { anchorsToDom } from "../dom/anchorMap";
import {
  deleteHighlight,
  isHighlightApiSupported,
  setHighlight,
} from "../dom/highlights";
import { onMountedBlocksChanged } from "../dom/mountSignal";
import { scrollAncestor, scrollSourceFor } from "../dom/scroll";
import { declaredLineStart } from "./anchorCodec";
import type { DecorationViewport, DomPoint } from "./types";
import type { Registry } from "./registry";

export type RangeDecorationManagerOptions = {
  registry: Registry;
  docStore: Store<DocState>;
  /** Editor root (the contentEditable div). Ranges are resolved against it. */
  editorRoot: HTMLElement;
};

export class RangeDecorationManager {
  private unsub: (() => void) | null = null;
  private unsubMounts: (() => void) | null = null;
  private scrollSource: HTMLElement | Window;
  private rafQueued = false;
  /** Highlight names we've registered, so destroy() cleans up after itself. */
  private painted = new Set<string>();

  constructor(private opts: RangeDecorationManagerOptions) {
    this.unsub = opts.docStore.subscribe(() => this.schedule());
    this.scrollSource = scrollSourceFor(opts.editorRoot);
    this.scrollSource.addEventListener("scroll", this.schedule, {
      passive: true,
    } as never);
    window.addEventListener("resize", this.schedule);
    // Blocks mounting / unmounting under virtualization changes which ranges
    // can be resolved to DOM.
    this.unsubMounts = onMountedBlocksChanged((root) => {
      if (root === opts.editorRoot || opts.editorRoot.contains(root)) {
        this.schedule();
      }
    });
    this.refresh();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.unsubMounts?.();
    this.unsubMounts = null;
    this.scrollSource.removeEventListener("scroll", this.schedule);
    window.removeEventListener("resize", this.schedule);
    for (const name of this.painted) deleteHighlight(name);
    this.painted.clear();
  }

  /** Whether this environment can paint at all. Surfaced on the editor as
   *  `supportsRangeDecorations()` so hosts degrade knowingly. */
  static isSupported(): boolean {
    return isHighlightApiSupported();
  }

  /** Queue a repaint on the next frame, collapsing every other request made
   *  in the same frame into it. This is what the public
   *  `editor.refreshRangeDecorations()` calls. */
  schedule = (): void => {
    if (this.rafQueued) return;
    this.rafQueued = true;
    const cb = () => {
      this.rafQueued = false;
      this.refresh();
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(cb);
    else queueMicrotask(cb);
  };

  /** Recompute and repaint every registered range decoration. Public so hosts
   *  can force a repaint after mutating state the sources read. */
  refresh(): void {
    const defs = this.opts.registry.rangeDecorations;
    if (defs.length === 0) return;
    if (!isHighlightApiSupported()) return;
    const doc = this.opts.docStore.get();
    const viewport = this.mountedViewport();
    // Lowest priority first so equal-priority defs resolve by registration
    // order the way stacked decorations do.
    const ordered = [...defs].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
    );

    // Ask every source first, then resolve every endpoint of every source in
    // ONE batch.
    //
    // Resolving per decoration is what makes the repaint scale with how many
    // decorations a host registers rather than with how much text it covers:
    // a tokenizer bucketing into 64 highlight names hands each one a thin
    // scatter of ranges over the whole file, so nothing groups by line and
    // every endpoint pays a full lookup. Pooled, the same endpoints arrive
    // dense — the code-block codec walks each line once for all 64 of them.
    const requested: AnchorRange[][] = ordered.map((def) => {
      try {
        return def.ranges(doc, viewport) ?? [];
      } catch {
        // A throwing source clears its own highlight rather than taking the
        // rest of them down with it.
        return [];
      }
    });
    // Endpoints interleaved from/to/from/to, so a decoration's slice of the
    // result indexes back trivially.
    let total = 0;
    for (const rs of requested) total += rs.length * 2;
    const anchors: Anchor[] = new Array(total);
    let w = 0;
    for (const rs of requested) {
      for (const r of rs) {
        anchors[w++] = r.from;
        anchors[w++] = r.to;
      }
    }
    const points = anchorsToDom(anchors, this.opts.editorRoot);

    let read = 0;
    for (let d = 0; d < ordered.length; d++) {
      const def = ordered[d]!;
      const rs = requested[d]!;
      const ranges: Range[] = [];
      for (let i = 0; i < rs.length; i++) {
        const dom = toDomRange(points[read] ?? null, points[read + 1] ?? null);
        read += 2;
        if (dom) ranges.push(dom);
      }
      // Always set — even empty — so a previous paint under this name clears.
      setHighlight(def.className, ranges, def.priority ?? 0);
      this.painted.add(def.className);
    }
  }

  /** First / last block currently in the DOM, plus the per-block character
   *  window when the block renders measurable sub-items. Sources use it to
   *  bound the work they do on a large document. */
  private mountedViewport(): DecorationViewport | null {
    const els = this.opts.editorRoot.querySelectorAll<HTMLElement>(
      "[data-block-kind][data-block-id]",
    );
    if (els.length === 0) return null;
    const first = els[0]!.getAttribute("data-block-id");
    const last = els[els.length - 1]!.getAttribute("data-block-id");
    if (!first || !last) return null;
    // Memoized for the life of one refresh: several decorations ask about the
    // same block, and the answer costs two layout reads.
    const cache = new Map<BlockId, { from: number; to: number } | null>();
    const byId = new Map<BlockId, HTMLElement>();
    for (let i = 0; i < els.length; i++) {
      const id = els[i]!.getAttribute("data-block-id") as BlockId | null;
      if (id && !byId.has(id)) byId.set(id, els[i]!);
    }
    return {
      firstBlock: first as BlockId,
      lastBlock: last as BlockId,
      windowIn: (block: BlockId) => {
        if (cache.has(block)) return cache.get(block)!;
        const el = byId.get(block) ?? null;
        const win = el ? visibleCharWindow(el, this.opts.editorRoot) : null;
        cache.set(block, win);
        return win;
      },
    };
  }

}

function toDomRange(a: DomPoint | null, b: DomPoint | null): Range | null {
  // Either endpoint unmounted (virtualized off-screen) — skip; the mount
  // signal repaints when the block arrives.
  if (!a || !b) return null;
  try {
    const range = new Range();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    // A backwards range throws on setEnd in some engines and silently
    // collapses in others; drop it either way rather than painting garbage.
    if (range.collapsed && !sameDomPoint(a, b)) return null;
    return range;
  } catch {
    return null;
  }
}

/**
 * Half-open `[from, to)` character window of `blockEl` that is currently on
 * screen, or null when the block isn't measurable this way.
 *
 * "Measurable" means every child is a line carrying `data-line-start` — i.e.
 * the built-in code block, whose lines are uniform-height and contiguous, so
 * the visible slice follows from one rect read and arithmetic rather than a
 * per-line `getBoundingClientRect`. Any other block (and any environment
 * without layout, such as a happy-dom test) answers null, which the contract
 * defines as "no window — return everything".
 */
function visibleCharWindow(
  blockEl: HTMLElement,
  editorRoot: HTMLElement,
): { from: number; to: number } | null {
  const kids = blockEl.children;
  const n = kids.length;
  if (n === 0) return null;
  if (declaredLineStart(kids[0]) === null) return null;
  if (declaredLineStart(kids[n - 1]) === null) return null;

  let rect: DOMRect;
  try {
    rect = blockEl.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!(rect.height > 0)) return null;
  const lineH = rect.height / n;
  if (!(lineH > 0)) return null;

  const { top: vTop, bottom: vBottom } = viewportBounds(editorRoot);
  if (!(vBottom > vTop)) return null;
  // One viewport of slack each way, so scrolling doesn't expose unpainted
  // text before the next repaint lands.
  const slack = vBottom - vTop;
  const firstLine = clamp(
    Math.floor((vTop - slack - rect.top) / lineH),
    0,
    n - 1,
  );
  const lastLine = clamp(
    Math.floor((vBottom + slack - rect.top) / lineH),
    0,
    n - 1,
  );
  const from = declaredLineStart(kids[firstLine]) ?? 0;
  // Exclusive end = the start of the line after the last visible one; when
  // that's the end of the block there is nothing beyond it to exclude.
  const after = declaredLineStart(kids[lastLine + 1]);
  return { from, to: after ?? Number.MAX_SAFE_INTEGER };
}

function viewportBounds(editorRoot: HTMLElement): { top: number; bottom: number } {
  const sc = scrollAncestor(editorRoot);
  if (sc) {
    try {
      const r = sc.getBoundingClientRect();
      return { top: r.top, bottom: r.top + sc.clientHeight };
    } catch {
      return { top: 0, bottom: 0 };
    }
  }
  return { top: 0, bottom: window.innerHeight ?? 0 };
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function sameDomPoint(
  a: { node: Node; offset: number },
  b: { node: Node; offset: number },
): boolean {
  return a.node === b.node && a.offset === b.offset;
}
