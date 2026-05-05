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
