// ---------------------------------------------------------------------------
// Cell-block views — table + columns. Moved from src/render/blocks/ as part
// of the cellsPlugin extraction. The DOM shape (data-cell="r:c", data-col,
// data-block-kind) is unchanged so the anchor codec walks find the right
// scopes.
// ---------------------------------------------------------------------------

import { div, table, tbody, td, tr, view } from "creo";
import type { ColumnsBlock, InlineRun, TableBlock } from "../../model/types";
import { InlineRunsView } from "../../render/InlineRunsView";

/**
 * Split a column's flat run list into one InlineRun[] per visual line. `\n`
 * characters in run text become line boundaries; runs spanning a `\n` are
 * split into per-line pieces preserving their marks. Empty lines are
 * rendered as empty arrays — InlineRunsView emits a ZWSP placeholder so the
 * line div retains measurable height (otherwise a trailing `\n` collapses
 * to zero-height in pre-wrap mode and the caret has nowhere to land).
 *
 * Mirrors `splitRunsByNewline` in CodeBlockView; the codec walks
 * `.ce-col-line` divs the same way `codeBlockCodec` walks `.ce-code-line`.
 */
function splitRunsByNewline(runs: InlineRun[]): InlineRun[][] {
  const lines: InlineRun[][] = [[]];
  for (const r of runs) {
    const parts = r.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i]!;
      if (text.length > 0) {
        const last = lines[lines.length - 1]!;
        last.push(r.marks ? { text, marks: r.marks } : { text });
      }
      if (i < parts.length - 1) lines.push([]);
    }
  }
  return lines;
}

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
              const lines = splitRunsByNewline(runs);
              for (let i = 0; i < lines.length; i++) {
                const lineRuns = lines[i]!;
                div({ class: "ce-col-line", key: i }, () => {
                  InlineRunsView({ runs: lineRuns });
                });
              }
            },
          );
        }
      },
    );
  },
}));
