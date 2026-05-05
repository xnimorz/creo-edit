// ---------------------------------------------------------------------------
// Cell-block views — table + columns. Moved from src/render/blocks/ as part
// of the cellsPlugin extraction. The DOM shape (data-cell="r:c", data-col,
// data-block-kind) is unchanged so the anchor codec walks find the right
// scopes.
// ---------------------------------------------------------------------------

import { div, table, tbody, td, tr, view } from "creo";
import type { ColumnsBlock, TableBlock } from "../../model/types";
import { InlineRunsView } from "../../render/InlineRunsView";

/**
 * Render a TableBlock as <table><tbody> with keyed rows + cells.
 *
 * NOTE: intermediate primitives (tbody, tr) get FRESH prop objects each
 * render, not the `_` no-props constant. The reconciler skips descent
 * when an intermediate primitive's props are reference-equal to the
 * previous render — using `_` everywhere causes that shortcut to fire
 * and changes inside cells (e.g. typed text) never make it to the DOM.
 */
export const TableViewPlugin = view<{ block: TableBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    table(
      {
        "data-block-id": b.id,
        "data-block-kind": "table",
        class: "ce-block ce-table",
      },
      () => {
        tbody({}, () => {
          for (let r = 0; r < b.rows; r++) {
            tr({ key: `r${r}`, "data-row": String(r) }, () => {
              for (let c = 0; c < b.cols; c++) {
                const runs = b.cells[r]?.[c] ?? [];
                td(
                  {
                    key: `${r}-${c}`,
                    class: "ce-cell",
                    "data-block-id": b.id,
                    "data-cell": `${r}:${c}`,
                  },
                  () => {
                    InlineRunsView({ runs });
                  },
                );
              }
            });
          }
        });
      },
    );
  },
}));

/**
 * Render a ColumnsBlock as a flex row of equal-width column divs. Each
 * column carries `data-block-id` (so caret-overlay queries find the owner)
 * AND `data-col="<index>"` so pointToAnchor can reconstruct the column.
 */
export const ColumnsViewPlugin = view<{ block: ColumnsBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    div(
      {
        "data-block-id": b.id,
        "data-block-kind": "columns",
        class: "ce-block ce-columns",
        style: `display:grid;grid-template-columns:repeat(${b.cols},1fr);gap:16px;`,
      },
      () => {
        for (let c = 0; c < b.cols; c++) {
          const runs = b.cells[c] ?? [];
          div(
            {
              key: `col-${c}`,
              class: "ce-col",
              "data-block-id": b.id,
              "data-col": String(c),
              style: "min-width:0;",
            },
            () => {
              InlineRunsView({ runs });
            },
          );
        }
      },
    );
  },
}));
