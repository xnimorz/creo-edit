// ---------------------------------------------------------------------------
// Table column alignment. Stored on the block as `align?: TableAlign[]`, one
// entry per column, and absent when no column says — so a table that never
// had alignment set serializes exactly as it did before alignment existed.
// ---------------------------------------------------------------------------

import type { TableAlign, TableBlock } from "../../model/types";

const ALIGNS: ReadonlySet<string> = new Set(["left", "center", "right"]);

/** A column's alignment; `null` past the end of a short (or absent) array. */
export function tableAlignAt(block: Pick<TableBlock, "align">, col: number): TableAlign {
  return block.align?.[col] ?? null;
}

/** Reads one alignment from untrusted input (JSON, HTML); anything else is `null`. */
export function toTableAlign(value: unknown): TableAlign {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return ALIGNS.has(v) ? (v as TableAlign) : null;
}

/**
 * The array to store for `cols` columns: padded or cut to the width, and
 * `undefined` when every column is `null` — so "no alignment" has one shape.
 */
export function normalizeAlign(
  align: readonly unknown[] | undefined,
  cols: number,
): TableAlign[] | undefined {
  if (!align) return undefined;
  const out: TableAlign[] = [];
  let any = false;
  for (let c = 0; c < cols; c++) {
    const a = toTableAlign(align[c]);
    if (a !== null) any = true;
    out.push(a);
  }
  return any ? out : undefined;
}

/** `block` with its alignment array spliced like its columns were. */
export function spliceAlign(
  block: TableBlock,
  at: number,
  remove: number,
  insert: TableAlign[] = [],
): TableAlign[] | undefined {
  if (!block.align && insert.every((a) => a === null)) return undefined;
  const full: TableAlign[] = [];
  for (let c = 0; c < block.cols; c++) full.push(tableAlignAt(block, c));
  full.splice(at, remove, ...insert);
  return normalizeAlign(full, full.length);
}

/** `{ ...block, align }`, dropping the key rather than storing `undefined`. */
export function withAlign(block: TableBlock, align: TableAlign[] | undefined): TableBlock {
  if (align) return { ...block, align };
  if (!("align" in block)) return block;
  const { align: _dropped, ...rest } = block;
  return rest as TableBlock;
}

/** GFM's delimiter cell for an alignment. */
export function alignToMarkdown(align: TableAlign): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}
