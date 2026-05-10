// ---------------------------------------------------------------------------
// Search engine — iterate every text-bearing slot in the doc and emit
// `SearchMatch` records. Anchor encoding mirrors model/types.ts:
//   - text-bearing (p/h*/li/code): path = [charOffset]
//   - table:                       path = [row, col, charOffset]
//   - columns:                     path = [colIndex, charOffset]
// ---------------------------------------------------------------------------

import type { Anchor, Block, BlockId, DocState, InlineRun } from "../../model/types";
import { isTextBearing } from "../../model/blockText";

export type SearchMatch = {
  blockId: BlockId;
  start: Anchor;
  end: Anchor;
  /** Slice of the matched text — used for backend results that don't
   *  resolve to a live block; engine results include it for parity. */
  snippet?: string;
};

export type SearchOpts = {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};

type Slot = {
  text: string;
  /** Anchor path prefix this slot belongs to. Concatenated with charOffset
   *  to form the final anchor path. */
  prefix: number[];
};

function runsText(runs: InlineRun[]): string {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

/** Yield every searchable text slot for a block, with the anchor prefix
 *  needed to address positions inside it. Skips non-text blocks (img,
 *  calendar, date-marker). */
export function* slotsOf(block: Block): Generator<Slot> {
  if (isTextBearing(block)) {
    yield { text: runsText(block.runs), prefix: [] };
    return;
  }
  if (block.type === "table") {
    for (let r = 0; r < block.rows; r++) {
      const row = block.cells[r];
      if (!row) continue;
      for (let c = 0; c < block.cols; c++) {
        const cell = row[c];
        if (!cell) continue;
        yield { text: runsText(cell), prefix: [r, c] };
      }
    }
    return;
  }
  if (block.type === "columns") {
    for (let c = 0; c < block.cols; c++) {
      const cell = block.cells[c];
      if (!cell) continue;
      yield { text: runsText(cell), prefix: [c] };
    }
    return;
  }
  // img / calendar / date-marker — no searchable text in v1.
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a sticky-global regex for the query + options. Throws if the user
 *  supplied an invalid `regex: true` pattern — caller should catch and show
 *  a UI error. */
export function buildMatcher(query: string, opts: SearchOpts): RegExp {
  let pattern: string;
  if (opts.regex) {
    pattern = query;
  } else {
    pattern = escapeRegex(query);
  }
  if (opts.wholeWord) {
    pattern = `(?:^|[^\\w])(${pattern})(?=[^\\w]|$)`;
  }
  const flags = opts.caseSensitive ? "g" : "gi";
  return new RegExp(pattern, flags);
}

/** Run the matcher over a single slot and emit matches. The wholeWord
 *  wrapping captures the previous boundary char in group 0; we use the
 *  first capture group's index to land on the actual match. */
function* matchSlot(
  slot: Slot,
  blockId: BlockId,
  matcher: RegExp,
  wholeWord: boolean,
): Generator<SearchMatch> {
  matcher.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.exec(slot.text)) !== null) {
    let startCh: number;
    let endCh: number;
    let matchedText: string;
    if (wholeWord && m[1] !== undefined) {
      // group 1 is the actual match; group 0 includes the leading boundary
      const groupOffset = m[0].indexOf(m[1]);
      startCh = m.index + groupOffset;
      matchedText = m[1];
      endCh = startCh + matchedText.length;
      // If the match is zero-width somehow, advance to avoid infinite loop.
      if (matchedText.length === 0) {
        matcher.lastIndex = m.index + 1;
        continue;
      }
    } else {
      startCh = m.index;
      matchedText = m[0];
      endCh = startCh + matchedText.length;
      if (matchedText.length === 0) {
        matcher.lastIndex = m.index + 1;
        continue;
      }
    }
    yield {
      blockId,
      start: {
        blockId,
        path: [...slot.prefix, startCh],
        offset: startCh,
      },
      end: {
        blockId,
        path: [...slot.prefix, endCh],
        offset: endCh,
      },
      snippet: matchedText,
    };
  }
}

/** Scan every block in the doc and return all matches, in document order. */
export function searchDoc(
  doc: DocState,
  query: string,
  opts: SearchOpts,
): SearchMatch[] {
  if (query.length === 0) return [];
  let matcher: RegExp;
  try {
    matcher = buildMatcher(query, opts);
  } catch {
    return [];
  }
  const out: SearchMatch[] = [];
  for (const id of doc.order) {
    const block = doc.byId.get(id);
    if (!block) continue;
    for (const slot of slotsOf(block)) {
      if (slot.text.length === 0) continue;
      for (const m of matchSlot(slot, id, matcher, opts.wholeWord)) {
        out.push(m);
      }
    }
  }
  return out;
}

/** Stable key for dedupe across re-scans. */
export function matchKey(m: SearchMatch): string {
  return `${m.blockId}|${m.start.path.join(",")}|${m.end.path.join(",")}`;
}
