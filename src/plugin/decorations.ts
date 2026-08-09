// ---------------------------------------------------------------------------
// Decoration manager — overlay UI per block, mounted in a sibling layer so
// hover/focus/drag state can change without dirtying block subscribers.
//
// The manager owns ONE absolute-positioned <div.ce-decorations> sibling of
// the editor root. For each block currently in the doc that matches a
// registered DecorationDef, it instantiates the decoration's `view` once
// and re-positions it via getBoundingClientRect on:
//   - doc changes (block reordered / inserted / removed)
//   - scroll / resize on the editor's nearest scroll ancestor
//   - hover changes (decorations that opt into a `hovered` highlight)
//
// Decorations are NOT subscribed to per-block doc state. If a decoration
// needs the block's content (badges, counts), it reads it lazily inside
// onPointer events, NOT on every doc change.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { Block, BlockId, DocState } from "../model/types";
import type { DecorationDef } from "./types";
import { onMountedBlocksChanged } from "../dom/mountSignal";
import { scrollSourceFor } from "../dom/scroll";
import type { Registry } from "./registry";

export type DecorationManagerOptions = {
  registry: Registry;
  docStore: Store<DocState>;
  /** Editor root (the contentEditable div). The decoration layer mounts as
   *  a sibling, positioned to overlay the same screen rect. */
  editorRoot: HTMLElement;
};

type Mounted = {
  def: DecorationDef;
  blockId: BlockId;
  /** Index within the def's `targets()` list; 0 when `targets` is omitted. */
  targetIndex: number;
  el: HTMLElement;
  cleanup: (() => void) | void;
};

/** Minimal rect shape — `uniformTargets` synthesizes these arithmetically
 *  rather than calling getBoundingClientRect per target. */
type Rect = { top: number; left: number; width: number; height: number };

const DEFAULT_SLOT = 24;

export class DecorationManager {
  private layer: HTMLElement;
  private mounted = new Map<string, Mounted>();
  private rafQueued = false;
  private rafSyncRequested = false;
  private unsub: (() => void) | null = null;
  private unsubMounts: (() => void) | null = null;
  private scrollSource: HTMLElement | Window;
  private resizeObserver: ResizeObserver | null = null;
  /** Hovered block id — surfaced to decorations via dataset on the layer
   *  so they can style themselves with sibling CSS or read it directly. */
  private hoveredBlockId: BlockId | null = null;
  /** Decoration id → registration index, used to order stacked decorations.
   *  Fixed after install, so computed once rather than per position() frame. */
  private orderById: Map<string, number>;

  constructor(private opts: DecorationManagerOptions) {
    this.orderById = new Map(
      opts.registry.decorations.map((d, i) => [d.id, i]),
    );
    const layer = document.createElement("div");
    layer.className = "ce-decorations";
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      zIndex: "5",
    } as Partial<CSSStyleDeclaration>);
    // Insert into the same positioned ancestor as the editor root.
    const parent = opts.editorRoot.parentElement ?? opts.editorRoot;
    parent.appendChild(layer);
    this.layer = layer;

    // Pointer tracking for hover.
    opts.editorRoot.addEventListener("pointermove", this.onPointerMove);
    opts.editorRoot.addEventListener("pointerleave", this.onPointerLeave);

    // Doc subscription — re-render when blocks come/go/reorder.
    this.unsub = opts.docStore.subscribe(() => this.scheduleSync());
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.schedulePosition());
      this.resizeObserver.observe(opts.editorRoot);
    }
    // The editor's own scroll container, not `window` — decorations are
    // positioned from viewport rects, so they have to re-place when the text
    // moves under them, and `scroll` doesn't bubble out of an `overflow: auto`
    // pane. See dom/scroll.ts.
    this.scrollSource = scrollSourceFor(opts.editorRoot);
    this.scrollSource.addEventListener("scroll", this.schedulePosition, {
      passive: true,
    } as never);
    window.addEventListener("resize", this.schedulePosition);
    // Blocks mounting / unmounting under virtualization changes which blocks
    // want decorations at all.
    this.unsubMounts = onMountedBlocksChanged((root) => {
      if (root === opts.editorRoot || opts.editorRoot.contains(root)) {
        this.scheduleSync();
      }
    });

    // Initial sync.
    this.sync();
  }

  destroy(): void {
    this.unsub?.();
    this.unsubMounts?.();
    this.unsubMounts = null;
    this.opts.editorRoot.removeEventListener("pointermove", this.onPointerMove);
    this.opts.editorRoot.removeEventListener("pointerleave", this.onPointerLeave);
    this.scrollSource.removeEventListener("scroll", this.schedulePosition);
    window.removeEventListener("resize", this.schedulePosition);
    this.resizeObserver?.disconnect();
    for (const m of this.mounted.values()) {
      try { m.cleanup?.(); } catch {}
      m.el.remove();
    }
    this.mounted.clear();
    this.layer.remove();
  }

  /** Currently hovered block id (or null). Decorations read this via
   *  `manager.hoveredBlock()` to decide their own visibility. */
  hoveredBlock(): BlockId | null {
    return this.hoveredBlockId;
  }

  // -------------------------------------------------------------------------
  // Sync — reconcile mounted vs. desired set.
  // -------------------------------------------------------------------------

  // Scheduling: a single queued frame coalesces both `position` and `sync`
  // requests. `rafSyncRequested` upgrades the queued frame from a plain
  // reposition to a full sync (mount/unmount + reposition). Without this
  // upgrade a `schedulePosition` from a scroll/resize landing right before a
  // doc change would consume the frame, dropping the doc change's sync.
  private scheduleSync = (): void => {
    this.rafSyncRequested = true;
    if (this.rafQueued) return;
    this.rafQueued = true;
    this.queueFlush();
  };

  private schedulePosition = (): void => {
    if (this.rafQueued) return;
    this.rafQueued = true;
    this.queueFlush();
  };

  private queueFlush(): void {
    const cb = () => {
      this.rafQueued = false;
      const wantSync = this.rafSyncRequested;
      this.rafSyncRequested = false;
      if (wantSync) this.sync();
      else this.position();
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(cb);
    } else {
      queueMicrotask(cb);
    }
  }

  /**
   * Resolve a def's anchor elements inside a block. `targets` omitted means
   * "the block element", i.e. exactly the pre-sub-block behaviour. A throwing
   * or empty `targets()` yields no decorations rather than taking the layer
   * down.
   */
  private resolveTargets(
    def: DecorationDef,
    block: Block,
    blockEl: HTMLElement,
  ): HTMLElement[] {
    if (!def.targets) return [blockEl];
    try {
      return def.targets(block, blockEl) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * BlockId → mounted block element, in document order, from ONE query.
   *
   * A decoration can only exist against a block that is in the DOM, so the
   * mounted set — not `doc.order` — is the right thing to iterate. Walking
   * the document instead meant a `querySelector` per block to discover that
   * almost all of them are windowed out: at 50 000 blocks that was ~1.2s per
   * sync, and `sync` runs on every doc change, so every keystroke.
   */
  private mountedBlockEls(): Map<BlockId, HTMLElement> {
    const out = new Map<BlockId, HTMLElement>();
    const els = this.opts.editorRoot.querySelectorAll<HTMLElement>(
      "[data-block-kind][data-block-id]",
    );
    for (let i = 0; i < els.length; i++) {
      const el = els[i]!;
      const id = el.getAttribute("data-block-id") as BlockId | null;
      if (id && !out.has(id)) out.set(id, el);
    }
    return out;
  }

  private sync(): void {
    const doc = this.opts.docStore.get();
    const els = this.mountedBlockEls();
    const wantKeys = new Set<string>();
    for (const [id, blockEl] of els) {
      // A block element can outlive its model entry for a frame while the
      // renderer catches up; it gets no decorations until it agrees.
      const block = doc.byId.get(id);
      if (!block) continue;
      for (const def of this.opts.registry.decorations) {
        if (!def.match(block)) continue;
        const targets = this.resolveTargets(def, block, blockEl);
        for (let i = 0; i < targets.length; i++) {
          const key = `${def.id}:${id}:${i}`;
          wantKeys.add(key);
          if (!this.mounted.has(key)) {
            this.mountDecoration(def, block, targets[i]!, i, key);
          }
        }
      }
    }
    // Unmount decorations whose block — or whose target — is gone. A code
    // block losing a line drops that line's gutter entry here.
    for (const [key, m] of this.mounted) {
      if (!wantKeys.has(key)) {
        try { m.cleanup?.(); } catch {}
        m.el.remove();
        this.mounted.delete(key);
      }
    }
    this.position(els);
  }

  private mountDecoration(
    def: DecorationDef,
    block: Block,
    target: HTMLElement,
    index: number,
    key: string,
  ): void {
    const el = document.createElement("div");
    el.className = `ce-deco ce-deco-${def.id} ce-deco-layer-${def.layer}`;
    el.dataset.blockId = block.id;
    if (def.targets) el.dataset.targetIndex = String(index);
    Object.assign(el.style, {
      position: "absolute",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    let cleanup: (() => void) | void = undefined;
    try {
      cleanup = def.mount(block, target, el, this, index) ?? undefined;
    } catch {
      // Plugin error — drop without taking down the layer.
    }
    this.layer.appendChild(el);
    this.mounted.set(key, {
      def,
      blockId: block.id,
      targetIndex: index,
      el,
      cleanup,
    });
  }

  // -------------------------------------------------------------------------
  // Position — set absolute coords from each block's bounding rect.
  // -------------------------------------------------------------------------

  /** `els` is the mounted-block map when the caller already built one
   *  (`sync`); the scroll/resize path builds its own. */
  private position(els?: Map<BlockId, HTMLElement>): void {
    const layerRect = this.layer.getBoundingClientRect();
    const doc = this.opts.docStore.get();

    // Per-frame memos. `targets()` is called at most once per (def, block)
    // per frame, and with `uniformTargets` we take exactly one layout read
    // per (def, block) no matter how many targets there are.
    const blockEls = els ?? this.mountedBlockEls();
    const targetCache = new Map<string, HTMLElement[]>();
    const firstRectCache = new Map<string, Rect | null>();

    const blockElFor = (id: BlockId): HTMLElement | null =>
      blockEls.get(id) ?? null;

    const targetsFor = (def: DecorationDef, id: BlockId): HTMLElement[] => {
      const key = `${def.id}::${id}`;
      let t = targetCache.get(key);
      if (t) return t;
      const blockEl = blockElFor(id);
      const block = doc.byId.get(id);
      t = blockEl && block ? this.resolveTargets(def, block, blockEl) : [];
      targetCache.set(key, t);
      return t;
    };

    const rectFor = (
      def: DecorationDef,
      id: BlockId,
      index: number,
    ): Rect | null => {
      const targets = targetsFor(def, id);
      if (def.uniformTargets) {
        if (index >= targets.length) return null;
        const key = `${def.id}::${id}`;
        let first = firstRectCache.get(key);
        if (first === undefined) {
          const el0 = targets[0];
          first = el0 ? toRect(el0.getBoundingClientRect()) : null;
          firstRectCache.set(key, first);
        }
        if (!first) return null;
        if (index === 0) return first;
        return { ...first, top: first.top + index * first.height };
      }
      const el = targets[index];
      return el ? toRect(el.getBoundingClientRect()) : null;
    };

    // Group mounted decorations by (blockId, layer, targetIndex) so we can
    // stack multiple decorations against the same anchor side-by-side
    // instead of overlapping. Order within a group follows the plugin
    // registration order (this.orderById, computed once at install).
    const orderById = this.orderById;
    type Group = { blockId: BlockId; targetIndex: number; items: Mounted[] };
    const groups = new Map<string, Group>();
    for (const m of this.mounted.values()) {
      const key = `${m.blockId}::${m.def.layer}::${m.targetIndex}`;
      let g = groups.get(key);
      if (!g) {
        g = { blockId: m.blockId, targetIndex: m.targetIndex, items: [] };
        groups.set(key, g);
      }
      g.items.push(m);
    }
    for (const g of groups.values()) {
      g.items.sort(
        (a, b) =>
          (orderById.get(a.def.id) ?? 0) - (orderById.get(b.def.id) ?? 0),
      );
      // Each item in a group can have its own target list (different defs),
      // but they share (block, layer, index) so their rects coincide in the
      // common case. Resolve per item so a def with fewer targets simply
      // hides instead of borrowing another def's geometry.
      for (let i = 0; i < g.items.length; i++) {
        const m = g.items[i]!;
        const r = rectFor(m.def, g.blockId, g.targetIndex);
        if (!r) {
          m.el.style.display = "none";
          continue;
        }
        m.el.style.display = "";
        const slot = layerSlotForLayer(m.def.layer, r, i, m.def.slotWidth);
        m.el.style.top = `${r.top - layerRect.top}px`;
        m.el.style.left = `${r.left - layerRect.left + slot.left}px`;
        m.el.style.width = `${slot.width ?? r.width}px`;
        m.el.style.height = `${r.height}px`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Hover tracking
  // -------------------------------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    const blockEl = (e.target as HTMLElement | null)?.closest?.(
      "[data-block-kind]",
    ) as HTMLElement | null;
    const id = blockEl?.getAttribute("data-block-id") ?? null;
    if (id !== this.hoveredBlockId) {
      this.hoveredBlockId = id;
      // Surface as a dataset on each mounted decoration so CSS can style.
      for (const m of this.mounted.values()) {
        if (m.blockId === id) m.el.classList.add("is-hovered");
        else m.el.classList.remove("is-hovered");
      }
    }
  };

  private onPointerLeave = (): void => {
    if (this.hoveredBlockId !== null) {
      this.hoveredBlockId = null;
      for (const m of this.mounted.values()) m.el.classList.remove("is-hovered");
    }
  };
}

function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function layerSlotForLayer(
  layer: DecorationDef["layer"],
  blockRect: Rect,
  index: number,
  slotWidth?: number,
): { left: number; width?: number } {
  // Slot width matches the gutter "cell" reserved per-decoration so multiple
  // decorations in the same layer don't overlap. Layout: slots stack
  // outward from the block — slot 0 nearest, slot 1 further out, ...
  const SLOT = slotWidth ?? DEFAULT_SLOT;
  switch (layer) {
    case "left":
      // Closest slot at left = -SLOT (right against the block), then -2*SLOT,
      // -3*SLOT, … going further into the gutter.
      return { left: -SLOT * (index + 1), width: SLOT };
    case "right":
      return { left: blockRect.width + SLOT * index, width: SLOT };
    default:
      return { left: 0 };
  }
}

