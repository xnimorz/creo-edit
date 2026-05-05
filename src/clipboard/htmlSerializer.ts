// ---------------------------------------------------------------------------
// HTML serialization — plugin-driven per-block, with list grouping handled
// here because <ul>/<ol> open/close spans across multiple `li` blocks.
//
// Per-block serializeHTML lives in the BlockDef the plugin registered. We
// look it up via getHtmlSerializer(block.type) and prepend a list-open or
// list-close prefix as needed.
// ---------------------------------------------------------------------------

import { iterBlocks } from "../model/doc";
import {
  blockTextLength,
  isTextBearing,
  splitRunsAt,
  type TextBearingBlock,
} from "../model/blockText";
import {
  anchorOffset,
  orderedRange,
} from "../controller/selection";
import { getHtmlSerializer } from "../plugin/htmlCodec";
import type {
  Block,
  ColumnsBlock,
  DocState,
  InlineRun,
  ListItemBlock,
  Selection,
  TableBlock,
} from "../model/types";

function escapePlain(s: string): string {
  return s.replace(/​/g, "");
}

function blockToHtml(block: Block, listOpen: { tag: string | null }): string {
  let prefix = "";
  if (block.type === "li") {
    const li = block as ListItemBlock;
    const wantTag = li.ordered ? "ol" : "ul";
    if (listOpen.tag !== wantTag) {
      if (listOpen.tag) prefix += `</${listOpen.tag}>`;
      prefix += `<${wantTag}>`;
      listOpen.tag = wantTag;
    }
  } else if (listOpen.tag) {
    prefix += `</${listOpen.tag}>`;
    listOpen.tag = null;
  }
  const ser = getHtmlSerializer(block.type);
  if (!ser) return prefix;
  return prefix + ser(block);
}

/** Whole-doc serialization (used by toJSON-ish helpers and copy-all). */
export function docToHtml(doc: DocState): string {
  const listOpen = { tag: null as string | null };
  let html = "";
  for (const b of iterBlocks(doc)) html += blockToHtml(b, listOpen);
  if (listOpen.tag) html += `</${listOpen.tag}>`;
  return html;
}

export function docToPlain(doc: DocState): string {
  const lines: string[] = [];
  for (const b of iterBlocks(doc)) {
    if (isTextBearing(b)) {
      lines.push(escapePlain(runsText((b as TextBearingBlock).runs)));
    } else if (b.type === "img") {
      lines.push(b.alt ?? "[image]");
    } else if (b.type === "table") {
      const t = b as TableBlock;
      for (let r = 0; r < t.rows; r++) {
        const cols: string[] = [];
        for (let c = 0; c < t.cols; c++) {
          cols.push(escapePlain(runsText(t.cells[r]?.[c] ?? [])));
        }
        lines.push(cols.join("\t"));
      }
    } else if (b.type === "columns") {
      const cb = b as ColumnsBlock;
      const cols: string[] = [];
      for (let c = 0; c < cb.cols; c++) {
        cols.push(escapePlain(runsText(cb.cells[c] ?? [])));
      }
      lines.push(cols.join("\t"));
    }
  }
  return lines.join("\n");
}

function runsText(runs: InlineRun[]): string {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

// ---------------------------------------------------------------------------
// Selection serialization — produce HTML + plain text for the OS clipboard.
// ---------------------------------------------------------------------------

export type ClipboardPayload = {
  html: string;
  plain: string;
};

export function selectionToClipboard(
  doc: DocState,
  sel: Selection,
): ClipboardPayload {
  if (sel.kind === "caret") return { html: "", plain: "" };
  const { start, end } = orderedRange(doc, sel);
  if (start.blockId === end.blockId) {
    const block = doc.byId.get(start.blockId);
    if (!block || !isTextBearing(block)) return { html: "", plain: "" };
    const sOff = anchorOffset(start);
    const eOff = anchorOffset(end);
    const [, midRight] = splitRunsAt(
      (block as TextBearingBlock).runs,
      sOff,
    );
    const [middle] = splitRunsAt(midRight, eOff - sOff);
    const slice: TextBearingBlock = {
      ...(block as TextBearingBlock),
      runs: middle,
    };
    const listOpen = { tag: null as string | null };
    let html = blockToHtml(slice as Block, listOpen);
    if (listOpen.tag) html += `</${listOpen.tag}>`;
    return { html, plain: runsText(middle) };
  }
  // Multi-block.
  const startI = doc.order.indexOf(start.blockId);
  const endI = doc.order.indexOf(end.blockId);
  if (startI < 0 || endI < 0) return { html: "", plain: "" };
  const listOpen = { tag: null as string | null };
  let html = "";
  const lines: string[] = [];
  for (let i = startI; i <= endI; i++) {
    const b = doc.byId.get(doc.order[i]!)!;
    let slice: Block = b;
    if (isTextBearing(b)) {
      let runs = (b as TextBearingBlock).runs;
      if (i === startI) {
        const [, right] = splitRunsAt(runs, anchorOffset(start));
        runs = right;
      }
      if (i === endI) {
        const len = blockTextLength({
          ...(b as TextBearingBlock),
          runs,
        } as TextBearingBlock);
        const eOff = anchorOffset(end) - (i === startI ? anchorOffset(start) : 0);
        const [left] = splitRunsAt(runs, Math.min(len, eOff));
        runs = left;
      }
      slice = { ...(b as TextBearingBlock), runs } as Block;
      lines.push(runsText(runs));
    } else {
      lines.push(
        b.type === "img"
          ? (b.alt ?? "[image]")
          : b.type === "columns"
            ? "[columns]"
            : "[table]",
      );
    }
    html += blockToHtml(slice, listOpen);
  }
  if (listOpen.tag) html += `</${listOpen.tag}>`;
  return { html, plain: lines.join("\n") };
}
