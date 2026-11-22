import { blockTextOf, isTextBearing } from "./blockText";
import { mapAnchor, type DocChange } from "./changes";
import { isAtomicBlockType } from "../plugin/atomic";
import type { Block, BlockId, DocState, Selection } from "./types";

/**
 * The per-block changes that take `before` to `after`, matched by block id.
 * A text block whose text changed is one `text` change over the span that
 * differs, so anchors either side of it map rather than being dropped; a
 * block whose text is unchanged but whose type, marks or attributes moved is
 * `blockAttrs`; a table or other shape no offset describes is `resetBlock`.
 */
export function changesBetween(before: DocState, after: DocState): DocChange[] {
  const out: DocChange[] = [];
  for (const id of before.order) {
    if (!after.byId.has(id)) out.push({ kind: "removeBlock", blockId: id });
  }
  after.order.forEach((id, index) => {
    if (!before.byId.has(id)) out.push({ kind: "insertBlock", blockId: id, index });
  });
  for (const id of after.order) {
    const a = before.byId.get(id);
    const b = after.byId.get(id)!;
    if (a === undefined || a === b) continue;
    out.push(...blockChanges(a, b));
  }
  out.push(...moves(before, after));
  return out;
}

function blockChanges(a: Block, b: Block): DocChange[] {
  const typeChanged = a.type !== b.type;
  if (isTextBearing(a) && isTextBearing(b)) {
    const ta = blockTextOf(a);
    const tb = blockTextOf(b);
    if (ta === tb) return [{ kind: "blockAttrs", blockId: b.id, type: b.type }];
    const out: DocChange[] = [];
    if (typeChanged) out.push({ kind: "blockAttrs", blockId: b.id, type: b.type });
    out.push(textChange(b.id, ta, tb));
    return out;
  }
  if (!typeChanged && isAtomicBlockType(b.type)) {
    return [{ kind: "blockAttrs", blockId: b.id, type: b.type }];
  }
  return [{ kind: "resetBlock", blockId: b.id }];
}

function textChange(blockId: BlockId, before: string, after: string): DocChange {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end++;
  }
  return {
    kind: "text",
    blockId,
    container: [],
    from: start,
    to: before.length - end,
    insertedLength: after.length - end - start,
  };
}

/** The fewest kept blocks that moved: those off the longest run still in order. */
function moves(before: DocState, after: DocState): DocChange[] {
  const fromPos = new Map<BlockId, number>();
  before.order.forEach((id, i) => fromPos.set(id, i));
  const kept: Array<{ id: BlockId; from: number; to: number }> = [];
  after.order.forEach((id, to) => {
    const from = fromPos.get(id);
    if (from !== undefined) kept.push({ id, from, to });
  });

  // Longest increasing subsequence of `from`, by patience sorting.
  const tails: number[] = [];
  const prev = new Array<number>(kept.length).fill(-1);
  kept.forEach((k, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kept[tails[mid]!]!.from < k.from) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const stay = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) stay.add(i);

  const out: DocChange[] = [];
  kept.forEach((k, i) => {
    if (!stay.has(i)) out.push({ kind: "moveBlock", blockId: k.id, from: k.from, to: k.to });
  });
  return out;
}

/** The selection carried through `changes`; null where an end no longer exists. */
export function mapSelection(sel: Selection, changes: readonly DocChange[]): Selection | null {
  if (sel.kind === "caret") {
    const at = mapAnchor(sel.at, changes);
    return at ? { kind: "caret", at } : null;
  }
  const anchor = mapAnchor(sel.anchor, changes);
  const focus = mapAnchor(sel.focus, changes);
  return anchor && focus ? { kind: "range", anchor, focus } : null;
}
