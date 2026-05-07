// ---------------------------------------------------------------------------
// Hover/focus-revealed controls for table + columns blocks. Lets users add
// and remove rows / columns without memorising slash commands. Both
// decorations mount a small floating toolbar above their block; visibility
// is driven by hover state OR by the caret being inside the block, so the
// toolbar stays open while the user is actively editing a cell.
// ---------------------------------------------------------------------------

import type { ColumnsBlock, DocState, Selection, TableBlock } from "../../model/types";
import type { DecorationDef } from "../../plugin/types";
import type { DispatchableCommand } from "../../createEditor";

type EditorRef = {
  docStore: { get: () => DocState; set: (d: DocState) => void };
  selStore: { get: () => Selection; set: (s: Selection) => void; subscribe?: (fn: () => void) => () => void };
  dispatch: (cmd: DispatchableCommand) => void;
};

function findEditor(blockEl: HTMLElement): EditorRef | null {
  const root = blockEl.closest("[data-creo-edit]") as HTMLElement | null;
  if (!root) return null;
  return (root as unknown as { __creoEdit?: EditorRef }).__creoEdit ?? null;
}

function makeButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ce-cells-ctl";
  b.textContent = label;
  b.setAttribute("aria-label", title);
  b.title = title;
  // Block focus changes: clicking a control shouldn't move the caret away
  // from the cell the user was editing.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

function selectionBlockId(sel: Selection): string | null {
  return sel.kind === "caret" ? sel.at.blockId : sel.anchor.blockId;
}

/**
 * Mount a hover/focus-revealed toolbar above the block. The bar is hidden
 * unless: (a) the block is hovered, (b) the toolbar itself is hovered, or
 * (c) the caret is inside the block. Returns a cleanup function.
 */
function mountToolbar(
  blockId: string,
  host: HTMLElement,
  buttons: HTMLButtonElement[],
  editor: EditorRef,
  hoveredBlock: () => string | null,
  // The decoration manager observes class changes on `host` to surface
  // hover state via `is-hovered`. We hand the same host down so we can
  // observe the same class flip.
  observeTarget: HTMLElement,
): () => void {
  // The decoration container fills the whole block rect with
  // pointer-events: auto, which would block clicks on cell content. Disable
  // pointer events on the container and re-enable them on the toolbar so
  // only the toolbar itself is interactive.
  host.style.pointerEvents = "none";

  const bar = document.createElement("div");
  bar.className = "ce-cells-toolbar";
  bar.style.position = "absolute";
  bar.style.top = "-32px";
  bar.style.right = "0";
  bar.style.pointerEvents = "auto";
  bar.style.display = "none";
  for (const b of buttons) bar.appendChild(b);
  host.appendChild(bar);

  let pointerOnBar = false;

  const isCaretInBlock = (): boolean => {
    const sel = editor.selStore.get();
    return selectionBlockId(sel) === blockId;
  };

  const updateVisibility = (): void => {
    const visible =
      pointerOnBar ||
      hoveredBlock() === blockId ||
      isCaretInBlock();
    bar.style.display = visible ? "flex" : "none";
  };

  bar.addEventListener("pointerenter", () => {
    pointerOnBar = true;
    updateVisibility();
  });
  bar.addEventListener("pointerleave", () => {
    pointerOnBar = false;
    updateVisibility();
  });

  // Observe the deco container's class changes (the manager toggles
  // `is-hovered` when the editor pointer enters this block).
  let observer: MutationObserver | null = null;
  try {
    observer = new MutationObserver(updateVisibility);
    observer.observe(observeTarget, {
      attributes: true,
      attributeFilter: ["class"],
    });
  } catch {}

  // Listen to selection changes so the toolbar stays open while the user is
  // typing inside the block. selectionchange on document is the cheapest
  // signal that fires for caret moves.
  const onSelChange = (): void => updateVisibility();
  document.addEventListener("selectionchange", onSelChange);

  updateVisibility();

  return () => {
    observer?.disconnect();
    document.removeEventListener("selectionchange", onSelChange);
    bar.remove();
  };
}

// ---------------------------------------------------------------------------
// Table controls
// ---------------------------------------------------------------------------

export const tableControlsDecoration: DecorationDef = {
  id: "table-controls",
  layer: "top",
  match: (b) => b.type === "table",
  mount(block, blockEl, host, handle) {
    const editor = findEditor(blockEl);
    if (!editor) return;
    const tb = block as TableBlock;
    void tb;

    const addRow = makeButton("+ Row", "Add row at the end");
    addRow.addEventListener("click", () => {
      editor.dispatch({
        t: "table.insertRow",
        payload: { blockId: block.id, where: "end" },
      });
    });

    const removeRow = makeButton("− Row", "Remove the last row");
    removeRow.addEventListener("click", () => {
      const cur = editor.docStore.get().byId.get(block.id) as TableBlock | undefined;
      if (!cur) return;
      editor.dispatch({
        t: "table.removeRow",
        payload: { blockId: block.id, row: cur.rows - 1 },
      });
    });

    const addCol = makeButton("+ Col", "Add column at the end");
    addCol.addEventListener("click", () => {
      editor.dispatch({
        t: "table.insertCol",
        payload: { blockId: block.id, where: "end" },
      });
    });

    const removeCol = makeButton("− Col", "Remove the last column");
    removeCol.addEventListener("click", () => {
      const cur = editor.docStore.get().byId.get(block.id) as TableBlock | undefined;
      if (!cur) return;
      editor.dispatch({
        t: "table.removeCol",
        payload: { blockId: block.id, col: cur.cols - 1 },
      });
    });

    return mountToolbar(
      block.id,
      host,
      [addRow, removeRow, addCol, removeCol],
      editor,
      () => handle.hoveredBlock(),
      host,
    );
  },
};

// ---------------------------------------------------------------------------
// Columns controls
// ---------------------------------------------------------------------------

export const columnsControlsDecoration: DecorationDef = {
  id: "columns-controls",
  layer: "top",
  match: (b) => b.type === "columns",
  mount(block, blockEl, host, handle) {
    const editor = findEditor(blockEl);
    if (!editor) return;

    const addCol = makeButton("+ Col", "Add column at the end");
    addCol.addEventListener("click", () => {
      editor.dispatch({
        t: "columns.insertCol",
        payload: { blockId: block.id, where: "end" },
      });
    });

    const removeCol = makeButton("− Col", "Remove the last column");
    removeCol.addEventListener("click", () => {
      const cur = editor.docStore.get().byId.get(block.id) as ColumnsBlock | undefined;
      if (!cur) return;
      editor.dispatch({
        t: "columns.removeCol",
        payload: { blockId: block.id, col: cur.cols - 1 },
      });
    });

    return mountToolbar(
      block.id,
      host,
      [addCol, removeCol],
      editor,
      () => handle.hoveredBlock(),
      host,
    );
  },
};
