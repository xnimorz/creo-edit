import type { Store } from "creo";
import type { DocState, Selection } from "../model/types";

/**
 * Snapshot-based undo/redo. We don't synthesize inverse commands — we just
 * stash the previous (doc, sel) before each mutation and let undo restore
 * it.
 *
 * Coalescing rule: consecutive ops with the SAME tag, within 500ms, whose tag
 * the coalesce policy accepts, collapse into a single undo entry. This matches
 * Notion / Google Docs UX — typing a sentence then hitting Cmd+Z removes the
 * whole sentence, not the last character.
 *
 * The policy comes from the plugin registry (`Registry.shouldCoalesce`), so a
 * plugin declaring `historyCoalescePrefixes: ["myPlugin:typing"]` gets the same
 * collapsing for its own streaming command. The default, used when no policy
 * is supplied, is the built-in `"text:"` prefix alone.
 */

export type HistoryEntry = {
  doc: DocState;
  sel: Selection;
  // Tag of the action that produced this entry — used to decide if the
  // *next* action coalesces with it.
  tag: string;
  ts: number;
};

export type HistoryStores = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
};

export const COALESCE_MS = 500;
export const HISTORY_CAP = 200;

/**
 * Second cap, in retained block slots rather than entries.
 *
 * An entry holds a whole `DocState`. Blocks are shared between versions, but
 * `byId` is a fresh `Map` per edit, so each entry pins one map of
 * `order.length` slots — measured at ~92 bytes each. On a document of one
 * block per line that is fine at 2 000 lines (≈37MB for a full 200-deep
 * history) and ruinous at 50 000: 250 distinct undo steps grew the heap by
 * 926MB in a direct measurement.
 *
 * So depth is bounded by cost as well as by count. 1.5M slots is ~140MB,
 * which buys the full 200 steps up to ~7 500 blocks and degrades gracefully
 * past that (≈30 steps at 50 000) instead of running the tab out of memory.
 * `MIN_ENTRIES` keeps undo usable no matter how large the document is.
 *
 * The real fix is for an entry to hold an inverse patch — the handful of
 * blocks the edit touched — rather than a whole document version, at which
 * point neither cap has to think about size. Until then, this is the bound.
 */
export const HISTORY_MAX_BLOCK_SLOTS = 1_500_000;
const MIN_ENTRIES = 10;

/** The coalescing policy. `Registry` satisfies this; tests can pass a stub or
 *  omit it entirely for the default "text:" behaviour. */
export type CoalescePolicy = { shouldCoalesce(tag: string): boolean };

const DEFAULT_COALESCE: CoalescePolicy = {
  shouldCoalesce: (tag) => tag.startsWith("text:"),
};

export function createHistory(
  stores: HistoryStores,
  coalescePolicy: CoalescePolicy = DEFAULT_COALESCE,
) {
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let pinned = false;

  /**
   * Record the CURRENT state with the given action tag. Call BEFORE
   * mutating. If the tag matches the previous entry and the time gap is
   * small, the previous entry is reused (no new undo step).
   */
  const record = (tag: string): void => {
    if (pinned) return;
    redoStack.length = 0; // any new edit invalidates the redo trail
    const top = undoStack[undoStack.length - 1];
    const now = Date.now();
    const coalesce =
      top != null &&
      top.tag === tag &&
      coalescePolicy.shouldCoalesce(tag) &&
      now - top.ts < COALESCE_MS;
    if (coalesce) {
      // Don't push another entry — the existing one's snapshot pre-dates
      // the keystroke chain.
      top.ts = now;
      return;
    }
    undoStack.push({
      doc: stores.docStore.get(),
      sel: stores.selStore.get(),
      tag,
      ts: now,
    });
    trim();
  };

  /** Drop the oldest entries until both caps are satisfied. */
  const trim = (): void => {
    while (undoStack.length > HISTORY_CAP) undoStack.shift();
    if (undoStack.length <= MIN_ENTRIES) return;
    let slots = 0;
    for (const e of undoStack) slots += e.doc.order.length;
    for (const e of redoStack) slots += e.doc.order.length;
    while (slots > HISTORY_MAX_BLOCK_SLOTS && undoStack.length > MIN_ENTRIES) {
      slots -= undoStack.shift()!.doc.order.length;
    }
  };

  const undo = (): boolean => {
    const entry = undoStack.pop();
    if (!entry) return false;
    pinned = true;
    redoStack.push({
      doc: stores.docStore.get(),
      sel: stores.selStore.get(),
      tag: entry.tag,
      ts: Date.now(),
    });
    stores.docStore.set(entry.doc);
    stores.selStore.set(entry.sel);
    pinned = false;
    return true;
  };

  const redo = (): boolean => {
    const entry = redoStack.pop();
    if (!entry) return false;
    pinned = true;
    undoStack.push({
      doc: stores.docStore.get(),
      sel: stores.selStore.get(),
      tag: entry.tag,
      ts: Date.now(),
    });
    stores.docStore.set(entry.doc);
    stores.selStore.set(entry.sel);
    pinned = false;
    return true;
  };

  /** Reset everything — used after a wholesale doc replacement. */
  const reset = (): void => {
    undoStack.length = 0;
    redoStack.length = 0;
  };

  return { record, undo, redo, reset };
}

export type History = ReturnType<typeof createHistory>;
