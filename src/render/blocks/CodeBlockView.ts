import { div, pre, view, _ } from "creo";
import type { CodeBlock, InlineRun } from "../../model/types";
import { InlineRunsView } from "../InlineRunsView";

// Split a code block's flat run list into one InlineRun[] per line. Runs
// that contain `\n` are split into per-line pieces preserving their marks;
// empty lines are rendered as empty arrays (which InlineRunsView turns
// into a ZWSP placeholder so the line div has measurable height).
//
// The caret model treats `\n` as a real character at the END of every
// non-last line — this matches what `runs[].text` stores. measure.ts'
// code-block walker re-derives line lengths from this same shape.
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

// A code block renders as <pre data-block-id=…> containing one
// <div class="ce-code-line"> per line of the model's runs. Per-line block
// elements give the caret overlay measurable geometry on EVERY line
// (including empty ones — InlineRunsView emits a ZWSP for empty runs, so
// empty lines still have a non-zero bounding rect with the correct
// line-height).
//
// Styling (monospace font, boxed look, white-space:pre on children to
// preserve leading indent) is handled by the host stylesheet.
export const CodeBlockView = view<{ block: CodeBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    pre(
      {
        "data-block-id": b.id,
        "data-block-kind": "code",
        class: "ce-block ce-code-block",
        ...(b.lang ? { "data-lang": b.lang } : {}),
      },
      () => {
        const lines = splitRunsByNewline(b.runs);
        for (let i = 0; i < lines.length; i++) {
          const lineRuns = lines[i]!;
          div({ class: "ce-code-line", key: i }, () => {
            InlineRunsView({ runs: lineRuns });
          });
        }
      },
    );
    void _;
  },
}));
