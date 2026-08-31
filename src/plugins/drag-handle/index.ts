// ---------------------------------------------------------------------------
// dragHandlePlugin — Notion-style "⋮⋮" handle in the left gutter of every
// block. Drag a block to reorder via fractional-index mutation.
//
// UX: pointer-down clones the block as a semi-transparent "ghost" that
// follows the cursor; the real block is dimmed in place; a blue drop-
// indicator line shows the insertion point under any hovered block;
// release commits the reorder via the doc store.
// ---------------------------------------------------------------------------

import { newBlockId } from "../../model/doc";
import { closestEditor } from "../../dom/editorRef";
import type {
  Block,
  BlockId,
  ColumnsBlock,
  DocState,
  InlineRun,
} from "../../model/types";
import type { CommandCtx, EditorPlugin } from "../../plugin/types";

// Both mutations below are registered COMMANDS rather than direct
// `docStore.set()` calls. Going through `dispatch` is what gives a drag its
// undo step and what puts a `DocChange` on `editor.onChange` — a reorder used
// to be invisible to both, so a host persisting off the change stream silently
// dropped every drag the user made.
const CMD_MOVE = "dragHandle.move";
const CMD_SIDE_DROP = "dragHandle.sideDrop";

type SideDropPayload = {
  draggedId: BlockId;
  targetId: BlockId;
  side: "left" | "right";
};

type DropPos = "before" | "after" | "left" | "right";

export type DragHandleOptions = {
  /** Show on hover only (default). When `false`, handles are always visible. */
  hoverOnly?: boolean;
};

export function dragHandlePlugin(
  opts: DragHandleOptions = {},
): EditorPlugin {
  const hoverOnly = opts.hoverOnly !== false;

  return {
    name: "drag-handle",
    commands: [
      {
        t: CMD_SIDE_DROP,
        run(ctx, payload) {
          const p = payload as SideDropPayload;
          const doc = ctx.docStore.get();
          const dragged = doc.byId.get(p.draggedId);
          const target = doc.byId.get(p.targetId);
          if (!dragged || !target) return false;
          return sideDrop(ctx, doc, dragged, target, p.side);
        },
      },
    ],
    decorations: [
      {
        id: "drag-handle",
        layer: "left",
        match: () => true,
        mount(block, blockEl, host, handle) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.setAttribute("aria-label", "Drag to reorder");
          btn.textContent = "⋮⋮";
          btn.className = "ce-drag-btn";
          // touchAction is functional (prevents browser scroll on touch
          // drag); cursor is functional (grab vs grabbing). Everything
          // else (color, size, opacity defaults) is in consumer CSS.
          btn.style.touchAction = "none";
          btn.style.cursor = "grab";

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

          // ---------------------------------------------------------------
          // Drag state
          // ---------------------------------------------------------------
          let dragging = false;
          let dragOver: BlockId | null = null;
          let dragOverPos: DropPos = "after";
          let indicator: HTMLElement | null = null;
          let ghost: HTMLElement | null = null;
          let ghostOffsetX = 0;
          let ghostOffsetY = 0;
          // Side zone: the leftmost / rightmost N pixels of a target trigger
          // a left-drop / right-drop (creates a columns block). Anywhere
          // else falls through to top/bottom reorder.
          const SIDE_ZONE_PX = 60;

          const ensureGhost = (sourceRect: DOMRect, clientX: number, clientY: number): void => {
            if (ghost) return;
            // Clone the block element so the ghost shows the actual block
            // content. data-block-* stripped so anchor lookups don't pick
            // up the ghost.
            const clone = blockEl.cloneNode(true) as HTMLElement;
            for (const el of Array.from(clone.querySelectorAll("[data-block-id]"))) {
              el.removeAttribute("data-block-id");
            }
            clone.removeAttribute("data-block-id");
            clone.removeAttribute("data-block-kind");
            clone.removeAttribute("contenteditable");
            clone.classList.add("ce-drag-ghost");
            // Functional positional styles only — appearance via CSS class.
            clone.style.position = "fixed";
            clone.style.top = `${sourceRect.top}px`;
            clone.style.left = `${sourceRect.left}px`;
            clone.style.width = `${sourceRect.width}px`;
            clone.style.pointerEvents = "none";
            clone.style.zIndex = "10001";
            document.body.appendChild(clone);
            ghost = clone;
            ghostOffsetX = clientX - sourceRect.left;
            ghostOffsetY = clientY - sourceRect.top;
          };

          const moveGhost = (clientX: number, clientY: number): void => {
            if (!ghost) return;
            ghost.style.left = `${clientX - ghostOffsetX}px`;
            ghost.style.top = `${clientY - ghostOffsetY}px`;
          };

          const showIndicator = (target: HTMLElement, pos: DropPos): void => {
            if (!indicator) {
              indicator = document.createElement("div");
              indicator.className = "ce-drag-indicator";
              indicator.style.position = "fixed";
              indicator.style.pointerEvents = "none";
              indicator.style.zIndex = "10000";
              document.body.appendChild(indicator);
            }
            const r = target.getBoundingClientRect();
            indicator.style.display = "";
            // Toggle horizontal vs. vertical orientation by class so the
            // host stylesheet can swap dimensions/colors per direction.
            indicator.classList.toggle("is-vertical", pos === "left" || pos === "right");
            if (pos === "before" || pos === "after") {
              indicator.style.top = `${(pos === "before" ? r.top : r.bottom) - 1}px`;
              indicator.style.left = `${r.left}px`;
              indicator.style.width = `${r.width}px`;
              indicator.style.height = "";
            } else {
              // Vertical bar at left or right edge.
              indicator.style.top = `${r.top}px`;
              indicator.style.left = `${(pos === "left" ? r.left : r.right) - 1}px`;
              indicator.style.width = "";
              indicator.style.height = `${r.height}px`;
            }
          };

          const hideIndicator = (): void => {
            if (indicator) indicator.style.display = "none";
          };

          const onMove = (e: PointerEvent): void => {
            if (!dragging) return;
            e.preventDefault();
            moveGhost(e.clientX, e.clientY);
            // Find target block under the pointer.
            const editorRoot = blockEl.closest("[data-creo-edit]") as HTMLElement | null;
            if (!editorRoot) return;
            // Hide the ghost briefly so elementFromPoint sees the underlying
            // editor content, then restore.
            const prevDisplay = ghost?.style.display ?? "";
            if (ghost) ghost.style.display = "none";
            const elUnder = document.elementFromPoint(e.clientX, e.clientY);
            if (ghost) ghost.style.display = prevDisplay;
            const targetBlock = elUnder?.closest("[data-block-kind]") as HTMLElement | null;
            if (!targetBlock || targetBlock === blockEl) {
              dragOver = null;
              hideIndicator();
              return;
            }
            const tid = targetBlock.getAttribute("data-block-id");
            if (!tid) return;
            const r = targetBlock.getBoundingClientRect();
            dragOver = tid;
            // Side-zone detection: leftmost / rightmost N pixels create a
            // columns block; everything else is a top/bottom reorder.
            const leftEdge = e.clientX - r.left;
            const rightEdge = r.right - e.clientX;
            if (leftEdge >= 0 && leftEdge < SIDE_ZONE_PX) {
              dragOverPos = "left";
            } else if (rightEdge >= 0 && rightEdge < SIDE_ZONE_PX) {
              dragOverPos = "right";
            } else {
              dragOverPos = e.clientY < r.top + r.height / 2 ? "before" : "after";
            }
            showIndicator(targetBlock, dragOverPos);
          };

          const cleanupDrag = (): void => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            ghost?.remove();
            ghost = null;
            indicator?.remove();
            indicator = null;
            dragOver = null;
          };

          const onUp = (e: PointerEvent): void => {
            if (!dragging) {
              cleanupDrag();
              return;
            }
            e.preventDefault();
            dragging = false;
            btn.style.cursor = "grab";
            blockEl.style.opacity = "";
            // Capture the target before cleanup nulls dragOver.
            const target = dragOver;
            const pos = dragOverPos;
            cleanupDrag();
            if (target && target !== block.id) {
              reorderTo(blockEl, block.id, target, pos);
            }
          };

          btn.addEventListener("pointerdown", (e) => {
            // Only respond to primary button.
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            btn.style.cursor = "grabbing";
            blockEl.style.opacity = "0.4";
            const r = blockEl.getBoundingClientRect();
            ensureGhost(r, e.clientX, e.clientY);
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
            document.addEventListener("pointercancel", onUp);
          });

          host.appendChild(btn);
          return () => {
            observer?.disconnect();
            cleanupDrag();
            blockEl.style.opacity = "";
          };
        },
      },
    ],
  };
}

/**
 * Move the dragged block to before/after the target (reorder) OR to the
 * left/right of the target (Notion-style: wraps target + dragged into a
 * `columns` block, or appends to an existing one).
 */
function reorderTo(
  blockEl: HTMLElement,
  draggedId: BlockId,
  targetId: BlockId,
  pos: DropPos,
): void {
  const editor = closestEditor(blockEl);
  if (!editor) return;
  const doc = editor.docStore.get();
  if (!doc.byId.has(draggedId) || !doc.byId.has(targetId)) return;
  if (pos === "left" || pos === "right") {
    editor.dispatch({
      t: CMD_SIDE_DROP,
      payload: { draggedId, targetId, side: pos } satisfies SideDropPayload,
    });
    return;
  }
  // Compute the target index in the order WITHOUT the dragged block, which is
  // the coordinate space `moveBlock` works in.
  const rest = doc.order.filter((id) => id !== draggedId);
  const tIdx = rest.indexOf(targetId);
  if (tIdx < 0) return;
  editor.dispatch({
    t: "moveBlock",
    payload: { blockId: draggedId, toIndex: pos === "before" ? tIdx : tIdx + 1 },
  });
}

/** Extract inline runs from a block. Text-bearing blocks return `runs`;
 *  other kinds (img / table / columns) flatten to an empty run set since
 *  the columns block model only stores `InlineRun[]` per cell. Callers
 *  that hand non-text blocks lose their structure here. */
function blockToRuns(block: Block): InlineRun[] {
  if ("runs" in block && Array.isArray((block as { runs?: InlineRun[] }).runs)) {
    return (block as Block & { runs: InlineRun[] }).runs;
  }
  return [];
}

/** Drop the dragged block onto the left/right of the target. If the target
 *  is already a columns block, append/prepend a new column from dragged.
 *  Otherwise wrap target+dragged into a fresh 2-column columns block. */
function sideDrop(
  ctx: CommandCtx,
  doc: DocState,
  draggedBlock: Block,
  targetBlock: Block,
  side: "left" | "right",
): boolean {
  const draggedRuns = blockToRuns(draggedBlock);
  // Build the new columns block content.
  let nextColumns: ColumnsBlock;
  if (targetBlock.type === "columns") {
    const tb = targetBlock as ColumnsBlock;
    const cells = side === "left"
      ? [draggedRuns, ...tb.cells]
      : [...tb.cells, draggedRuns];
    nextColumns = {
      ...tb,
      cols: cells.length,
      cells,
    };
  } else {
    const targetRuns = blockToRuns(targetBlock);
    const cells = side === "left" ? [draggedRuns, targetRuns] : [targetRuns, draggedRuns];
    nextColumns = {
      id: newBlockId(),
      // Reuse the target's index slot — the new columns block takes the
      // target's position in the order.
      index: targetBlock.index,
      type: "columns",
      cols: 2,
      cells,
    };
  }
  // Apply the doc mutation: remove dragged, replace target with the columns
  // block (or merge into existing columns block).
  const nextById = new Map(doc.byId);
  nextById.delete(draggedBlock.id);
  if (targetBlock.type === "columns") {
    nextById.set(targetBlock.id, nextColumns as unknown as Block);
  } else {
    nextById.delete(targetBlock.id);
    nextById.set(nextColumns.id, nextColumns as unknown as Block);
  }
  const nextOrder = doc.order
    .filter((id) => id !== draggedBlock.id)
    .map((id) => (id === targetBlock.id && targetBlock.type !== "columns" ? nextColumns.id : id));
  ctx.docStore.set({ byId: nextById, order: nextOrder });
  // The dragged block and (for a fresh wrap) the target are gone, replaced by
  // a columns block whose internal shape no anchor can be mapped into.
  ctx.change({ kind: "removeBlock", blockId: draggedBlock.id });
  if (targetBlock.type === "columns") {
    ctx.change({ kind: "resetBlock", blockId: nextColumns.id });
  } else {
    ctx.change({ kind: "removeBlock", blockId: targetBlock.id });
    ctx.change({
      kind: "insertBlock",
      blockId: nextColumns.id,
      index: nextOrder.indexOf(nextColumns.id),
    });
  }
  // Place the caret at the start of the dragged column.
  {
    const colIndex =
      targetBlock.type === "columns"
        ? side === "left"
          ? 0
          : (targetBlock as ColumnsBlock).cols
        : side === "left"
          ? 0
          : 1;
    ctx.selStore.set({
      kind: "caret",
      at: { blockId: nextColumns.id, path: [colIndex, 0], offset: 0 },
    });
  }
  return true;
}
