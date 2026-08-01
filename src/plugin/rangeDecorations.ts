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
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { AnchorRange, BlockId, DocState } from "../model/types";
import { anchorToDom } from "../dom/anchorMap";
import {
  deleteHighlight,
  isHighlightApiSupported,
  setHighlight,
} from "../dom/highlights";
import type { DecorationViewport, RangeDecorationDef } from "./types";
import type { Registry } from "./registry";

export type RangeDecorationManagerOptions = {
  registry: Registry;
  docStore: Store<DocState>;
  /** Editor root (the contentEditable div). Ranges are resolved against it. */
  editorRoot: HTMLElement;
};

export class RangeDecorationManager {
  private unsub: (() => void) | null = null;
  private mutationObserver: MutationObserver | null = null;
  private rafQueued = false;
  /** Highlight names we've registered, so destroy() cleans up after itself. */
  private painted = new Set<string>();

  constructor(private opts: RangeDecorationManagerOptions) {
    this.unsub = opts.docStore.subscribe(() => this.schedule());
    window.addEventListener("scroll", this.schedule, { passive: true });
    window.addEventListener("resize", this.schedule);
    // Blocks mounting / unmounting under virtualization changes which ranges
    // can be resolved to DOM. We only write to CSS.highlights, never to the
    // DOM, so observing our own output can't loop.
    if (typeof MutationObserver !== "undefined") {
      this.mutationObserver = new MutationObserver(() => this.schedule());
      this.mutationObserver.observe(opts.editorRoot, {
        childList: true,
        subtree: true,
      });
    }
    this.refresh();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener("scroll", this.schedule);
    window.removeEventListener("resize", this.schedule);
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    for (const name of this.painted) deleteHighlight(name);
    this.painted.clear();
  }

  /** Whether this environment can paint at all. Surfaced on the editor as
   *  `supportsRangeDecorations()` so hosts degrade knowingly. */
  static isSupported(): boolean {
    return isHighlightApiSupported();
  }

  private schedule = (): void => {
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
    for (const def of ordered) this.paint(def, doc, viewport);
  }

  /** First / last block currently in the DOM. Sources use it to bound the
   *  work they do on a large document. */
  private mountedViewport(): DecorationViewport | null {
    const els = this.opts.editorRoot.querySelectorAll<HTMLElement>(
      "[data-block-kind][data-block-id]",
    );
    if (els.length === 0) return null;
    const first = els[0]!.getAttribute("data-block-id");
    const last = els[els.length - 1]!.getAttribute("data-block-id");
    if (!first || !last) return null;
    return { firstBlock: first as BlockId, lastBlock: last as BlockId };
  }

  private paint(
    def: RangeDecorationDef,
    doc: DocState,
    viewport: DecorationViewport | null,
  ): void {
    let requested: AnchorRange[];
    try {
      requested = def.ranges(doc, viewport) ?? [];
    } catch {
      // A throwing source clears its own highlight rather than taking the
      // rest of them down with it.
      requested = [];
    }
    const ranges: Range[] = [];
    for (const r of requested) {
      const dom = this.toDomRange(r);
      if (dom) ranges.push(dom);
    }
    // Always set — even empty — so a previous paint under this name clears.
    setHighlight(def.className, ranges, def.priority ?? 0);
    this.painted.add(def.className);
  }

  private toDomRange(r: AnchorRange): Range | null {
    const root = this.opts.editorRoot;
    const a = anchorToDom(r.from, root);
    const b = anchorToDom(r.to, root);
    // Either endpoint unmounted (virtualized off-screen) — skip; the
    // MutationObserver repaints when the block arrives.
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
}

function sameDomPoint(
  a: { node: Node; offset: number },
  b: { node: Node; offset: number },
): boolean {
  return a.node === b.node && a.offset === b.offset;
}
