// ---------------------------------------------------------------------------
// Search engine — iterate every text-bearing slot in the doc and emit
// `SearchMatch` records. Anchor encoding mirrors model/types.ts:
//   - text-bearing (p/h*/li/code): path = [charOffset]
//   - table:                       path = [row, col, charOffset]
//   - columns:                     path = [colIndex, charOffset]
// ---------------------------------------------------------------------------

import type { Anchor, BlockId, DocState } from "../../model/types";
import { textSlotsOf, type TextSlot } from "../../model/blockText";

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

type Slot = TextSlot;

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
        path: [...slot.path, startCh],
        offset: startCh,
      },
      end: {
        blockId,
        path: [...slot.path, endCh],
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
    for (const slot of textSlotsOf(block)) {
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
