// ---------------------------------------------------------------------------
// Self-virtualized block registry.
//
// `VirtualDoc` windows over BLOCKS. A 5,000-line file is one `code` block, so
// block-level windowing does nothing for it: all 5,000 lines mount, and the
// 32px default estimate is wrong by two orders of magnitude, which also
// corrupts the scrollbar geometry for everything below it.
//
// Rather than generalise HeightIndex into a two-level tree — which would make
// every block pay for a case only a few block kinds have — a block can declare
// that it manages its own internal windowing. VirtualDoc then:
//
//   - stops measuring it with ResizeObserver (the block's own sizing would
//     fight the observer),
//   - trusts `measureHeight` for the outer index, INCLUDING while the block is
//     scrolled out of view, so the scrollbar is right from the first frame,
//   - passes the visible region down to the view as `viewport`, in the block's
//     own coordinate space.
//
// Registered module-globally alongside the other block-level codecs
// (runsAt / anchorCodec / htmlCodec / serializeCodec): the mapping is a
// property of the block kind, not of one editor instance.
//
// NOTE for block authors: an anchor codec that walks mounted sub-elements
// (the way `codeBlockCodec` walks `.ce-code-line`) will compute wrong offsets
// once some of those elements stop mounting. A self-virtualized block must
// ship a codec that accounts for its own spacers. The built-in code block
// therefore does NOT opt in.
// ---------------------------------------------------------------------------

import type { Block } from "../model/types";

/** Visible region of a block, in px from the block's own top. */
export type BlockViewport = {
  top: number;
  bottom: number;
};

/** Font metrics handed to `measureHeight` so uniform-row blocks can compute
 *  rather than measure. Read from the mounted element when there is one. */
export type BlockMetrics = {
  lineHeight: number;
};

export type SelfVirtualizedDef<B extends Block = Block> = {
  /**
   * Total rendered height in px. Called when the block changes, not per
   * frame — a code block returns `lineCount * lineHeight`.
   */
  measureHeight(block: B, metrics: BlockMetrics): number;
};

const byType = new Map<string, SelfVirtualizedDef>();

export function registerSelfVirtualized(
  type: string,
  def: SelfVirtualizedDef,
): void {
  byType.set(type, def);
}

export function getSelfVirtualized(
  type: string,
): SelfVirtualizedDef | null {
  return byType.get(type) ?? null;
}

export function isSelfVirtualized(type: string): boolean {
  return byType.has(type);
}
