// ---------------------------------------------------------------------------
// HTML codecs for table + columns blocks.
// ---------------------------------------------------------------------------

import { newBlockId } from "../../model/doc";
import type {
  Block,
  BlockSpec,
  ColumnsBlock,
  InlineRun,
  Mark,
  TableBlock,
} from "../../model/types";

const MARK_TAGS_SER: Record<Mark, string> = {
  b: "strong",
  i: "em",
  u: "u",
  s: "s",
  code: "code",
};
const MARK_ORDER: Mark[] = ["code", "b", "i", "u", "s"];

const MARK_TAGS: Record<string, Mark> = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runsFor(node: Node, marks: Mark[]): InlineRun[] {
  if (node.nodeType === 3) {
    const t = (node as Text).data;
    if (t.length === 0) return [];
    return [
      { text: t, ...(marks.length ? { marks: new Set(marks) } : {}) },
    ];
  }
  if (node.nodeType !== 1) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") {
    return [{ text: "\n", ...(marks.length ? { marks: new Set(marks) } : {}) }];
  }
  const additional = MARK_TAGS[tag];
  const nextMarks = additional ? [...marks, additional] : marks;
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) out.push(...runsFor(c, nextMarks));
  return out;
}

function collectRuns(el: HTMLElement, marks: Mark[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) out.push(...runsFor(c, marks));
  return out.filter((r) => r.text.length > 0);
}

function runsToHtml(runs: InlineRun[]): string {
  let out = "";
  for (const r of runs) {
    let inner = escapeHtml(r.text);
    if (r.marks && r.marks.size) {
      for (const m of MARK_ORDER) {
        if (!r.marks.has(m)) continue;
        const tag = MARK_TAGS_SER[m];
        inner = `<${tag}>${inner}</${tag}>`;
      }
    }
    out += inner;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Table HTML
// ---------------------------------------------------------------------------

export function parseTableHTML(
  el: HTMLElement,
  ctx: { marks: Mark[] },
): BlockSpec | null {
  const rowsEls: HTMLElement[] = [];
  for (const tr of Array.from(el.querySelectorAll("tr"))) {
    rowsEls.push(tr as HTMLElement);
  }
  if (rowsEls.length === 0) return null;
  const cells: InlineRun[][][] = [];
  let cols = 0;
  for (const tr of rowsEls) {
    const row: InlineRun[][] = [];
    for (const td of Array.from(tr.children)) {
      const tag = td.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      row.push(collectRuns(td as HTMLElement, ctx.marks));
    }
    cells.push(row);
    if (row.length > cols) cols = row.length;
  }
  for (const row of cells) while (row.length < cols) row.push([]);
  return {
    id: newBlockId(),
    type: "table",
    rows: cells.length,
    cols,
    cells,
  } as BlockSpec;
}

export function serializeTableHTML(b: Block): string {
  const t = b as TableBlock;
  let s = "<table><tbody>";
  for (let r = 0; r < t.rows; r++) {
    s += "<tr>";
    for (let c = 0; c < t.cols; c++) {
      s += `<td>${runsToHtml(t.cells[r]?.[c] ?? [])}</td>`;
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
