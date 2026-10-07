import {
  insertImageFiles,
  type ImageInsertTarget,
  type UploadFn,
} from "../commands/imageCommands";

export type DropHandle = { destroy: () => void };

/**
 * Wire dragover + drop on the editor root so dragged image files become
 * image blocks. We only swallow the drop when at least one image file is
 * present; other drops fall through to the browser's default behaviour
 * (so dragging text from elsewhere keeps working).
 */
export function attachDrop(
  root: HTMLElement,
  /** The editor's dispatcher — dropped images insert as commands. */
  dispatch: ImageInsertTarget["dispatch"],
  upload?: UploadFn,
  /** Read-only gate — re-read per event so a thunk-valued `editable` works. */
  isEditable?: () => boolean,
): DropHandle {
  const editable = (): boolean => isEditable?.() !== false;
  let attached = true;
  const target: ImageInsertTarget = { dispatch, isLive: () => attached };
  const onDragOver = (e: Event) => {
    const ev = e as DragEvent;
    if (!editable()) return;
    if (!ev.dataTransfer) return;
    // Allow drop only when there's at least one image item.
    const items = ev.dataTransfer.items;
    let hasImage = false;
    if (items) {
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          hasImage = true;
          break;
        }
      }
    }
    if (hasImage) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (e: Event) => {
    const ev = e as DragEvent;
    if (!editable()) return;
    const files = ev.dataTransfer?.files;
    if (!files || files.length === 0) return;
    let hasImage = false;
    for (const f of Array.from(files)) {
      if (f.type.startsWith("image/")) {
        hasImage = true;
        break;
      }
    }
    if (!hasImage) return;
    ev.preventDefault();
    void insertImageFiles(target, files, upload);
  };

  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);

  return {
    destroy() {
      attached = false;
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("drop", onDrop);
    },
  };
}
