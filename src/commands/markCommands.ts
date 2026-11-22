import type { Store } from "creo";
import {
  isTextBearing,
  marksAt,
  normalizeRuns,
  runsLength,
  splitRunsAt,
  type TextBearingBlock,
} from "../model/blockText";
import {
  attrsEqual,
  withMark as markSetWith,
  withoutMark as markSetWithout,
} from "../model/marks";
import { findPos, getBlock, updateBlock } from "../model/doc";
import { recordChange } from "../model/changes";
import {
  anchorOffset,
  isCaret,
  orderedRange,
} from "../controller/selection";
import { containerOf } from "../model/changes";
import { runsAt } from "../model/cellAccess";
import type {
  Anchor,
  Block,
  DocState,
  InlineRun,
  MarkAttrs,
  MarkName,
  MarkSet,
  Selection,
} from "../model/types";

export type Stores = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
};

// ---------------------------------------------------------------------------
// Pending marks — a mark toggled at a caret (⌘B with nothing selected) is
// kept for the text typed next at that caret, as other editors' "stored
// marks" are. Keyed by the selection store, so each editor has its own; held
// only while the caret stays where it was toggled.
// ---------------------------------------------------------------------------

const pendingMarks = new WeakMap<Store<Selection>, { at: Anchor; marks: MarkSet }>();

const sameCaret = (a: Anchor, b: Anchor): boolean =>
  a.blockId === b.blockId &&
  a.offset === b.offset &&
  a.path.length === b.path.length &&
  a.path.every((v, i) => v === b.path[i]);

/**
 * The marks text typed at the caret would carry: the ones toggled there, or
 * else the ones it inherits from the text before it. `null` when the
 * selection is not a caret in text.
 */
export function marksAtCaret({ docStore, selStore }: Stores): MarkSet | null {
  const sel = selStore.get();
  if (!isCaret(sel)) return null;
  const pending = pendingMarks.get(selStore);
  if (pending && sameCaret(pending.at, sel.at)) return pending.marks;
  const block = getBlock(docStore.get(), sel.at.blockId);
  const ctx = block && runsAt(block, sel.at);
  if (!ctx) return null;
  return marksAt(ctx.runs, anchorOffset(sel.at)) ?? new Map();
}

/**
 * The marks toggled at `at` for the text typed next — taken, so they apply
 * once. Undefined when none were toggled there.
 */
export function takePendingMarks(selStore: Store<Selection>, at: Anchor): MarkSet | undefined {
  const pending = pendingMarks.get(selStore);
  if (!pending) return undefined;
  pendingMarks.delete(selStore);
  return sameCaret(pending.at, at) ? pending.marks : undefined;
}

function togglePendingMark(stores: Stores, mark: MarkName, attrs: MarkAttrs): boolean {
  const marks = marksAtCaret(stores);
  if (!marks) return false;
  const sel = stores.selStore.get();
  if (!isCaret(sel)) return false;
  const next = new Map(marks);
  if (next.has(mark)) next.delete(mark);
  else next.set(mark, attrs);
  pendingMarks.set(stores.selStore, { at: sel.at, marks: next });
  return true;
}

/**
 * Toggle a mark over the current selection.
 *
 * Behaviour:
 *  - Caret-only: the mark is toggled for the text typed next at that caret
 *    (a pending mark; `marksAtCaret` reads it). The document does not
 *    change, so the dispatcher records no undo step for it. Moving the
 *    caret drops it.
 *  - Single-block range: if every character in [start, end) already carries
 *    the mark WITH THE SAME ATTRS, REMOVE it; otherwise apply it everywhere
 *    in the range.
 *  - Cross-block range: same rule applied per-block to the slice that
 *    intersects the range.
 *
 * `attrs` is the mark's payload — `null` for the boolean marks, `{ href }`
 * for `link`. Because "already has it" compares attrs too, re-running
 * `toggleMark("link", { href: B })` over a range already linked to A
 * RETARGETS the link rather than clearing it, which is what a link dialog's
 * "apply" wants. Use `removeMark` for an unconditional unlink.
 *
 * Run merging happens via `normalizeRuns`, so toggling repeatedly never
 * fragments runs unbounded.
 */
export function toggleMark(
  { docStore, selStore }: Stores,
  mark: MarkName,
  attrs: MarkAttrs = null,
): boolean {
  if (isCaret(selStore.get())) return togglePendingMark({ docStore, selStore }, mark, attrs);
  return applyMark({ docStore, selStore }, mark, attrs, "toggle");
}

/**
 * Remove `mark` across the selection regardless of its attrs. This is the
 * "unlink" half of a link UI — `toggleMark("link", …)` with a fresh href
 * retargets rather than clears, so clearing needs its own entry point.
 */
export function removeMark(
  { docStore, selStore }: Stores,
  mark: MarkName,
): boolean {
  return applyMark({ docStore, selStore }, mark, null, "remove");
}

function applyMark(
  { docStore, selStore }: Stores,
  mark: MarkName,
  attrs: MarkAttrs,
  mode: "toggle" | "remove",
): boolean {
  const sel = selStore.get();
  if (isCaret(sel)) return false;
  const doc = docStore.get();
  const { start, end } = orderedRange(doc, sel);

  const startI = findPos(doc, start.blockId);
  const endI = findPos(doc, end.blockId);
  if (startI < 0 || endI < 0) return false;

  // First pass: figure out whether the entire selection already carries the
  // mark with these attrs (so we know whether to add or remove). We must
  // inspect every char in the covered slices.
  let allHave = true;
  let touchedAny = false;
  for (let i = startI; i <= endI; i++) {
    const id = doc.order[i]!;
    const block = getBlock(doc, id);
    if (!block || !isTextBearing(block)) continue;
    const sOff = i === startI ? anchorOffset(start) : 0;
    const eOff =
      i === endI ? anchorOffset(end) : runsLength((block as TextBearingBlock).runs);
    if (sOff === eOff) continue;
    touchedAny = true;
    const runs = (block as TextBearingBlock).runs;
    if (!sliceAllHasMark(runs, sOff, eOff, mark, attrs)) {
      allHave = false;
      break;
    }
  }
  if (!touchedAny) return false;

  const add = mode === "remove" ? false : !allHave;
  // "Remove what isn't there" is a no-op — say so rather than pushing an
  // identical document and an empty undo step.
  if (!add && mode === "remove" && allHaveNone(doc, startI, endI, start, end, mark)) {
    return false;
  }

  // Second pass: write the change.
  let working = doc;
  let wrote = false;
  for (let i = startI; i <= endI; i++) {
    const id = doc.order[i]!;
    const block = getBlock(working, id);
    if (!block || !isTextBearing(block)) continue;
    const blockLen = runsLength((block as TextBearingBlock).runs);
    const sOff = i === startI ? anchorOffset(start) : 0;
    const eOff = i === endI ? anchorOffset(end) : blockLen;
    if (sOff === eOff) continue;
    const runs = (block as TextBearingBlock).runs;
    const newRuns = applyMarkToSlice(runs, sOff, eOff, mark, attrs, add);
    working = updateBlock(working, {
      ...(block as TextBearingBlock),
      runs: newRuns,
    } as Block);
    wrote = true;
    // Formatting moves no characters, so no anchor needs mapping — but a
    // consumer persisting off `onChange` still has to learn the run split
    // happened, or it writes back a document with the mark missing.
    recordChange({
      kind: "format",
      blockId: id,
      container: containerOf(i === startI ? start : { blockId: id, path: [sOff], offset: sOff }),
      from: sOff,
      to: eOff,
      mark,
      added: add,
    });
  }
  if (!wrote) return false;
  docStore.set(working);
  return true;
}

function allHaveNone(
  doc: DocState,
  startI: number,
  endI: number,
  start: { path: number[]; offset: number },
  end: { path: number[]; offset: number },
  mark: MarkName,
): boolean {
  for (let i = startI; i <= endI; i++) {
    const block = getBlock(doc, doc.order[i]!);
    if (!block || !isTextBearing(block)) continue;
    const runs = (block as TextBearingBlock).runs;
    const sOff = i === startI ? anchorOffset(start as never) : 0;
    const eOff = i === endI ? anchorOffset(end as never) : runsLength(runs);
    let prefix = 0;
    for (const r of runs) {
      const rs = prefix;
      const re = prefix + r.text.length;
      prefix = re;
      if (re <= sOff || rs >= eOff) continue;
      if (r.marks?.has(mark)) return false;
    }
  }
  return true;
}

function sliceAllHasMark(
  runs: InlineRun[],
  start: number,
  end: number,
  mark: MarkName,
  attrs: MarkAttrs,
): boolean {
  let prefix = 0;
  for (const r of runs) {
    const rs = prefix;
    const re = prefix + r.text.length;
    prefix = re;
    if (re <= start || rs >= end) continue;
    if (!r.marks || !r.marks.has(mark)) return false;
    if (!attrsEqual(r.marks.get(mark)!, attrs)) return false;
  }
  return true;
}

function applyMarkToSlice(
  runs: InlineRun[],
  start: number,
  end: number,
  mark: MarkName,
  attrs: MarkAttrs,
  add: boolean,
): InlineRun[] {
  const [left, midRight] = splitRunsAt(runs, start);
  const [middle, right] = splitRunsAt(midRight, end - start);
  const newMiddle = middle.map((r) => withMark(r, mark, attrs, add));
  return normalizeRuns([...left, ...newMiddle, ...right]);
}

function withMark(
  run: InlineRun,
  mark: MarkName,
  attrs: MarkAttrs,
  add: boolean,
): InlineRun {
  const next = add
    ? markSetWith(run.marks, mark, attrs)
    : markSetWithout(run.marks, mark);
  // `attrs` (the run's view-only styling) is orthogonal to marks — carry it
  // through unchanged.
  const runAttrs = run.attrs ? { attrs: run.attrs } : {};
  if (next.size === 0) return { text: run.text, ...runAttrs };
  return { text: run.text, marks: next, ...runAttrs };
}
