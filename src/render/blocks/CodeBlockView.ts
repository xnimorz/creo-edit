import { marksEqual } from "../../model/marks";
import { div, pre, view, _ } from "creo";
import type { CodeBlock, InlineRun } from "../../model/types";
import { withRunText } from "../../model/blockText";
import { LINE_START_ATTR } from "../../plugin/anchorCodec";
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
        last.push(withRunText(r, text));
      }
      if (i < parts.length - 1) lines.push([]);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Per-line memo.
//
// The split above allocates a fresh array AND fresh run objects for every
// line in the file on every change to the block. Both memo guards downstream
// are identity checks (`InlineRunsView.shouldUpdate` on the runs array,
// `RunView.shouldUpdate` on the run), so a one-character edit handed them all
// new operands and re-rendered the whole file's view tree.
//
// So: keep the previous split, and wherever a line comes back byte-identical,
// hand the PREVIOUS array back instead of the new one. The identity guards
// then do the job they were written for and only the touched line renders.
//
// Line keys get the same treatment. Keyed by array index, inserting a line at
// the top renumbers every key below it and the reconciler treats the whole
// block as changed — so top-of-file editing was structurally more expensive
// than bottom-of-file editing. Keys are instead carried alongside the memo:
// an unchanged prefix and an unchanged suffix keep the keys they had, and
// only lines in the changed middle mint new ones.
// ---------------------------------------------------------------------------

type SplitMemo = {
  lines: InlineRun[][];
  keys: string[];
};

function runsEqual(a: InlineRun[], b: InlineRun[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (x.text !== y.text) return false;
    if (x.attrs?.class !== y.attrs?.class) return false;
    if (!marksEqual(x.marks, y.marks)) return false;
  }
  return true;
}

/**
 * Reconcile a freshly computed split against the previous one, reusing line
 * array references and keys wherever the line is unchanged.
 *
 * The match is prefix-then-suffix rather than a full diff: a text edit touches
 * one contiguous region, so the lines above and below it are exactly the
 * unchanged prefix and suffix. Everything between them is treated as new,
 * which is correct (if occasionally pessimistic) for a bulk replacement.
 */
function reconcileSplit(
  next: InlineRun[][],
  prev: SplitMemo | null,
  mintKey: () => string,
): SplitMemo {
  const keys: string[] = new Array(next.length);
  if (!prev) {
    for (let i = 0; i < next.length; i++) keys[i] = mintKey();
    return { lines: next, keys };
  }
  const prevLines = prev.lines;
  const max = Math.min(prevLines.length, next.length);

  let head = 0;
  while (head < max && runsEqual(prevLines[head]!, next[head]!)) {
    next[head] = prevLines[head]!;
    keys[head] = prev.keys[head]!;
    head++;
  }
  let tail = 0;
  while (
    tail < max - head &&
    runsEqual(
      prevLines[prevLines.length - 1 - tail]!,
      next[next.length - 1 - tail]!,
    )
  ) {
    const pi = prevLines.length - 1 - tail;
    const ni = next.length - 1 - tail;
    next[ni] = prevLines[pi]!;
    keys[ni] = prev.keys[pi]!;
    tail++;
  }
  for (let i = head; i < next.length - tail; i++) keys[i] = mintKey();
  return { lines: next, keys };
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
export const CodeBlockView = view<{ block: CodeBlock }>(({ props }) => {
  let memo: SplitMemo | null = null;
  let memoRuns: InlineRun[] | null = null;
  let keySeq = 0;
  const mintKey = () => `l${keySeq++}`;

  return {
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
          if (memoRuns !== b.runs || memo === null) {
            memo = reconcileSplit(splitRunsByNewline(b.runs), memo, mintKey);
            memoRuns = b.runs;
          }
          const lines = memo.lines;
          const keys = memo.keys;
          // Model offset of each line's first character. The split already
          // knows it, and publishing it turns the codec's "walk every line
          // adding up lengths" into a binary search — see LINE_START_ATTR in
          // plugin/anchorCodec.ts.
          let start = 0;
          for (let i = 0; i < lines.length; i++) {
            const lineRuns = lines[i]!;
            let len = 0;
            for (const r of lineRuns) len += r.text.length;
            div(
              {
                class: "ce-code-line",
                [LINE_START_ATTR]: String(start),
                key: keys[i]!,
              },
              () => {
                InlineRunsView({ runs: lineRuns });
              },
            );
            start += len + 1; // +1 for the implicit newline ending this line
          }
        },
      );
      void _;
    },
  };
});
