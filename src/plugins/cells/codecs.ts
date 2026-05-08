// ---------------------------------------------------------------------------
// Anchor + runsAt codecs for table and columns blocks.
//
// Path encoding:
//   table:   [row, col, charOffset]
//   columns: [colIndex, charOffset]
//
// The codecs walk into the cell sub-element by reading data-cell / data-col
// attributes the views emit, then delegate visible-character math to the
// shared offsetWithinScope / findTextPoint helpers from anchorCodec.
// ---------------------------------------------------------------------------

import type {
  Anchor,
  Block,
  ColumnsBlock,
  InlineRun,
  TableBlock,
} from "../../model/types";
import {
  findTextPoint,
  offsetWithinScope,
} from "../../plugin/anchorCodec";
import type { AnchorCodec, RunsCtx } from "../../plugin/types";

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function tableRunsAt(b: TableBlock, a: Anchor): RunsCtx | null {
  const r = a.path[0] ?? 0;
  const c = a.path[1] ?? 0;
  if (r < 0 || r >= b.rows || c < 0 || c >= b.cols) return null;
  const runs = b.cells[r]?.[c] ?? [];
  return {
    runs,
    setRuns: (newRuns: InlineRun[]) => {
      const cells = b.cells.map((row, rr) =>
        rr === r ? row.map((cell, cc) => (cc === c ? newRuns : cell)) : row,
      );
      return { ...b, cells } as Block;
    },
  };
}

function findOwningCellEl(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  while (cur && cur.nodeType === 1) {
    const el = cur as HTMLElement;
    if (el.tagName.toLowerCase() === "td" && el.hasAttribute("data-cell")) {
      return el;
    }
    cur = el.parentElement;
  }
  return null;
}

export const tableAnchorCodec: AnchorCodec = {
  domToAnchor(blockEl, hit, off) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    const td = findOwningCellEl(hit);
    if (td) {
      const cellAttr = td.getAttribute("data-cell");
      if (cellAttr) {
        const [rs, cs] = cellAttr.split(":");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isFinite(r) && Number.isFinite(c)) {
          const charOff = offsetWithinScope(td, hit, off);
          return { blockId, path: [r, c, charOff], offset: charOff };
        }
      }
    }
    return { blockId, path: [0, 0, 0], offset: 0 };
  },
  anchorToDom(blockEl, a) {
    const r = a.path[0] ?? 0;
    const c = a.path[1] ?? 0;
    const charOff = a.path[2] ?? 0;
    const tdEl = blockEl.querySelector<HTMLElement>(`td[data-cell="${r}:${c}"]`);
    if (!tdEl) return null;
    return findTextPoint(tdEl, charOff);
  },
  domScope(blockEl, a) {
    const r = a.path[0] ?? 0;
    const c = a.path[1] ?? 0;
    return blockEl.querySelector<HTMLElement>(`td[data-cell="${r}:${c}"]`);
  },
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function columnsRunsAt(b: ColumnsBlock, a: Anchor): RunsCtx | null {
  const c = a.path[0] ?? 0;
  if (c < 0 || c >= b.cols) return null;
  const runs = b.cells[c] ?? [];
  return {
    runs,
    setRuns: (newRuns: InlineRun[]) => {
      const cells = b.cells.map((cell, cc) => (cc === c ? newRuns : cell));
      return { ...b, cells } as Block;
    },
  };
}

function findOwningColEl(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  while (cur && cur.nodeType === 1) {
    const el = cur as HTMLElement;
    if (el.hasAttribute("data-col")) return el;
    cur = el.parentElement;
  }
  return null;
}

// Per-line traversal helpers — columns render one `.ce-col-line` div per
// visual line (mirroring code blocks). The model treats `\n` as a real
// char between lines, so we add 1 to the running offset between adjacent
// line divs.

function visibleLength(el: HTMLElement): number {
  const ZWSP = "​";
  let n = 0;
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const t = (node as Text).data;
      if (t !== ZWSP) n += t.length;
      return;
    }
    for (const c of Array.from(node.childNodes)) walk(c);
  };
  walk(el);
  return n;
}

export const columnsAnchorCodec: AnchorCodec = {
  domToAnchor(blockEl, hit, off) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    const colEl = findOwningColEl(hit);
    if (!colEl) return { blockId, path: [0, 0], offset: 0 };
    const ci = Number(colEl.getAttribute("data-col"));
    if (!Number.isFinite(ci)) return { blockId, path: [0, 0], offset: 0 };
    const lines = colEl.querySelectorAll<HTMLElement>(".ce-col-line");
    if (lines.length === 0) {
      const charOff = offsetWithinScope(colEl, hit, off);
      return { blockId, path: [ci, charOff], offset: charOff };
    }
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === hit || line.contains(hit)) {
        const inLine = total + offsetWithinScope(line, hit, off);
        return { blockId, path: [ci, inLine], offset: inLine };
      }
      total += visibleLength(line);
      if (i < lines.length - 1) total += 1;
    }
    return { blockId, path: [ci, total], offset: total };
  },
  anchorToDom(blockEl, a) {
    const ci = a.path[0] ?? 0;
    const charOff = a.path[1] ?? 0;
    const colEl = blockEl.querySelector<HTMLElement>(`[data-col="${ci}"]`);
    if (!colEl) return null;
    const lines = colEl.querySelectorAll<HTMLElement>(".ce-col-line");
    if (lines.length === 0) return findTextPoint(colEl, charOff);
    let remaining = charOff;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const len = visibleLength(line);
      if (remaining <= len) return findTextPoint(line, remaining);
      remaining -= len;
      if (i < lines.length - 1) {
        if (remaining === 0) return findTextPoint(lines[i + 1]!, 0);
        remaining -= 1;
      }
    }
    const last = lines[lines.length - 1]!;
    return findTextPoint(last, visibleLength(last));
  },
  domScope(blockEl, a) {
    const ci = a.path[0] ?? 0;
    return blockEl.querySelector<HTMLElement>(`[data-col="${ci}"]`);
  },
};
