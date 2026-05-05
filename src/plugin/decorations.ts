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
import { findBlockElementById } from "../dom/anchorMap";
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
  el: HTMLElement;
  cleanup: (() => void) | void;
};

export class DecorationManager {
  private layer: HTMLElement;
  private mounted = new Map<string, Mounted>();
  private rafQueued = false;
  private unsub: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Hovered block id — surfaced to decorations via dataset on the layer
   *  so they can style themselves with sibling CSS or read it directly. */
  private hoveredBlockId: BlockId | null = null;

  constructor(private opts: DecorationManagerOptions) {
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
    window.addEventListener("scroll", this.schedulePosition, { passive: true });
    window.addEventListener("resize", this.schedulePosition);

    // Initial sync.
    this.sync();
  }

  destroy(): void {
    this.unsub?.();
    this.opts.editorRoot.removeEventListener("pointermove", this.onPointerMove);
    this.opts.editorRoot.removeEventListener("pointerleave", this.onPointerLeave);
    window.removeEventListener("scroll", this.schedulePosition);
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

  private scheduleSync = (): void => {
    if (this.rafQueued) return;
    this.rafQueued = true;
    const cb = () => {
      this.rafQueued = false;
      this.sync();
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(cb);
    } else {
      queueMicrotask(cb);
    }
  };

  private schedulePosition = (): void => {
    if (this.rafQueued) return;
    this.rafQueued = true;
    const cb = () => {
      this.rafQueued = false;
      this.position();
    };
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(cb);
    } else {
      queueMicrotask(cb);
    }
  };

  private sync(): void {
    const doc = this.opts.docStore.get();
    const wantKeys = new Set<string>();
    for (const id of doc.order) {
      const block = doc.byId.get(id)!;
      for (const def of this.opts.registry.decorations) {
        if (!def.match(block)) continue;
        const key = `${def.id}:${id}`;
        wantKeys.add(key);
        if (!this.mounted.has(key)) {
          this.mountDecoration(def, block);
        }
      }
    }
    // Unmount decorations whose blocks are gone.
    for (const [key, m] of this.mounted) {
      if (!wantKeys.has(key)) {
        try { m.cleanup?.(); } catch {}
        m.el.remove();
        this.mounted.delete(key);
      }
    }
    this.position();
  }

  private mountDecoration(def: DecorationDef, block: Block): void {
    const blockEl = findBlockElementById(this.opts.editorRoot, block.id);
    if (!blockEl) return;
    const el = document.createElement("div");
    el.className = `ce-deco ce-deco-${def.id} ce-deco-layer-${def.layer}`;
    el.dataset.blockId = block.id;
    Object.assign(el.style, {
      position: "absolute",
      pointerEvents: "auto",
    } as Partial<CSSStyleDeclaration>);
    let cleanup: (() => void) | void = undefined;
    try {
      cleanup = def.mount(block, blockEl, el, this) ?? undefined;
    } catch {
      // Plugin error — drop without taking down the layer.
    }
    this.layer.appendChild(el);
    this.mounted.set(`${def.id}:${block.id}`, { def, blockId: block.id, el, cleanup });
  }

  // -------------------------------------------------------------------------
  // Position — set absolute coords from each block's bounding rect.
  // -------------------------------------------------------------------------

  private position(): void {
    const layerRect = this.layer.getBoundingClientRect();
    // Group mounted decorations by (blockId, layer) so we can stack
    // multiple decorations in the same layer side-by-side instead of
    // overlapping. Order within a (blockId, layer) group follows the
    // plugin registration order via this.opts.registry.decorations.
    const orderById = new Map<string, number>();
    this.opts.registry.decorations.forEach((d, i) => orderById.set(d.id, i));
    type Group = { blockId: string; layer: string; items: Mounted[] };
    const groups = new Map<string, Group>();
    for (const m of this.mounted.values()) {
      const key = `${m.blockId}::${m.def.layer}`;
      let g = groups.get(key);
      if (!g) {
        g = { blockId: m.blockId, layer: m.def.layer, items: [] };
        groups.set(key, g);
      }
      g.items.push(m);
    }
    for (const g of groups.values()) {
      g.items.sort(
        (a, b) =>
          (orderById.get(a.def.id) ?? 0) - (orderById.get(b.def.id) ?? 0),
      );
    }
    for (const g of groups.values()) {
      const blockEl = findBlockElementById(this.opts.editorRoot, g.blockId);
      if (!blockEl) {
        for (const m of g.items) m.el.style.display = "none";
        continue;
      }
      const r = blockEl.getBoundingClientRect();
      for (let i = 0; i < g.items.length; i++) {
        const m = g.items[i]!;
        m.el.style.display = "";
        const slot = layerSlotForLayer(m.def.layer, r, i, g.items.length);
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

function layerSlotForLayer(
  layer: DecorationDef["layer"],
  blockRect: DOMRect,
  index: number,
  _total: number,
): { left: number; width?: number } {
  // Slot width matches the gutter "cell" reserved per-decoration so multiple
  // decorations in the same layer don't overlap. Layout: slots stack
  // outward from the block — slot 0 nearest, slot 1 further out, ...
  const SLOT = 24;
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

