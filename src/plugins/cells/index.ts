// ---------------------------------------------------------------------------
// cellsPlugin — table + columns blocks. First-party plugin shipped by
// default. Users can opt out by passing `plugins: defaultPlugins.filter(p =>
// p.name !== "cells")` to createEditor.
//
// Bundled here:
//   - block defs (view, runsAt, anchor codec, HTML codec, serialize codec)
//   - namespaced commands (table.insertRow, table.nextCell, ...)
//   - keymap entries: Tab / Shift-Tab + Arrow keys (gated by isInTable)
// ---------------------------------------------------------------------------

import type { PublicView } from "creo";
import { newBlockId } from "../../model/doc";
import type {
  Block,
  BlockSpec,
  ColumnsBlock,
  InlineRun,
  Mark,
  TableBlock,
} from "../../model/types";
import type {
  BlockDef,
  EditorPlugin,
  KeymapDef,
} from "../../plugin/types";
import {
  columnsAnchorCodec,
  columnsRunsAt,
  tableAnchorCodec,
  tableRunsAt,
} from "./codecs";
import {
  parseTableHTML,
  serializeColumnsHTML,
  serializeTableHTML,
} from "./htmlCodec";
import { ColumnsViewPlugin, TableViewPlugin } from "./views";
import { isInColumns, isInTable, tableCommandDefs } from "./commands";

const ALLOWED_MARKS = new Set<Mark>(["b", "i", "u", "s", "code"]);

type SerializedRun = { text: string; marks?: string[] };

function deserializeRun(r: SerializedRun): InlineRun {
  if (!r.marks || r.marks.length === 0) return { text: r.text };
  const marks = new Set<Mark>();
  for (const m of r.marks) if (ALLOWED_MARKS.has(m as Mark)) marks.add(m as Mark);
  return marks.size === 0 ? { text: r.text } : { text: r.text, marks };
}

function serializeRun(r: InlineRun): SerializedRun {
  if (!r.marks || r.marks.size === 0) return { text: r.text };
  return { text: r.text, marks: [...r.marks] };
}

const tableDef: BlockDef<TableBlock> = {
  type: "table",
  view: TableViewPlugin as PublicView<{ block: TableBlock; key?: string }, void>,
  isTextBearing: false,
  runsAt: tableRunsAt as never,
  anchorCodec: tableAnchorCodec,
  htmlCodec: {
    matchHTML: ["table"],
    parseHTML: parseTableHTML,
    serializeHTML: serializeTableHTML,
  },
  serializeCodec: {
    serialize(b) {
      const t = b as TableBlock;
      return {
        id: t.id,
        type: "table",
        rows: t.rows,
        cols: t.cols,
        cells: t.cells.map((row) => row.map((cell) => cell.map(serializeRun))),
      };
    },
    deserialize(s, id) {
      const sb = s as { rows: number; cols: number; cells: SerializedRun[][][] };
      return {
        id,
        type: "table",
        rows: sb.rows,
        cols: sb.cols,
        cells: sb.cells.map((row) => row.map((cell) => cell.map(deserializeRun))),
      } as BlockSpec;
    },
  },
};

const columnsDef: BlockDef<ColumnsBlock> = {
  type: "columns",
  view: ColumnsViewPlugin as PublicView<{ block: ColumnsBlock; key?: string }, void>,
  isTextBearing: false,
  runsAt: columnsRunsAt as never,
  anchorCodec: columnsAnchorCodec,
  htmlCodec: {
    serializeHTML: serializeColumnsHTML,
  },
  serializeCodec: {
    serialize(b) {
      const cb = b as ColumnsBlock;
      return {
        id: cb.id,
        type: "columns",
        cols: cb.cols,
        cells: cb.cells.map((cell) => cell.map(serializeRun)),
      };
    },
    deserialize(s, id) {
      const sb = s as { cols: number; cells: SerializedRun[][] };
      return {
        id,
        type: "columns",
        cols: sb.cols,
        cells: sb.cells.map((cell) => cell.map(deserializeRun)),
      } as BlockSpec;
    },
  },
};

// Keymap: gate by isInTable so plain Tab / arrow keys outside a table fall
// through to the existing list-indent / browser-default handlers. The arrow
// commands return false at non-edge positions so the keymap dispatcher
// doesn't preventDefault — letting the browser handle within-cell motion.
const cellsKeymap: KeymapDef[] = [
  {
    chord: "Tab",
    when: (ctx) => isInTable(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "table.nextCell" },
  },
  {
    chord: "Shift+Tab",
    when: (ctx) => isInTable(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "table.prevCell" },
  },
  {
    chord: "ArrowLeft",
    when: (ctx) => isInTable(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "table.arrowLeft" },
  },
  {
    chord: "ArrowRight",
    when: (ctx) => isInTable(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "table.arrowRight" },
  },
  {
    chord: "ArrowUp",
    when: (ctx) => isInTable(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "table.arrowUp" },
  },
  {
    chord: "ArrowDown",
    when: (ctx) => isInTable(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "table.arrowDown" },
  },
  // Columns navigation — Tab walks columns left-to-right; arrow keys jump
  // between columns at the cell text edges (just like in tables).
  {
    chord: "Tab",
    when: (ctx) => isInColumns(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "columns.next" },
  },
  {
    chord: "Shift+Tab",
    when: (ctx) => isInColumns(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "columns.prev" },
  },
  {
    chord: "ArrowLeft",
    when: (ctx) => isInColumns(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "columns.arrowLeft" },
  },
  {
    chord: "ArrowRight",
    when: (ctx) => isInColumns(ctx.docStore.get(), ctx.selStore.get()),
    command: { t: "columns.arrowRight" },
  },
];

// Back-compat command aliases — the existing typed Command union has shapes
// like { t: "tableInsertRow", where }. Routing them to the namespaced
// implementations keeps existing callers (and tests) working without
// renaming everywhere at once.
const backcompatAliases = [
  { t: "tableInsertRow", run: (ctx, p) => tableCommandDefs.find((c) => c.t === "table.insertRow")!.run(ctx, (p as { where: "above" | "below" }).where) },
  { t: "tableInsertCol", run: (ctx, p) => tableCommandDefs.find((c) => c.t === "table.insertCol")!.run(ctx, (p as { where: "before" | "after" }).where) },
  { t: "tableRemoveRow", run: (ctx, _p) => tableCommandDefs.find((c) => c.t === "table.removeRow")!.run(ctx, undefined) },
  { t: "tableRemoveCol", run: (ctx, _p) => tableCommandDefs.find((c) => c.t === "table.removeCol")!.run(ctx, undefined) },
] as { t: string; run: (ctx: import("../../plugin/types").CommandCtx, p: unknown) => boolean | void }[];

export const cellsPlugin: EditorPlugin = {
  name: "cells",
  blocks: [tableDef as BlockDef<Block>, columnsDef as BlockDef<Block>],
  commands: [...tableCommandDefs, ...backcompatAliases],
  keymap: cellsKeymap,
};

export { isInTable } from "./commands";
