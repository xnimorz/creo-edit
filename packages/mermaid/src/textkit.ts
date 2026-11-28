// ---------------------------------------------------------------------------
// Text kits — what the kits that write the source themselves share.
//
// Visimer knows a flowchart's grammar and compiles "rename A" to the letters
// that change. For a mind map and a timeline it only knows lines (replace
// one, append one, delete one), which cannot say "an idea under this one" or
// "this period's second event". Those types' kits (`mindmap.ts`,
// `timeline.ts`, `gantt.ts`) read the source themselves and return the text
// edits; the session applies them where visimer's own would go.
//
// Three rules they keep:
//
//   - An edit is the least text that says it. The source is merged as text
//     by a host whose documents are edited by several people at once, so a
//     rename changes the name's letters, a status a word, and nothing
//     rewrites a line it only meant to touch.
//   - An operation is compiled when it runs, against the source as it then
//     is, never from offsets an entity was read with earlier.
//   - An entity's id is its LINE (`idea:4`, `event:6:1`). Nothing in these
//     sources names a thing but where it is. `remapLine` carries such an id
//     over a change of the source made by someone else.
// ---------------------------------------------------------------------------

import type { Entity, VisimerResult } from "./kits";

export type TextEdit = { start: number; end: number; text: string };

/** A line of the source, as visimer scans it. */
export type Line = {
  index: number;
  /** "statement", "header", "blank", "comment", "directive", "frontmatter". */
  kind: string;
  /** Without its newline. */
  text: string;
  start: number;
  end: number;
  /** Leading whitespace. */
  indent: string;
};

export type Compiled = { edits: TextEdit[]; created?: string[] };

/** An operation a kit compiles itself: the edits for the source as it is
 *  now, or null when it does not apply. */
export type TextOp = (result: VisimerResult) => Compiled | null;

export const linesOf = (r: VisimerResult): Line[] =>
  Array.isArray(r.lines) ? (r.lines as Line[]) : [];

export const codeOf = (r: VisimerResult): string =>
  typeof r.code === "string" ? r.code : "";

/** The header line (`mindmap`, `gantt`…), or null. */
export function headerOf(r: VisimerResult): Line | null {
  const i = typeof r.headerIndex === "number" ? r.headerIndex : -1;
  return linesOf(r)[i] ?? null;
}

/** The lines that say something: after the header, and neither blank nor a
 *  comment. */
export function statements(r: VisimerResult): Line[] {
  const header = headerOf(r);
  if (!header) return [];
  return linesOf(r).filter((l) => l.index > header.index && l.kind === "statement");
}

/** Remove whole lines `from`…`to`, with one of the newlines around them. */
export function removeLines(r: VisimerResult, from: number, to: number): TextEdit | null {
  const lines = linesOf(r);
  const a = lines[from];
  const b = lines[to];
  if (!a || !b) return null;
  if (b.end < codeOf(r).length) return { start: a.start, end: b.end + 1, text: "" };
  return { start: Math.max(0, a.start - 1), end: b.end, text: "" };
}

/**
 * The one edit that turns `before` into `after`: what they begin and end
 * with alike is kept. For a change that moves lines about, where no smaller
 * edit says it.
 */
export function diffEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;
  let start = 0;
  const min = Math.min(before.length, after.length);
  while (start < min && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < min - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  return { start, end: before.length - tail, text: after.slice(start, after.length - tail) };
}

/** A new line, `text`, after `line`. */
export const lineAfter = (line: Line, text: string): TextEdit => ({
  start: line.end,
  end: line.end,
  text: `\n${text}`,
});

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** The line an id of a text kit is on (`idea:4` → 4, `event:6:1` → 6). */
export function lineOfId(id: string): number | null {
  const m = /^[a-z]+:(\d+)/.exec(id);
  return m ? Number(m[1]) : null;
}

/** The same id on another line. */
export const idOnLine = (id: string, line: number): string =>
  id.replace(/^([a-z]+:)\d+/, `$1${line}`);

/**
 * Where line `line` of `before` is in `after`, or null when it is gone.
 *
 * The lines the two sources begin and end with alike are the same lines; one
 * between them is the same line only if nothing was added or taken out
 * there (a line someone else rewrote is still that line).
 */
export function remapLine(before: string, after: string, line: number): number | null {
  if (before === after) return line;
  const a = before.split("\n");
  const b = after.split("\n");
  const min = Math.min(a.length, b.length);
  let head = 0;
  while (head < min && a[head] === b[head]) head++;
  if (line < head) return line;
  let tail = 0;
  while (tail < min - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (line >= a.length - tail) return line + (b.length - a.length);
  return a.length === b.length ? line : null;
}

/** An id of a text kit carried from `before` to `after`. */
export function remapId(before: string, after: string, id: string | null): string | null {
  if (id === null) return null;
  const line = lineOfId(id);
  if (line === null) return id;
  const next = remapLine(before, after, line);
  return next === null ? null : idOnLine(id, next);
}

// ---------------------------------------------------------------------------
// Labels
//
// Mermaid has no escape character; a character its grammar would read as
// syntax is written as its code — `#58;` is a colon. A label is shown and
// typed as what it says, and written with the characters its place in the
// source cannot hold spelled that way.
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", colon: ":" };

/** `#58;` → `:` — the codes a label is shown without. */
export function decodeLabel(text: string): string {
  return text.replace(/#(\d{1,7}|quot|amp|lt|gt|colon);/g, (all, code: string) => {
    const named = NAMED[code];
    if (named) return named;
    const n = Number(code);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}

/**
 * `text` with every character of `chars` written as its code — and a `#`
 * that would itself be read as the start of one.
 */
export function encodeLabel(text: string, chars: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = chars.includes(ch) || (ch === "#" && /^#\w+;/.test(text.slice(i, i + 12)));
    out += code ? `#${ch.codePointAt(0)};` : ch;
  }
  return out;
}

/** A label is one line of text. */
export const oneLine = (value: string): string => value.replace(/\s*\n\s*/g, " ").trim();

/** The offsets of `text`'s trimmed part, when `text` starts at `at`. */
export function trimmedSpan(text: string, at: number): { start: number; end: number } {
  const lead = text.length - text.trimStart().length;
  const body = text.trim().length;
  return { start: at + lead, end: at + lead + body };
}

// ---------------------------------------------------------------------------
// Pairing with the drawing
// ---------------------------------------------------------------------------

/**
 * Pair what is drawn with what is written when both are lists of named
 * things (a chart's sections): by order when there are as many of one as of
 * the other, else by name, for the names each side has once — a section
 * with nothing in it is written and not drawn.
 */
export function tagNamed(
  drawn: Element[],
  entities: readonly Entity[],
  tag: (el: Element, entity: Entity) => void,
): void {
  if (drawn.length === entities.length) {
    entities.forEach((e, i) => tag(drawn[i]!, e));
    return;
  }
  const nameOf = (el: Element): string => decodeLabel(el.getAttribute("data-id") ?? "").trim();
  for (const e of entities) {
    if (entities.filter((x) => x.label === e.label).length !== 1) continue;
    const els = drawn.filter((el) => nameOf(el) === e.label);
    if (els.length === 1) tag(els[0]!, e);
  }
}
