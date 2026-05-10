// ---------------------------------------------------------------------------
// navigate.ts — next/prev navigation + scroll-into-view that handles
// virtualized off-screen blocks AND hosts that lazily load chunks via
// `source.ensureLoaded`.
// ---------------------------------------------------------------------------

import type { BlockId, DocState } from "../../model/types";
import type { SearchMatch } from "./engine";
import type { SearchSource } from "./types";

export type EditorScrollHandle = {
  docStore: { get(): DocState };
  scrollToBlock(
    blockId: BlockId,
    opts?: { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior },
  ): void;
};

export async function jumpToMatch(
  editor: EditorScrollHandle,
  match: SearchMatch,
  source?: SearchSource,
): Promise<void> {
  const doc = editor.docStore.get();
  if (!doc.byId.has(match.blockId) && source?.ensureLoaded) {
    try {
      await source.ensureLoaded(match.blockId);
    } catch {
      // Host signaled it can't load — bail; UI stays put.
      return;
    }
  }
  editor.scrollToBlock(match.blockId, { block: "center", behavior: "smooth" });
}

export function nextIndex(current: number, total: number): number {
  if (total === 0) return -1;
  return (current + 1) % total;
}

export function prevIndex(current: number, total: number): number {
  if (total === 0) return -1;
  return (current - 1 + total) % total;
}
