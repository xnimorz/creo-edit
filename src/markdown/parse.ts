// ---------------------------------------------------------------------------
// markdownToDoc — the inverse of `docToMarkdown` for what it writes.
//
// Blocks: paragraphs (their lines joined by `\n`, as the writer leaves a
// paragraph's newlines raw), ATX headings, bulleted and numbered list items
// with their depth, fenced code with its language, standalone images, and
// GFM tables with column alignment. A plugin block joins through
// `MarkdownBlockCodec.parse`, asked before the built-ins, newest first — that
// is how `> quote` and `---` come back as blockquote and rule blocks when
// those plugins are installed. Inline: `**bold**`, `*italic*` / `_italic_`,
// `~~strike~~`, `` `code` ``, `[text](href "title")` and backslash escapes.
//
// Anything not recognised arrives as a paragraph with its text, so nothing is
// dropped. Pure string work: no DOM, so it runs anywhere.
// ---------------------------------------------------------------------------

import { allMarkdownCodecs } from "./blockCodec";
import type { SerializedBlock, SerializedDoc, SerializedRun } from "../createEditor";
import type { TableAlign } from "../model/types";

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const IMAGE = /^\s*!\[((?:\\.|[^\]\\])*)\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

export function markdownToDoc(markdown: string): SerializedDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: SerializedBlock[] = [];
  // Indents of the list items above, so a nested item's depth is how many of
  // them it is indented past, whatever width the source indents by.
  let listIndents: number[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    const claimed = pluginBlock(lines, i);
    if (claimed) {
      blocks.push(claimed.block);
      i = claimed.end;
      listIndents = [];
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, marker)) body.push(lines[i++]!);
      i++;
      const text = body.join("\n");
      blocks.push({
        type: "code",
        runs: text.length > 0 ? [{ text }] : [],
        ...(fence[3] ? { lang: fence[3] } : {}),
      });
      listIndents = [];
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: `h${level}`, runs: parseInline(heading[2] ?? "") });
      i++;
      listIndents = [];
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!)) {
      const rows: string[][] = [splitRow(line)];
      const align = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(splitRow(lines[i++]!));
      const cols = Math.max(...rows.map((row) => row.length));
      blocks.push({
        type: "table",
        rows: rows.length,
        cols,
        cells: rows.map((row) =>
          Array.from({ length: cols }, (_, c) => parseInline((row[c] ?? "").replace(/<br\s*\/?>/gi, "\n"))),
        ),
        ...(align.some((a) => a !== null) ? { align } : {}),
      });
      listIndents = [];
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item && !isRule(line)) {
      const indent = widthOf(item[1]!);
      while (listIndents.length > 0 && listIndents[listIndents.length - 1]! >= indent) listIndents.pop();
      blocks.push({
        type: "li",
        ordered: /\d/.test(item[2]!),
        depth: listIndents.length,
        runs: parseInline(item[3] ?? ""),
      });
      listIndents.push(indent);
      i++;
      continue;
    }
    listIndents = [];

    const image = IMAGE.exec(line);
    if (image) {
      const alt = unescape(image[1]!);
      blocks.push({ type: "img", src: image[2]!, ...(alt ? { alt } : {}) });
      i++;
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim().length > 0 && !startsBlock(lines, i)) para.push(lines[i++]!);
    blocks.push({ type: "p", runs: parseInline(para.join("\n")) });
  }

  return { blocks: blocks.length > 0 ? blocks : [{ type: "p", runs: [] }] };
}

function pluginBlock(lines: readonly string[], at: number): { block: SerializedBlock; end: number } | null {
  const codecs = allMarkdownCodecs();
  for (let k = codecs.length - 1; k >= 0; k--) {
    const hit = codecs[k]!.parse?.(lines, at);
    if (hit && hit.end > at) return { block: hit.block as SerializedBlock, end: hit.end };
  }
  return null;
}

function startsBlock(lines: readonly string[], at: number): boolean {
  const line = lines[at]!;
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    (LIST_ITEM.test(line) && !isRule(line)) ||
    (TABLE_ROW.test(line) && at + 1 < lines.length && TABLE_RULE.test(lines[at + 1]!)) ||
    pluginBlock(lines, at) !== null
  );
}

function closesFence(line: string, marker: string): boolean {
  const t = line.trim();
  return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t);
}

/** `---`, `***`, `* * *`: a thematic break, not a list item. */
function isRule(line: string): boolean {
  return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
}

function widthOf(indent: string): number {
  let w = 0;
  for (const ch of indent) w += ch === "\t" ? 4 : 1;
  return w;
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k]!;
    if (ch === "\\" && inner[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(rule: string): TableAlign {
  const left = rule.startsWith(":");
  const right = rule.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

function unescape(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

type Marks = Record<string, unknown>;

const WRAPS: Array<{ open: string; mark: string }> = [
  { open: "**", mark: "b" },
  { open: "__", mark: "b" },
  { open: "~~", mark: "s" },
  { open: "*", mark: "i" },
  { open: "_", mark: "i" },
];

/** Inline markdown as runs, adjacent runs with the same marks merged. */
export function parseInline(text: string): SerializedRun[] {
  const out: SerializedRun[] = [];
  walk(text, {}, out);
  return out;
}

function push(out: SerializedRun[], text: string, marks: Marks): void {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  const key = JSON.stringify(marks);
  if (last && JSON.stringify(last.marks ?? {}) === key) {
    last.text += text;
    return;
  }
  out.push(Object.keys(marks).length > 0 ? { text, marks: { ...marks } } : { text });
}

function walk(text: string, marks: Marks, out: SerializedRun[]): void {
  let plain = "";
  const flush = (): void => {
    push(out, plain, marks);
    plain = "";
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1]!)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`" && !("code" in marks)) {
      const ticks = /^`+/.exec(text.slice(i))![0];
      const close = text.indexOf(ticks, i + ticks.length);
      if (close > i + ticks.length - 1) {
        flush();
        let code = text.slice(i + ticks.length, close);
        if (code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code)) code = code.slice(1, -1);
        push(out, code, { ...marks, code: null });
        i = close + ticks.length;
        continue;
      }
    }

    if (ch === "[" && !("link" in marks)) {
      const link = linkAt(text, i);
      if (link) {
        flush();
        walk(link.inner, { ...marks, link: link.title ? { href: link.href, title: link.title } : { href: link.href } }, out);
        i = link.end;
        continue;
      }
    }

    // `_` inside a word (snake_case) is a letter, not emphasis.
    const wrap = WRAPS.find(
      (w) =>
        text.startsWith(w.open, i) &&
        !(w.mark in marks) &&
        !(w.open[0] === "_" && i > 0 && /[A-Za-z0-9]/.test(text[i - 1]!)),
    );
    if (wrap) {
      const close = closingOf(text, i + wrap.open.length, wrap.open);
      if (close > i + wrap.open.length) {
        flush();
        walk(text.slice(i + wrap.open.length, close), { ...marks, [wrap.mark]: null }, out);
        i = close + wrap.open.length;
        continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
}

/** The next unescaped `delim` from `from`, not inside a code span; -1 if none. */
function closingOf(text: string, from: number, delim: string): number {
  if (text[from] === " ") return -1;
  for (let k = from; k < text.length; k++) {
    const ch = text[k]!;
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(text.slice(k))![0];
      const end = text.indexOf(ticks, k + ticks.length);
      if (end > 0) k = end + ticks.length - 1;
      continue;
    }
    if (!text.startsWith(delim, k)) continue;
    // A single `*` is not the first half of a `**`.
    if (delim.length === 1 && text[k + 1] === delim) {
      k++;
      continue;
    }
    if (text[k - 1] === " ") continue;
    return k;
  }
  return -1;
}

function linkAt(text: string, at: number): { inner: string; href: string; title?: string; end: number } | null {
  let depth = 0;
  let k = at;
  for (; k < text.length; k++) {
    const ch = text[k]!;
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (k >= text.length || text[k + 1] !== "(") return null;
  const m = /^\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/.exec(text.slice(k + 1));
  if (!m) return null;
  return {
    inner: text.slice(at + 1, k),
    href: m[1]!,
    ...(m[2] ? { title: m[2] } : {}),
    end: k + 1 + m[0].length,
  };
}
