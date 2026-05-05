// ---------------------------------------------------------------------------
// Table / columns commands. Logic moved from src/commands/tableCommands.ts;
// commands are exposed as CommandDef entries so they're dispatched through
// the plugin registry by namespaced t-strings ("table.insertRow", etc.).
//
// Command return values: `boolean` indicates whether the command applied
// (false = no-op). The plugin keymap dispatcher in nativeInput uses this to
// decide whether to preventDefault — arrow keys at cell edges that don't
// jump should fall through to the browser for within-cell motion.
// ---------------------------------------------------------------------------

import { getBlock, updateBlock } from "../../model/doc";
import { anchorOffset, caret } from "../../controller/selection";
import type {
  Block,
  ColumnsBlock,
  DocState,
  InlineRun,
  Selection,
  TableBlock,
} from "../../model/types";
import type { CommandCtx, CommandDef } from "../../plugin/types";

function currentTable(
  doc: DocState,
  sel: Selection,
): { block: TableBlock; row: number; col: number; off: number } | null {
  const start = sel.kind === "caret" ? sel.at : sel.anchor;
  const block = getBlock(doc, start.blockId);
  if (!block || block.type !== "table") return null;
  return {
    block: block as TableBlock,
    row: start.path[0] ?? 0,
    col: start.path[1] ?? 0,
    off: anchorOffset(start),
  };
}

function emptyRow(cols: number): InlineRun[][] {
  const row: InlineRun[][] = [];
  for (let i = 0; i < cols; i++) row.push([]);
  return row;
}

export function isInTable(doc: DocState, sel: Selection): boolean {
  return currentTable(doc, sel) !== null;
}

function currentColumns(
  doc: DocState,
  sel: Selection,
): { block: ColumnsBlock; col: number; off: number } | null {
  const start = sel.kind === "caret" ? sel.at : sel.anchor;
  const block = getBlock(doc, start.blockId);
  if (!block || block.type !== "columns") return null;
  return {
    block: block as ColumnsBlock,
    col: start.path[0] ?? 0,
    off: anchorOffset(start),
  };
}

export function isInColumns(doc: DocState, sel: Selection): boolean {
  return currentColumns(doc, sel) !== null;
}

function colTextLength(b: ColumnsBlock, col: number): number {
  const runs = b.cells[col] ?? [];
  return runs.reduce((n, r) => n + r.text.length, 0);
}

function columnsNext(ctx: CommandCtx): boolean {
  const c = currentColumns(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const nc = c.col + 1;
  if (nc >= c.block.cols) return false;
  ctx.selStore.set(caret({ blockId: c.block.id, path: [nc, 0], offset: 0 }));
  return true;
}

function columnsPrev(ctx: CommandCtx): boolean {
  const c = currentColumns(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const nc = c.col - 1;
  if (nc < 0) return false;
  const off = colTextLength(c.block, nc);
  ctx.selStore.set(caret({ blockId: c.block.id, path: [nc, off], offset: off }));
  return true;
}

function columnsArrowLeft(ctx: CommandCtx): boolean {
  const c = currentColumns(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  if (c.off !== 0) return false;
  const nc = c.col - 1;
  if (nc < 0) return false;
  const off = colTextLength(c.block, nc);
  ctx.selStore.set(caret({ blockId: c.block.id, path: [nc, off], offset: off }));
  return true;
}

function columnsArrowRight(ctx: CommandCtx): boolean {
  const c = currentColumns(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const len = colTextLength(c.block, c.col);
  if (c.off !== len) return false;
  const nc = c.col + 1;
  if (nc >= c.block.cols) return false;
  ctx.selStore.set(caret({ blockId: c.block.id, path: [nc, 0], offset: 0 }));
  return true;
}

function cellTextLength(b: TableBlock, row: number, col: number): number {
  const runs = b.cells[row]?.[col] ?? [];
  return runs.reduce((n, r) => n + r.text.length, 0);
}

// ---------------------------------------------------------------------------
// Insert / remove
// ---------------------------------------------------------------------------

function insertRow(ctx: CommandCtx, where: "above" | "below", moveTo = false): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const { block, row } = c;
  const insertAt = where === "above" ? row : row + 1;
  const cells = [
    ...block.cells.slice(0, insertAt),
    emptyRow(block.cols),
    ...block.cells.slice(insertAt),
  ];
  const next: TableBlock = { ...block, rows: block.rows + 1, cells };
  ctx.docStore.set(updateBlock(ctx.docStore.get(), next as Block));
  if (moveTo) {
    ctx.selStore.set(caret({ blockId: block.id, path: [insertAt, 0, 0], offset: 0 }));
  }
  return true;
}

function insertCol(ctx: CommandCtx, where: "before" | "after"): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const { block, col } = c;
  const insertAt = where === "before" ? col : col + 1;
  const cells = block.cells.map((row) => [
    ...row.slice(0, insertAt),
    [] as InlineRun[],
    ...row.slice(insertAt),
  ]);
  const next: TableBlock = { ...block, cols: block.cols + 1, cells };
  ctx.docStore.set(updateBlock(ctx.docStore.get(), next as Block));
  return true;
}

function removeRow(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const { block, row } = c;
  if (block.rows <= 1) return false;
  const cells = block.cells.filter((_, i) => i !== row);
  const next: TableBlock = { ...block, rows: block.rows - 1, cells };
  ctx.docStore.set(updateBlock(ctx.docStore.get(), next as Block));
  const newRow = Math.min(row, next.rows - 1);
  ctx.selStore.set(caret({ blockId: block.id, path: [newRow, c.col, 0], offset: 0 }));
  return true;
}

function removeCol(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const { block, col } = c;
  if (block.cols <= 1) return false;
  const cells = block.cells.map((row) => row.filter((_, i) => i !== col));
  const next: TableBlock = { ...block, cols: block.cols - 1, cells };
  ctx.docStore.set(updateBlock(ctx.docStore.get(), next as Block));
  const newCol = Math.min(col, next.cols - 1);
  ctx.selStore.set(caret({ blockId: block.id, path: [c.row, newCol, 0], offset: 0 }));
  return true;
}

// ---------------------------------------------------------------------------
// Cell navigation
// ---------------------------------------------------------------------------

function nextCell(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const { block, row, col } = c;
  let nr = row;
  let nc = col + 1;
  if (nc >= block.cols) {
    nc = 0;
    nr += 1;
  }
  if (nr >= block.rows) {
    // Auto-add a new row when tabbing past the last cell.
    return insertRow(ctx, "below", true);
  }
  ctx.selStore.set(caret({ blockId: block.id, path: [nr, nc, 0], offset: 0 }));
  return true;
}

function prevCell(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const { block, row, col } = c;
  let nr = row;
  let nc = col - 1;
  if (nc < 0) {
    nc = block.cols - 1;
    nr -= 1;
  }
  if (nr < 0) return false;
  ctx.selStore.set(caret({ blockId: block.id, path: [nr, nc, 0], offset: 0 }));
  return true;
}

// ---------------------------------------------------------------------------
// Arrow-key cell navigation — each returns false when the key isn't an
// "edge" press (e.g. ArrowRight inside cell text); the keymap dispatcher
// then doesn't preventDefault and the browser handles within-cell motion.
// ---------------------------------------------------------------------------

function arrowLeft(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  if (c.off !== 0) return false;
  const { block, row, col } = c;
  let nr = row, nc = col - 1;
  if (nc < 0) {
    nc = block.cols - 1;
    nr -= 1;
  }
  if (nr < 0) return false;
  const off = cellTextLength(block, nr, nc);
  ctx.selStore.set(caret({ blockId: block.id, path: [nr, nc, off], offset: off }));
  return true;
}

function arrowRight(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  const len = cellTextLength(c.block, c.row, c.col);
  if (c.off !== len) return false;
  const { block, row, col } = c;
  let nr = row, nc = col + 1;
  if (nc >= block.cols) {
    nc = 0;
    nr += 1;
  }
  if (nr >= block.rows) return false;
  ctx.selStore.set(caret({ blockId: block.id, path: [nr, nc, 0], offset: 0 }));
  return true;
}

function arrowUp(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  if (c.row === 0) return false;
  const nr = c.row - 1;
  const off = cellTextLength(c.block, nr, c.col);
  ctx.selStore.set(caret({ blockId: c.block.id, path: [nr, c.col, off], offset: off }));
  return true;
}

function arrowDown(ctx: CommandCtx): boolean {
  const c = currentTable(ctx.docStore.get(), ctx.selStore.get());
  if (!c) return false;
  if (c.row >= c.block.rows - 1) return false;
  const nr = c.row + 1;
  ctx.selStore.set(caret({ blockId: c.block.id, path: [nr, c.col, 0], offset: 0 }));
  return true;
}

// ---------------------------------------------------------------------------
// CommandDef export — registered by cellsPlugin.
// ---------------------------------------------------------------------------

export const tableCommandDefs: CommandDef<unknown>[] = [
  { t: "table.insertRow", run: (ctx, p) => insertRow(ctx, p as "above" | "below") },
  { t: "table.insertCol", run: (ctx, p) => insertCol(ctx, p as "before" | "after") },
  { t: "table.removeRow", run: (ctx) => removeRow(ctx) },
  { t: "table.removeCol", run: (ctx) => removeCol(ctx) },
  { t: "table.nextCell", run: (ctx) => nextCell(ctx) },
  { t: "table.prevCell", run: (ctx) => prevCell(ctx) },
  { t: "table.arrowLeft", run: (ctx) => arrowLeft(ctx) },
  { t: "table.arrowRight", run: (ctx) => arrowRight(ctx) },
  { t: "table.arrowUp", run: (ctx) => arrowUp(ctx) },
  { t: "table.arrowDown", run: (ctx) => arrowDown(ctx) },
  // Columns navigation — Tab moves between columns.
  { t: "columns.next", run: (ctx) => columnsNext(ctx) },
  { t: "columns.prev", run: (ctx) => columnsPrev(ctx) },
  { t: "columns.arrowLeft", run: (ctx) => columnsArrowLeft(ctx) },
  { t: "columns.arrowRight", run: (ctx) => columnsArrowRight(ctx) },
];
