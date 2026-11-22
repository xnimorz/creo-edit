import type { Store } from "creo";
import { findPos, removeBlock } from "../model/doc";
import { recordChange } from "../model/changes";
import { caret } from "../controller/selection";
import { isAtomicBlockType } from "../plugin/atomic";
import type { DocState, Selection } from "../model/types";

export type Stores = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
};

export type UploadFn = (file: File) => Promise<string>;

/**
 * Pick an image source for a File. If `upload` is provided, await its URL;
 * otherwise fall back to `URL.createObjectURL`.
 */
export async function fileToImageSrc(
  file: File,
  upload?: UploadFn,
): Promise<string> {
  if (upload) return upload(file);
  return URL.createObjectURL(file);
}

/**
 * Where a pasted / dropped image lands once its source is known.
 *
 * The insert goes through the editor's dispatcher, not straight into the
 * stores: an upload can take seconds, and only `dispatch` records the undo
 * step, emits the `insertBlock` change and applies the read-only gate as they
 * stand *when the image arrives*. Writing `docStore` directly lost all three.
 */
export type ImageInsertTarget = {
  dispatch: (cmd: { t: "insertImage"; src: string; alt?: string }) => boolean;
  /**
   * Re-checked after each upload settles. False once the handler that
   * started the insert has been torn down (`editor.destroy()`), so a late
   * upload does not write into a dead editor.
   */
  isLive?: () => boolean;
};

/**
 * Drop / paste a single File into the editor as an image block. Async
 * (must await an upload when configured). A failed upload is reported and
 * resolves `false` — callers fire-and-forget this from event handlers, so a
 * rejection here would be unhandled.
 */
export async function insertImageFile(
  target: ImageInsertTarget,
  file: File,
  upload?: UploadFn,
): Promise<boolean> {
  if (!file.type.startsWith("image/")) return false;
  let src: string;
  try {
    src = await fileToImageSrc(file, upload);
  } catch (err) {
    console.error(`creo-edit: image upload failed for "${file.name}"`, err);
    return false;
  }
  if (target.isLive?.() === false) return false;
  return target.dispatch({ t: "insertImage", src, alt: file.name });
}

/**
 * Process a FileList (from paste or drop). Each image becomes its own block;
 * non-image files are ignored, and one failed upload does not stop the rest.
 */
export async function insertImageFiles(
  target: ImageInsertTarget,
  files: FileList | File[],
  upload?: UploadFn,
): Promise<boolean> {
  let any = false;
  const list = Array.from(files);
  for (const f of list) {
    if (!f.type.startsWith("image/")) continue;
    if (await insertImageFile(target, f, upload)) any = true;
  }
  return any;
}

/**
 * Delete the atomic block currently under the caret, or the one a node
 * selection covers. The caret lands at the start of whatever block survives
 * in that slot — preferring the next sibling, then the previous, then the
 * first remaining block.
 */
export function deleteSelectedAtomic(stores: Stores): boolean {
  const id = atomicUnderSelection(stores.docStore.get(), stores.selStore.get());
  return id === null ? false : deleteAtomicBlock(stores, id);
}

export function deleteAtomicBlock(stores: Stores, blockId: string): boolean {
  const doc = stores.docStore.get();
  const block = doc.byId.get(blockId);
  if (!block || !isAtomicBlockType(block.type)) return false;
  const i = findPos(doc, block.id);
  const next = removeBlock(doc, block.id);
  stores.docStore.set(next);
  recordChange({ kind: "removeBlock", blockId: block.id });
  const newId = next.order[i] ?? next.order[i - 1] ?? next.order[0];
  stores.selStore.set(caret({ blockId: newId ?? "", path: [0], offset: 0 }));
  return true;
}

/** The atomic block a caret sits on, or that a node selection covers. */
export function atomicUnderSelection(doc: DocState, sel: Selection): string | null {
  const id = sel.kind === "caret" ? sel.at.blockId : nodeSelectedBlock(doc, sel);
  if (id === null) return null;
  const block = doc.byId.get(id);
  return block && isAtomicBlockType(block.type) ? id : null;
}

/**
 * The atomic block a selection covers exactly — from one side of it to the
 * other — or null. That is what "the block is selected" means for a block
 * with no text inside.
 */
export function nodeSelectedBlock(doc: DocState, sel: Selection): string | null {
  if (sel.kind !== "range" || sel.anchor.blockId !== sel.focus.blockId) return null;
  const block = doc.byId.get(sel.anchor.blockId);
  if (!block || !isAtomicBlockType(block.type)) return null;
  const a = sel.anchor.path[0] ?? 0;
  const f = sel.focus.path[0] ?? 0;
  return a !== f ? block.id : null;
}

/** Select an atomic block whole. */
export function nodeSelection(blockId: string): Selection {
  return {
    kind: "range",
    anchor: { blockId, path: [0], offset: 0 },
    focus: { blockId, path: [1], offset: 1 },
  };
}

/** Backwards-compatible alias — img used to be the only atomic block. */
export const deleteSelectedImage = deleteSelectedAtomic;
