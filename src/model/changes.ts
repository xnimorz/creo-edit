// ---------------------------------------------------------------------------
// DocChange — a minimal, mappable description of what one command did.
//
// History is snapshot-based, which is fine for undo but useless to anything
// holding an `Anchor` from OUTSIDE the document: a review comment, an LSP
// diagnostic, a bookmark. Without a change description those anchors silently
// point at the wrong place after the next keystroke, and re-anchoring by
// searching for the original text is a heuristic that fails the moment two
// lines are identical.
//
// Granularity is deliberately per-block rather than a whole-document offset
// space — that is all the consumers need, and it keeps commands able to emit
// what they already know. The same shape is what LSP incremental sync wants
// for `didChange`, so a host can forward these straight through instead of
// resending the whole file on every keystroke.
//
// Commands emit into an ambient collector rather than threading a return
// value through every call site; `createEditor.dispatch` opens the collector
// around the command and hands the batch to `onChange` subscribers. Commands
// call each other freely (insertText → mergeBackward → insertText), and a
// nested call's changes land in the same batch in the order they happened.
// ---------------------------------------------------------------------------

import type { Anchor, BlockId } from "./types";

/**
 * One edit, in the block's own coordinate space.
 *
 * `container` addresses the runs slot within the block, matching the anchor
 * path minus its trailing character offset:
 *   - text-bearing (p / h* / li / code): `[]`
 *   - table cell:                        `[row, col]`
 *   - columns cell:                      `[col]`
 */
export type TextChange = {
  kind: "text";
  blockId: BlockId;
  container: number[];
  /** Character offsets within the container, BEFORE the edit. */
  from: number;
  to: number;
  /** Characters inserted in their place. */
  insertedLength: number;
};

/** `blockId` was split at `at`; everything from `at` onward now lives in
 *  `into`, a newly created block placed immediately after. */
export type SplitChange = {
  kind: "split";
  blockId: BlockId;
  at: number;
  into: BlockId;
};

/** `blockId` was consumed into `into`; its content now starts at `atOffset`
 *  of `into`. `blockId` no longer exists. */
export type MergeChange = {
  kind: "merge";
  blockId: BlockId;
  into: BlockId;
  atOffset: number;
};

export type InsertBlockChange = {
  kind: "insertBlock";
  blockId: BlockId;
  /** Position in `doc.order` the block was inserted at. */
  index: number;
};

export type RemoveBlockChange = {
  kind: "removeBlock";
  blockId: BlockId;
};

/**
 * The block's internal structure changed in a way no offset arithmetic can
 * describe — a table row inserted above the caret's row, a columns count
 * change. Anchors inside the block cannot be mapped and become null.
 *
 * This is the honest escape hatch: it is better for a host to learn its
 * anchor is unmappable than to receive a plausible wrong one.
 */
export type ResetBlockChange = {
  kind: "resetBlock";
  blockId: BlockId;
};

/** The whole document was replaced (setDoc / setDocFromHTML / undo / redo).
 *  No anchor survives. */
export type ReplaceDocChange = {
  kind: "replaceDoc";
};

export type DocChange =
  | TextChange
  | SplitChange
  | MergeChange
  | InsertBlockChange
  | RemoveBlockChange
  | ResetBlockChange
  | ReplaceDocChange;

// ---------------------------------------------------------------------------
// Ambient collector
// ---------------------------------------------------------------------------

const stack: DocChange[][] = [];

/**
 * Run `fn` with a fresh change collector. Nested calls append to the
 * innermost open collector, so a command that delegates to another command
 * produces one flat, ordered batch.
 */
export function collectChanges<T>(fn: () => T): {
  result: T;
  changes: DocChange[];
} {
  const batch: DocChange[] = [];
  stack.push(batch);
  try {
    const result = fn();
    return { result, changes: batch };
  } finally {
    stack.pop();
    // Nested collectors fold their changes into the enclosing one so an
    // outer dispatch still sees everything that happened.
    const parent = stack[stack.length - 1];
    if (parent) parent.push(...batch);
  }
}

/** Emit a change. A no-op when nothing is collecting (direct model use). */
export function recordChange(c: DocChange): void {
  stack[stack.length - 1]?.push(c);
}

/** Sugar for the common case: an edit at an anchor's container. */
export function recordTextChange(
  at: Anchor,
  from: number,
  to: number,
  insertedLength: number,
): void {
  if (stack.length === 0) return;
  if (from === to && insertedLength === 0) return;
  recordChange({
    kind: "text",
    blockId: at.blockId,
    container: containerOf(at),
    from,
    to,
    insertedLength,
  });
}

/** The runs slot an anchor addresses — its path minus the char offset. */
export function containerOf(at: Anchor): number[] {
  return at.path.length > 1 ? at.path.slice(0, -1) : [];
}

// ---------------------------------------------------------------------------
// mapAnchor
// ---------------------------------------------------------------------------

export type MapBias = "left" | "right";

function sameContainer(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function offsetOf(a: Anchor): number {
  return a.path.length > 0 ? a.path[a.path.length - 1]! : a.offset;
}

function withOffset(a: Anchor, blockId: BlockId, off: number): Anchor {
  const path = a.path.length > 1 ? [...a.path.slice(0, -1), off] : [off];
  return { blockId, path, offset: off };
}

/**
 * Move `anchor` through `changes`, in the order they were applied. Returns
 * null when the anchored position no longer exists — the text was deleted, the
 * block was removed, or the block's internal shape changed unmappably.
 *
 * `bias` decides what happens at an exact boundary: `"right"` (the default)
 * puts the anchor after text inserted at its position and follows a split into
 * the new block; `"left"` keeps it where it was. Pick `"left"` for something
 * anchored to the end of a region and `"right"` for the start of one.
 */
export function mapAnchor(
  anchor: Anchor,
  changes: readonly DocChange[],
  bias: MapBias = "right",
): Anchor | null {
  let cur: Anchor | null = anchor;
  for (const c of changes) {
    if (cur === null) return null;
    cur = applyOne(cur, c, bias);
  }
  return cur;
}

function applyOne(a: Anchor, c: DocChange, bias: MapBias): Anchor | null {
  switch (c.kind) {
    case "replaceDoc":
      return null;

    case "removeBlock":
      return a.blockId === c.blockId ? null : a;

    case "resetBlock":
      return a.blockId === c.blockId ? null : a;

    case "insertBlock":
      // Adding a block never moves an offset inside another block, and
      // anchors are block-id-relative rather than document-ordinal.
      return a;

    case "merge": {
      if (a.blockId !== c.blockId) return a;
      return withOffset(a, c.into, c.atOffset + offsetOf(a));
    }

    case "split": {
      if (a.blockId !== c.blockId) return a;
      // Only top-level text splits; a cell anchor can't be split this way.
      if (a.path.length > 1) return a;
      const off = offsetOf(a);
      if (off > c.at || (off === c.at && bias === "right")) {
        return withOffset(a, c.into, off - c.at);
      }
      return a;
    }

    case "text": {
      if (a.blockId !== c.blockId) return a;
      if (!sameContainer(containerOf(a), c.container)) return a;
      const off = offsetOf(a);
      const removed = c.to - c.from;
      if (off < c.from) return a;
      if (off === c.from) {
        // Pure insertion at exactly this point — bias picks a side. With a
        // deletion the anchor sits at the surviving left edge either way.
        if (removed === 0 && bias === "right") {
          return withOffset(a, a.blockId, off + c.insertedLength);
        }
        return a;
      }
      if (off >= c.to) {
        return withOffset(a, a.blockId, off + c.insertedLength - removed);
      }
      // Strictly inside the deleted span — the anchored text is gone.
      return null;
    }
  }
}
