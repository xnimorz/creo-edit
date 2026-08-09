// ---------------------------------------------------------------------------
// DOM ↔ Anchor mapping
//
// Public entry points (`domToAnchor`, `anchorToDom`, `findBlockElementById`)
// are unchanged for callers. Internally, per-kind path encoding and DOM
// walking has moved to per-block AnchorCodec entries registered via the
// plugin system (src/plugin/anchorCodec.ts and src/plugin/builtin.ts).
//
// This file is responsible for finding the outer block element for a given
// hit / id, then delegating the visible-character math to the codec
// registered for that block kind. Text-bearing blocks (p/h*/li) fall through
// to a shared default codec that handles the "[charOffset]" path encoding.
// ---------------------------------------------------------------------------

import type { Anchor, BlockId } from "../model/types";
import type { DomPoint as CodecDomPoint } from "../plugin/types";
import {
  defaultTextCodec,
  findOwningBlockEl,
  lookupAnchorCodec,
} from "../plugin/anchorCodec";

export type BlockKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "li"
  | "code"
  | "img"
  | "table"
  | "columns";

/**
 * Find the OUTER block element with the given block id, scoped under `root`.
 *
 * Required filter: both `data-block-id` and `data-block-kind` — the latter
 * disambiguates the block container from inner cells (table cells / column
 * cells share the owning block's `data-block-id`).
 */
export function findBlockElementById(
  root: HTMLElement,
  blockId: BlockId,
): HTMLElement | null {
  return root.querySelector(
    `[data-block-kind][data-block-id="${cssEscape(blockId)}"]`,
  ) as HTMLElement | null;
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// DOM → Anchor (forward)
// ---------------------------------------------------------------------------

/**
 * Convert a (DOM node, offset) selection point into an editor Anchor.
 *
 * Returns null when the node is outside any block element (e.g. user clicked
 * editor chrome). Coarse but never crashes.
 */
export function domToAnchor(
  node: Node,
  offset: number,
  root: HTMLElement,
): Anchor | null {
  if (!root.contains(node) && node !== root) return null;
  const blockEl = findOwningBlockEl(node);
  if (!blockEl) return null;
  const kind = blockEl.getAttribute("data-block-kind");
  if (!kind) return null;
  // Plugin codec wins; default text-bearing codec is the fallback for any
  // block kind that doesn't register one explicitly.
  const codec = lookupAnchorCodec(kind) ?? defaultTextCodec;
  return codec.domToAnchor(blockEl, node, offset);
}

// ---------------------------------------------------------------------------
// Anchor → DOM (reverse)
// ---------------------------------------------------------------------------

export type DomPoint = { node: Node; offset: number };

/**
 * Convert an editor Anchor into a (DOM node, offset) pair suitable for
 * `Range.setStart` / `Selection.collapse`. Returns null when the block can't
 * be found in the DOM (not yet rendered, virtualized off-screen, etc.).
 */
export function anchorToDom(
  anchor: Anchor,
  root: HTMLElement,
): DomPoint | null {
  const blockEl = findBlockElementById(root, anchor.blockId);
  if (!blockEl) return null;
  const kind = blockEl.getAttribute("data-block-kind");
  if (!kind) return null;
  const codec = lookupAnchorCodec(kind) ?? defaultTextCodec;
  return codec.anchorToDom(blockEl, anchor);
}

/**
 * `anchorToDom` for a whole batch, positionally aligned with `anchors`.
 *
 * Two things it does that N separate calls cannot: the block element is
 * looked up once per distinct block id instead of once per anchor, and a
 * codec that implements `anchorsToDom` gets to answer all of its block's
 * anchors in one pass over its DOM. For a syntax-highlighting host — one
 * block, tens of thousands of anchors, most of them sharing a line — that is
 * the difference between walking a line once per token and once per repaint.
 */
export function anchorsToDom(
  anchors: readonly Anchor[],
  root: HTMLElement,
): (CodecDomPoint | null)[] {
  const out: (CodecDomPoint | null)[] = new Array(anchors.length).fill(null);
  if (anchors.length === 0) return out;
  const byBlock = new Map<BlockId, number[]>();
  for (let i = 0; i < anchors.length; i++) {
    const id = anchors[i]!.blockId;
    const bucket = byBlock.get(id);
    if (bucket) bucket.push(i);
    else byBlock.set(id, [i]);
  }
  for (const [blockId, indices] of byBlock) {
    const blockEl = findBlockElementById(root, blockId);
    if (!blockEl) continue; // block unmounted — leave nulls
    const kind = blockEl.getAttribute("data-block-kind");
    if (!kind) continue;
    const codec = lookupAnchorCodec(kind) ?? defaultTextCodec;
    if (codec.anchorsToDom) {
      const group = indices.map((i) => anchors[i]!);
      const points = codec.anchorsToDom(blockEl, group);
      for (let k = 0; k < indices.length; k++) out[indices[k]!] = points[k] ?? null;
      continue;
    }
    for (const i of indices) out[i] = codec.anchorToDom(blockEl, anchors[i]!);
  }
  return out;
}
