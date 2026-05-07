// ---------------------------------------------------------------------------
// addBlockPlugin — "+" button in the left gutter. Default behavior:
//
//   1. Click → open a "what to add?" menu anchored to the button
//   2. Pick → insert an empty block ABOVE the hovered block, place the
//      caret in it, and dispatch the chosen action (which usually changes
//      the block kind, applies a list, inserts a table, etc.)
//
// The menu uses the slash menu's mountSlashMenu UI so it's visually
// consistent across "/" trigger and "+" gutter button — but it does NOT
// require the slash plugin to be installed.
//
// Override with `onClick(block, blockEl)` to do something custom (e.g.
// open your own picker or directly insert a fixed block kind).
// ---------------------------------------------------------------------------

import { generateBetween } from "../../model/fractional";
import { newBlockId } from "../../model/doc";
import type {
  Block,
  BlockSpec,
  DocState,
  Selection,
} from "../../model/types";
import type { DispatchableCommand } from "../../createEditor";
import type { EditorPlugin } from "../../plugin/types";
import {
  defaultSlashItems,
  type SlashItem,
} from "../slash/items";
import { mountSlashMenu } from "../slash/menu";

export type AddBlockOptions = {
  /** Show on hover only (default). */
  hoverOnly?: boolean;
  /**
   * Custom click handler. When provided, replaces the default behavior of
   * opening the picker menu — useful for hosts that want a different UI
   * or that want to insert a fixed block kind without prompting.
   */
  onClick?: (block: Block, blockEl: HTMLElement) => void;
  /** Replace or extend the items shown in the picker. Defaults to the
   *  same set as the slash menu. */
  items?: SlashItem[];
};

export function addBlockPlugin(opts: AddBlockOptions = {}): EditorPlugin {
  const hoverOnly = opts.hoverOnly !== false;
  const items = opts.items ?? defaultSlashItems;

  return {
    name: "add-block",
    decorations: [
      {
        id: "add-block",
        layer: "left",
        match: () => true,
        mount(block, blockEl, host, handle) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.setAttribute("aria-label", "Insert block above");
          btn.textContent = "+";
          btn.className = "ce-add-block-btn";

          const updateVisibility = () => {
            if (!hoverOnly) {
              btn.classList.add("is-visible");
              return;
            }
            const hovered = handle.hoveredBlock() === block.id;
            btn.classList.toggle("is-visible", hovered);
          };
          let observer: MutationObserver | null = null;
          try {
            observer = new MutationObserver(updateVisibility);
            observer.observe(host, { attributes: true, attributeFilter: ["class"] });
          } catch {}
          updateVisibility();

          btn.addEventListener("click", (e) => {
            e.preventDefault();
            if (opts.onClick) {
              opts.onClick(block, blockEl);
              return;
            }
            openAddMenu(btn, blockEl, block.id, items);
          });

          host.appendChild(btn);
          return () => observer?.disconnect();
        },
      },
    ],
  };
}

function openAddMenu(
  btn: HTMLElement,
  blockEl: HTMLElement,
  beforeBlockId: string,
  items: SlashItem[],
): void {
  // The block element captured at mount may have been replaced by a
  // creo re-render; fall back to a fresh document-level lookup so the
  // editor reference stays reachable.
  let editorRoot = blockEl.closest("[data-creo-edit]") as HTMLElement | null;
  if (!editorRoot) {
    editorRoot = document.querySelector("[data-creo-edit]") as HTMLElement | null;
  }
  if (!editorRoot) return;
  const editor = (editorRoot as unknown as { __creoEdit?: {
    docStore: { get: () => DocState; set: (d: DocState) => void };
    selStore: { set: (s: Selection) => void };
    dispatch: (cmd: DispatchableCommand) => void;
  } }).__creoEdit;
  if (!editor) return;

  const r = btn.getBoundingClientRect();
  // Anchor the menu just to the right of the + button. Use a plain
  // DOMRect-shaped object instead of `new DOMRect(...)` because some
  // headless test envs (happy-dom) don't expose the constructor globally.
  const caretRect = {
    x: r.right + 4,
    y: r.top,
    width: 0,
    height: r.height,
    top: r.top,
    right: r.right + 4,
    bottom: r.top + r.height,
    left: r.right + 4,
    toJSON() { return this; },
  } as DOMRect;

  const menu = mountSlashMenu({
    items,
    caretRect,
    onPick: (it) => {
      // 1. Insert an empty paragraph ABOVE the hovered block.
      const newId = insertParagraphAbove(editor, beforeBlockId);
      if (!newId) {
        menu.destroy();
        return;
      }
      // 2. Place caret in the new paragraph.
      editor.selStore.set({
        kind: "caret",
        at: { blockId: newId, path: [0], offset: 0 },
      });
      // 3. Run the item's action — most items dispatch setBlockType /
      //    toggleList / insertTable etc. against the current selection,
      //    which is now the newly-inserted paragraph.
      const cmdCtx = {
        docStore: editor.docStore,
        selStore: editor.selStore,
        dispatch: editor.dispatch,
      };
      try {
        it.run(cmdCtx as never);
      } catch {
        // Item handler error — leave the empty paragraph in place.
      }
      menu.destroy();
    },
    onCancel: () => menu.destroy(),
  });

  // Close on Escape / click outside.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      menu.destroy();
      cleanup();
    } else {
      menu.handleKey(e);
    }
  };
  const onDocClick = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (!document.querySelector(".creo-slash")?.contains(target)) {
      menu.destroy();
      cleanup();
    }
  };
  const cleanup = (): void => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDocClick, true);
  };
  // Defer to next tick so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDocClick, true);
  }, 0);
}

/** Insert an empty paragraph immediately before `beforeBlockId`. Returns
 *  the new block's id, or null on failure. */
function insertParagraphAbove(
  editor: {
    docStore: { get: () => DocState; set: (d: DocState) => void };
  },
  beforeBlockId: string,
): string | null {
  const doc = editor.docStore.get();
  const idx = doc.order.indexOf(beforeBlockId);
  if (idx < 0) return null;
  const prevId = idx === 0 ? null : doc.order[idx - 1] ?? null;
  const prevIdx = prevId ? doc.byId.get(prevId)!.index : null;
  const nextIdx = doc.byId.get(beforeBlockId)!.index;
  let newIdx: string;
  try {
    newIdx = generateBetween(prevIdx, nextIdx);
  } catch {
    return null;
  }
  const newId = newBlockId();
  const newBlock: BlockSpec & { index: string } = {
    id: newId,
    type: "p",
    runs: [],
    index: newIdx,
  };
  const nextById = new Map(doc.byId);
  nextById.set(newId, newBlock as unknown as Block);
  const nextOrder = [...doc.order];
  nextOrder.splice(idx, 0, newId);
  editor.docStore.set({ byId: nextById, order: nextOrder });
  return newId;
}
