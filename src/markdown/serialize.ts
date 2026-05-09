// ---------------------------------------------------------------------------
// docToMarkdown — serialize a SerializedDoc to a markdown string.
//
// Coverage: paragraphs, headings (h1..h6), lists (bulleted + numbered, with
// depth indentation), code blocks (fenced with lang), images, inline marks
// (bold, italic, strike, code). Tables emit GFM table syntax. Columns
// degrade to a `data-creo-columns` HTML block embedded in markdown.
//
// Round-trip fidelity is "good enough" — parsing the output via the docs
// site's markdown converter restores the same block structure for the
// covered shapes. Edge cases like nested marks adjacent to whitespace may
// degrade to plainer text.
// ---------------------------------------------------------------------------

import type { SerializedBlock, SerializedDoc, SerializedRun } from "../createEditor";

const MARK_OPEN: Record<string, string> = {
  b: "**",
  i: "*",
  s: "~~",
  code: "`",
};
const MARK_CLOSE = MARK_OPEN;
const MARK_ORDER = ["code", "b", "i", "s"] as const;

function runsToMarkdown(runs: SerializedRun[]): string {
  let out = "";
  for (const r of runs) {
    if (!r.marks || r.marks.length === 0) {
      out += escapeInline(r.text);
      continue;
    }
    const ordered = MARK_ORDER.filter((m) => r.marks!.includes(m));
    let s = escapeInline(r.text);
    // Inside-out wrap so the last marker closes first.
    for (const m of ordered.slice().reverse()) {
      s = `${MARK_OPEN[m]}${s}${MARK_CLOSE[m]}`;
    }
    out += s;
  }
  return out;
}

function escapeInline(s: string): string {
  // Lightweight: escape only the chars that would be parsed as syntax in
  // plain runs (`*`, `_`, `` ` ``, `~`, `\`). Newlines stay raw.
  return s.replace(/([\\`*_~])/g, "\\$1");
}

function blockToMarkdown(
  block: SerializedBlock,
  state: { listKind: "ul" | "ol" | null; olCounter: number },
): string {
  // Reset list counter when leaving a list.
  if (block.type !== "li" && state.listKind !== null) {
    state.listKind = null;
    state.olCounter = 0;
  }
  switch (block.type) {
    case "p":
      return runsToMarkdown(block.runs);
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(block.type.slice(1));
      return `${"#".repeat(level)} ${runsToMarkdown(block.runs)}`;
    }
    case "li": {
      const wantKind = block.ordered ? "ol" : "ul";
      if (state.listKind !== wantKind) {
        state.listKind = wantKind;
        state.olCounter = 0;
      }
      const depth = block.depth ?? 0;
      const indent = "  ".repeat(depth);
      const marker = block.ordered ? `${++state.olCounter}.` : "-";
      return `${indent}${marker} ${runsToMarkdown(block.runs)}`;
    }
    case "code": {
      const lang = block.lang ? block.lang : "";
      const text = block.runs.map((r) => r.text).join("");
      return "```" + lang + "\n" + text + "\n```";
    }
    case "img": {
      const alt = block.alt ?? "";
      return `![${escapeInline(alt)}](${block.src})`;
    }
    case "table": {
      const rows = block.cells;
      if (rows.length === 0) return "";
      const headerCells = (rows[0] ?? []).map((cell) => runsToMarkdown(cell));
      const sep = headerCells.map(() => "---");
      const lines: string[] = [];
      lines.push(`| ${headerCells.join(" | ")} |`);
      lines.push(`| ${sep.join(" | ")} |`);
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r] ?? [];
        lines.push(`| ${row.map((c) => runsToMarkdown(c)).join(" | ")} |`);
      }
      return lines.join("\n");
    }
    case "columns": {
      // No standard markdown for columns — fall back to an HTML-in-markdown
      // marker that the parser recognises on the way back.
      const inner = block.cells
        .map((cell, c) => `<div data-col="${c}">${runsToMarkdown(cell)}</div>`)
        .join("");
      return `<div data-creo-columns="${block.cols}">${inner}</div>`;
    }
    case "calendar": {
      // Atomic block — no native markdown form; serialize as an HTML stub
      // so the parser can round-trip via its `data-block-kind` matcher.
      return `<div data-block-kind="calendar" data-date="${block.date}" data-days="${block.days}"></div>`;
    }
    case "date-marker": {
      return `<div data-block-kind="date-marker" data-date="${block.date}"></div>`;
    }
  }
}

export function docToMarkdown(doc: SerializedDoc): string {
  const lines: string[] = [];
  const state = { listKind: null as "ul" | "ol" | null, olCounter: 0 };
  for (const b of doc.blocks) {
    const md = blockToMarkdown(b, state);
    if (md.length > 0) lines.push(md);
  }
  return lines.join("\n\n") + "\n";
}
