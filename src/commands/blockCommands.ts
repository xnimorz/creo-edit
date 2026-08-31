// ---------------------------------------------------------------------------
// Block-level structural commands: move, insert-at, remove, upsert.
//
// These exist because the shipped decoration plugins (drag handle, add-block)
// were reaching past `dispatch` and calling `docStore.set()` by hand. That cost
// two things silently: the edit emitted no `DocChange`, so anything persisting
// off `editor.onChange` dropped it; and it pushed no history entry, so a drag
// reorder was not undoable.
//
// Going through commands buys both back, and gives a host a targeted-update
// path for externally-arriving changes that isn't "call `setDoc` and lose the
// selection and the undo stack".
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import { recordChange } from "../model/changes";
import {
  findPos,
  getBlock,
  insertManyAt,
  newBlockId,
  removeBlocks as docRemoveBlocks,
  updateBlock,
} from "../model/doc";
import { generateBetween } from "../model/fractional";
import { clampSelection } from "../controller/selection";
import type {
  Block,
  BlockId,
  BlockSpec,
  DocState,
  Selection,
} from "../model/types";

export type Stores = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
};

/** A block spec whose id is optional — the editor mints one when missing. */
export type BlockInput = Omit<BlockSpec, "id"> & { id?: BlockId };

export type MoveBlockPayload = {
  blockId: BlockId;
  /** Target position in `doc.order`, interpreted AFTER the block is lifted
   *  out — so moving block 0 to index 2 lands it third among the rest. */
  toIndex: number;
};

/**
 * Reorder one block. Its content and id are untouched; only its fractional
 * `index` is regenerated to sit between its new neighbours, which is what
 * keeps `doc.order` derivable from the blocks alone.
 */
export function moveBlock(
  { docStore }: Stores,
  { blockId, toIndex }: MoveBlockPayload,
): boolean {
  const doc = docStore.get();
  const from = findPos(doc, blockId);
  if (from < 0) return false;
  const block = doc.byId.get(blockId)!;

  const rest = doc.order.filter((id) => id !== blockId);
  const to = Math.max(0, Math.min(rest.length, toIndex));
  if (to === from) return false;

  const prevId = to === 0 ? null : rest[to - 1] ?? null;
  const nextId = to === rest.length ? null : rest[to] ?? null;
  const prevIdx = prevId ? doc.byId.get(prevId)!.index : null;
  const nextIdx = nextId ? doc.byId.get(nextId)!.index : null;
  let index: string;
  try {
    index = generateBetween(prevIdx, nextIdx);
  } catch {
    // No key fits between the neighbours — the caller can rebalance and retry
    // rather than get a corrupted order.
    return false;
  }

  const nextById = new Map(doc.byId);
  nextById.set(blockId, { ...block, index } as Block);
  const order = [...rest];
  order.splice(to, 0, blockId);
  docStore.set({ byId: nextById, order });
  recordChange({ kind: "moveBlock", blockId, from, to });
  return true;
}

export type InsertBlocksPayload = {
  blocks: BlockInput[];
  /** Exactly one of these positions. `at` is an index in `doc.order`;
   *  `before` / `after` are block ids. Defaults to end-of-doc. */
  at?: number;
  before?: BlockId;
  after?: BlockId;
};

/**
 * Insert blocks at a position, preserving every existing block's identity so
 * the renderer only mounts the new ones. Returns false when the anchor block
 * doesn't exist — a caller racing a concurrent delete gets a clean "no" rather
 * than an insert at a guessed position.
 */
export function insertBlocks(
  { docStore }: Stores,
  payload: InsertBlocksPayload,
): boolean {
  const doc = docStore.get();
  if (payload.blocks.length === 0) return false;
  let at: number;
  if (payload.before != null) {
    at = findPos(doc, payload.before);
    if (at < 0) return false;
  } else if (payload.after != null) {
    const i = findPos(doc, payload.after);
    if (i < 0) return false;
    at = i + 1;
  } else {
    at = Math.max(0, Math.min(doc.order.length, payload.at ?? doc.order.length));
  }
  const specs = payload.blocks.map(
    (b) => (b.id ? b : { ...b, id: newBlockId() }) as BlockSpec,
  );
  docStore.set(insertManyAt(doc, at, specs));
  specs.forEach((s, i) => {
    recordChange({ kind: "insertBlock", blockId: s.id!, index: at + i });
  });
  return true;
}

/** Remove blocks by id, clamping the selection onto whatever survives. */
export function removeBlocksCmd(
  { docStore, selStore }: Stores,
  blockIds: readonly BlockId[],
): boolean {
  const doc = docStore.get();
  const present = blockIds.filter((id) => doc.byId.has(id));
  if (present.length === 0) return false;
  const next = docRemoveBlocks(doc, present);
  docStore.set(next);
  for (const id of present) recordChange({ kind: "removeBlock", blockId: id });
  // The caret may have been sitting in one of them.
  selStore.set(clampSelection(next, selStore.get()));
  return true;
}

/**
 * Upsert blocks by id — the targeted-update path for changes arriving from
 * outside (a sync engine, an agent writing into the document). Blocks the
 * caller doesn't mention keep their identity, so the renderer re-renders only
 * what actually changed and the caret and undo stack both survive; that is the
 * whole difference from `setDoc`, which replaces the world.
 *
 * A spec with an unknown id is appended.
 */
export function replaceBlocks(
  { docStore, selStore }: Stores,
  blocks: readonly BlockInput[],
): boolean {
  if (blocks.length === 0) return false;
  const doc = docStore.get();
  let working = doc;
  const appended: BlockSpec[] = [];
  let changed = false;
  for (const spec of blocks) {
    const id = spec.id;
    const existing = id != null ? getBlock(working, id) : undefined;
    if (existing) {
      // Keep the existing fractional index — position is the caller's to
      // change through `moveBlock`, not a side effect of editing content.
      working = updateBlock(working, {
        ...(spec as object),
        id: existing.id,
        index: existing.index,
      } as Block);
      recordChange({ kind: "resetBlock", blockId: existing.id });
      changed = true;
    } else {
      appended.push((id ? spec : { ...spec, id: newBlockId() }) as BlockSpec);
    }
  }
  if (appended.length) {
    const at = working.order.length;
    working = insertManyAt(working, at, appended);
    appended.forEach((s, i) => {
      recordChange({ kind: "insertBlock", blockId: s.id!, index: at + i });
    });
    changed = true;
  }
  if (!changed) return false;
  docStore.set(working);
  selStore.set(clampSelection(working, selStore.get()));
  return true;
}
