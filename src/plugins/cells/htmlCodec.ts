// ---------------------------------------------------------------------------
// HTML codecs for table + columns blocks.
// ---------------------------------------------------------------------------

import { newBlockId } from "../../model/doc";
import {
  collectRuns,
  escapeHtml,
  runsToHtml,
} from "../../clipboard/inlineHtml";
import type {
  Block,
  BlockSpec,
  ColumnsBlock,
  InlineRun,
  MarkSet,
  TableAlign,
  TableBlock,
} from "../../model/types";
import { normalizeAlign, tableAlignAt, toTableAlign } from "./align";

/** A cell's alignment as an HTML producer writes it: `align=` (GFM renderers) or `text-align`. */
function cellAlign(td: Element): TableAlign {
  const attr = toTableAlign(td.getAttribute("align"));
  if (attr) return attr;
  const style = /text-align\s*:\s*([a-z]+)/i.exec(td.getAttribute("style") ?? "");
  return toTableAlign(style?.[1]);
}

// ---------------------------------------------------------------------------
// Table HTML
// ---------------------------------------------------------------------------

export function parseTableHTML(
  el: HTMLElement,
  ctx: { marks: MarkSet },
): BlockSpec | null {
  const rowsEls: HTMLElement[] = [];
  for (const tr of Array.from(el.querySelectorAll("tr"))) {
    rowsEls.push(tr as HTMLElement);
  }
  if (rowsEls.length === 0) return null;
  const cells: InlineRun[][][] = [];
  // A column's alignment is read off its first row, where a GFM renderer
  // writes it on every cell alike.
  const align: TableAlign[] = [];
  let cols = 0;
  for (const tr of rowsEls) {
    const row: InlineRun[][] = [];
    for (const td of Array.from(tr.children)) {
      const tag = td.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      if (cells.length === 0) align.push(cellAlign(td));
      row.push(collectRuns(td as HTMLElement, ctx.marks));
    }
    cells.push(row);
    if (row.length > cols) cols = row.length;
  }
  for (const row of cells) while (row.length < cols) row.push([]);
  const aligned = normalizeAlign(align, cols);
  return {
    id: newBlockId(),
    type: "table",
    rows: cells.length,
    cols,
    cells,
    ...(aligned ? { align: aligned } : {}),
  } as BlockSpec;
}

export function serializeTableHTML(b: Block): string {
  const t = b as TableBlock;
  let s = "<table><tbody>";
  for (let r = 0; r < t.rows; r++) {
    s += "<tr>";
    for (let c = 0; c < t.cols; c++) {
      const align = tableAlignAt(t, c);
      const open = align ? `<td style="text-align:${align}">` : "<td>";
      s += `${open}${runsToHtml(t.cells[r]?.[c] ?? [])}</td>`;
    }
    s += "</tr>";
  }
  s += "</tbody></table>";
  return s;
}

// ---------------------------------------------------------------------------
// Columns HTML
// ---------------------------------------------------------------------------

export function serializeColumnsHTML(b: Block): string {
  const cb = b as ColumnsBlock;
  let s = `<div data-creo-columns="${cb.cols}" style="display:grid;grid-template-columns:repeat(${cb.cols},1fr);gap:16px;">`;
  for (let c = 0; c < cb.cols; c++) {
    s += `<div data-col="${c}">${runsToHtml(cb.cells[c] ?? [])}</div>`;
  }
  s += "</div>";
  return s;
}
