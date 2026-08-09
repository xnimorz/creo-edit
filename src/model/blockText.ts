import type { Block, InlineRun, Mark, RunAttrs } from "./types";

/** Blocks whose content is a single InlineRun[] (paragraphs, headings, list items). */
export type TextBearingBlock = Extract<
  Block,
  { runs: InlineRun[] }
>;

export function isTextBearing(block: Block): block is TextBearingBlock {
  return (
    block.type === "p" ||
    block.type === "h1" ||
    block.type === "h2" ||
    block.type === "h3" ||
    block.type === "h4" ||
    block.type === "h5" ||
    block.type === "h6" ||
    block.type === "li" ||
    block.type === "code"
  );
}

/** Total length of plain text across all runs of a text-bearing block. */
export function runsLength(runs: InlineRun[]): number {
  let n = 0;
  for (const r of runs) n += r.text.length;
  return n;
}

export function blockTextLength(block: TextBearingBlock): number {
  return runsLength(block.runs);
}

/** Concatenated text of a run list. */
export function runsText(runs: InlineRun[]): string {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

/**
 * Plain text of any block, exactly as the anchor model counts characters:
 * a text-bearing block is its runs concatenated (so a `code` block's `\n`s
 * come through as themselves), cells are joined by `\t` and table rows by
 * `\n`, and atomic blocks contribute nothing.
 *
 * This is the model-side read that `editor.getText()` is built on — no DOM,
 * no serialization codecs, no escaping.
 */
export function blockTextOf(block: Block): string {
  if (isTextBearing(block)) return runsText(block.runs);
  if (block.type === "table") {
    const rows: string[] = [];
    for (let r = 0; r < block.rows; r++) {
      const cols: string[] = [];
      for (let c = 0; c < block.cols; c++) {
        cols.push(runsText(block.cells[r]?.[c] ?? []));
      }
      rows.push(cols.join("\t"));
    }
    return rows.join("\n");
  }
  if (block.type === "columns") {
    const cols: string[] = [];
    for (let c = 0; c < block.cols; c++) cols.push(runsText(block.cells[c] ?? []));
    return cols.join("\t");
  }
  return "";
}

function marksEqual(
  a: ReadonlySet<Mark> | undefined,
  b: ReadonlySet<Mark> | undefined,
): boolean {
  if (a === b) return true;
  const an = a ? a.size : 0;
  const bn = b ? b.size : 0;
  if (an !== bn) return false;
  if (an === 0) return true;
  for (const m of a!) if (!b!.has(m)) return false;
  return true;
}

function attrsEqual(
  a: RunAttrs | undefined,
  b: RunAttrs | undefined,
): boolean {
  if (a === b) return true;
  // `class` is the only field today; compare it structurally so two distinct
  // objects describing the same styling still merge.
  return (a?.class ?? undefined) === (b?.class ?? undefined);
}

/**
 * Re-slice a run to different text, carrying its marks AND its view-only
 * `attrs` across. Every splice/split path goes through this so a syntax
 * token's class survives an edit inside the run.
 */
export function withRunText(run: InlineRun, text: string): InlineRun {
  return {
    text,
    ...(run.marks ? { marks: run.marks } : {}),
    ...(run.attrs ? { attrs: run.attrs } : {}),
  };
}

/**
 * Normalize: drop empty runs and merge adjacent runs whose marks AND attrs
 * match. Always returns a fresh array.
 */
export function normalizeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const r of runs) {
    if (r.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && marksEqual(last.marks, r.marks) && attrsEqual(last.attrs, r.attrs)) {
      out[out.length - 1] = withRunText(last, last.text + r.text);
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Find the run + local offset that owns the given character position.
 * `offset` is clamped to [0, runsLength].
 *
 * The "boundary" rule: if `offset` lands exactly between two runs, we report
 * `runIndex` = the index of the run that *ends* at that boundary (so callers
 * inserting text inherit the LEFT run's marks by default).
 */
export type RunPos = {
  runIndex: number; // -1 when offset === 0 and there are no runs
  localOffset: number;
  /** Aggregate length of all runs strictly before runIndex. */
  prefixLen: number;
};

export function locateRun(runs: InlineRun[], offset: number): RunPos {
  if (runs.length === 0) {
    return { runIndex: -1, localOffset: 0, prefixLen: 0 };
  }
  if (offset <= 0) {
    return { runIndex: 0, localOffset: 0, prefixLen: 0 };
  }
  let prefix = 0;
  for (let i = 0; i < runs.length; i++) {
    const len = runs[i]!.text.length;
    if (offset <= prefix + len) {
      return { runIndex: i, localOffset: offset - prefix, prefixLen: prefix };
    }
    prefix += len;
  }
  // Past the end — clamp to last run.
  const last = runs.length - 1;
  return {
    runIndex: last,
    localOffset: runs[last]!.text.length,
    prefixLen: prefix - runs[last]!.text.length,
  };
}

/** Marks the next inserted character should inherit at `offset`. */
export function marksAt(
  runs: InlineRun[],
  offset: number,
): ReadonlySet<Mark> | undefined {
  // At absolute start (or empty) there is nothing to inherit — check first so
  // the common start-of-block insert skips the run scan entirely.
  if (offset === 0 || runs.length === 0) return undefined;
  return runs[locateRun(runs, offset).runIndex]!.marks;
}

/**
 * Insert `text` (with optional `marks`) at character `offset`.
 * Returns a new runs array.
 */
export function insertText(
  runs: InlineRun[],
  offset: number,
  text: string,
  marks?: ReadonlySet<Mark>,
): InlineRun[] {
  if (text.length === 0) return runs;
  const pos = locateRun(runs, offset);

  // Build the output: [unchanged runs before pos] + split run + [unchanged after]
  const out: InlineRun[] = [];
  for (let i = 0; i < pos.runIndex; i++) out.push(runs[i]!);

  // Reuse the run we already located rather than re-scanning via marksAt.
  const host = offset === 0 || pos.runIndex < 0 ? undefined : runs[pos.runIndex]!;
  const inheritMarks = marks ?? host?.marks;
  // `attrs` only rides along when the caller didn't dictate marks — an
  // explicit `marks` argument means the text came from elsewhere (paste,
  // markdown shortcut) and shouldn't inherit the host run's derived styling.
  const inheritAttrs = marks ? undefined : host?.attrs;
  const newRun: InlineRun = {
    text,
    ...(inheritMarks && inheritMarks.size ? { marks: inheritMarks } : {}),
    ...(inheritAttrs ? { attrs: inheritAttrs } : {}),
  };

  if (pos.runIndex === -1) {
    // Empty runs: just emit the new run.
    out.push(newRun);
  } else {
    const r = runs[pos.runIndex]!;
    const left = r.text.slice(0, pos.localOffset);
    const right = r.text.slice(pos.localOffset);
    if (left.length) out.push(withRunText(r, left));
    out.push(newRun);
    if (right.length) out.push(withRunText(r, right));
    for (let i = pos.runIndex + 1; i < runs.length; i++) out.push(runs[i]!);
  }
  return normalizeRuns(out);
}

/** Delete characters in [start, end). Returns a new runs array. */
export function deleteRange(
  runs: InlineRun[],
  start: number,
  end: number,
): InlineRun[] {
  if (start >= end) return runs;
  const total = runsLength(runs);
  const s = Math.max(0, Math.min(total, start));
  const e = Math.max(0, Math.min(total, end));
  if (s === e) return runs;
  if (s === 0 && e === total) return [];

  const out: InlineRun[] = [];
  let prefix = 0;
  for (const r of runs) {
    const rs = prefix;
    const re = prefix + r.text.length;
    if (re <= s || rs >= e) {
      out.push(r);
    } else {
      const keepLeft = Math.max(0, s - rs);
      const keepRightStart = Math.max(0, e - rs);
      const left = r.text.slice(0, keepLeft);
      const right = r.text.slice(keepRightStart);
      const txt = left + right;
      if (txt.length) out.push(withRunText(r, txt));
    }
    prefix = re;
  }
  return normalizeRuns(out);
}

/** Split runs at offset into [left, right] arrays. */
export function splitRunsAt(
  runs: InlineRun[],
  offset: number,
): [InlineRun[], InlineRun[]] {
  const total = runsLength(runs);
  const o = Math.max(0, Math.min(total, offset));
  if (o === 0) return [[], runs.slice()];
  if (o === total) return [runs.slice(), []];
  const pos = locateRun(runs, o);
  const left: InlineRun[] = [];
  const right: InlineRun[] = [];
  for (let i = 0; i < pos.runIndex; i++) left.push(runs[i]!);
  const r = runs[pos.runIndex]!;
  const lText = r.text.slice(0, pos.localOffset);
  const rText = r.text.slice(pos.localOffset);
  if (lText.length) left.push(withRunText(r, lText));
  if (rText.length) right.push(withRunText(r, rText));
  for (let i = pos.runIndex + 1; i < runs.length; i++) right.push(runs[i]!);
  return [normalizeRuns(left), normalizeRuns(right)];
}

/** Concatenate two runs arrays, normalizing the seam. */
export function concatRuns(a: InlineRun[], b: InlineRun[]): InlineRun[] {
  return normalizeRuns([...a, ...b]);
}
