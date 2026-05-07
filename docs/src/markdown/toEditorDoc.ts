// Markdown → SerializedDoc converter.
//
// Used by the docs site to render every page as editable editor content.
// Built on `marked.lexer()` so we get a real AST, not regex-based hacks.
//
// Mapping notes:
// - ATX headings #..###### → h1..h6 blocks
// - Paragraphs              → p blocks
// - Code fences            → ONE p block whose run has the `code` mark and
//                            embedded \n characters (white-space:pre-wrap on
//                            the editor renders them as a multi-line block)
// - Lists                  → li blocks. depth from nesting (max 3).
// - GFM tables             → table blocks. Cell text becomes inline runs.
// - Inline marks: **bold** *italic* ~~strike~~ `code`
// - Links                  → text content only (URL is dropped — editor has
//                            no link mark and clicking inside the editor
//                            would just place a caret anyway)
// - Raw HTML / pkg-tabs    → dropped entirely
//
// The converter is deliberately tolerant: unknown token types are skipped
// rather than throwing, so a new markdown construct in content/* doesn't
// blow up the build.

import { Marked, type Token, type Tokens } from "marked";
import type { SerializedBlock, SerializedDoc, SerializedRun } from "creo-edit";

type Mark = "b" | "i" | "u" | "s" | "code";

const marked = new Marked({ gfm: true });

// marked escapes HTML entities inside `codespan` and `text` tokens
// (&amp; &lt; &gt; &quot; &#39;). The editor stores raw runs, so we have
// to decode before pushing — otherwise users see literal "&quot;" in
// rendered code/text instead of `"`.
function unescapeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function tokensToRuns(tokens: Token[], baseMarks: Mark[] = []): SerializedRun[] {
  const out: SerializedRun[] = [];
  const push = (text: string, marks: Mark[]) => {
    if (!text) return;
    const decoded = unescapeEntities(text);
    if (marks.length === 0) out.push({ text: decoded });
    else out.push({ text: decoded, marks: [...new Set(marks)] });
  };

  for (const tok of tokens) {
    switch (tok.type) {
      case "text": {
        const t = tok as Tokens.Text;
        // `text` tokens may have inner `tokens` when they contain inline
        // markup (e.g. inside list items). Walk them if present.
        if (t.tokens && t.tokens.length > 0) {
          out.push(...tokensToRuns(t.tokens, baseMarks));
        } else {
          push(t.text, baseMarks);
        }
        break;
      }
      case "escape":
        push((tok as Tokens.Escape).text, baseMarks);
        break;
      case "codespan":
        push((tok as Tokens.Codespan).text, [...baseMarks, "code"]);
        break;
      case "strong":
        out.push(...tokensToRuns((tok as Tokens.Strong).tokens, [...baseMarks, "b"]));
        break;
      case "em":
        out.push(...tokensToRuns((tok as Tokens.Em).tokens, [...baseMarks, "i"]));
        break;
      case "del":
        out.push(...tokensToRuns((tok as Tokens.Del).tokens, [...baseMarks, "s"]));
        break;
      case "link":
        // Drop the URL — render the link text only.
        out.push(...tokensToRuns((tok as Tokens.Link).tokens, baseMarks));
        break;
      case "br":
        push("\n", baseMarks);
        break;
      case "html":
        // Inline HTML — keep the raw text so e.g. <kbd> contents survive,
        // even if the tag itself is lost.
        push((tok as Tokens.HTML).text, baseMarks);
        break;
      case "image": {
        // No inline image mark in the editor model; render alt text.
        const im = tok as Tokens.Image;
        push(im.text || im.title || "[image]", baseMarks);
        break;
      }
      default: {
        // Unknown inline token — best-effort: take its `.text` if any.
        const anyTok = tok as { text?: string };
        if (typeof anyTok.text === "string") push(anyTok.text, baseMarks);
      }
    }
  }
  return out;
}

function processList(
  list: Tokens.List,
  blocks: SerializedBlock[],
  depth: 0 | 1 | 2 | 3,
): void {
  for (const item of list.items) {
    // Walk the item's tokens. The first paragraph is the item text; nested
    // lists become further li blocks at depth+1.
    const itemRuns: SerializedRun[] = [];
    let nestedLists: Tokens.List[] = [];

    for (const tok of item.tokens) {
      if (tok.type === "list") {
        nestedLists.push(tok as Tokens.List);
      } else if (tok.type === "text") {
        const t = tok as Tokens.Text;
        if (t.tokens) itemRuns.push(...tokensToRuns(t.tokens));
        else itemRuns.push({ text: t.text });
      } else if (tok.type === "paragraph") {
        itemRuns.push(...tokensToRuns((tok as Tokens.Paragraph).tokens));
      }
      // (Other token types inside list items are rare and dropped.)
    }

    blocks.push({
      type: "li",
      ordered: list.ordered,
      depth,
      runs: itemRuns,
    });

    for (const nested of nestedLists) {
      const nextDepth = Math.min(depth + 1, 3) as 0 | 1 | 2 | 3;
      processList(nested, blocks, nextDepth);
    }
  }
}

function processTable(table: Tokens.Table): SerializedBlock {
  // Header row + body rows → a table block. The model's `cells[r][c]` is
  // an InlineRun[] sequence; we inline-parse each cell.
  const cellsToRuns = (cell: Tokens.TableCell): SerializedRun[] =>
    tokensToRuns(cell.tokens);

  const headerRow: SerializedRun[][] = table.header.map(cellsToRuns);
  // Bold the header cells so they look like header cells in the editor.
  for (const cellRuns of headerRow) {
    for (let i = 0; i < cellRuns.length; i++) {
      const r = cellRuns[i];
      cellRuns[i] = {
        text: r.text,
        marks: [...new Set([...(r.marks ?? []), "b"])],
      };
    }
  }
  const bodyRows: SerializedRun[][][] = table.rows.map((row) => row.map(cellsToRuns));

  const allRows = [headerRow, ...bodyRows];
  return {
    type: "table",
    rows: allRows.length,
    cols: allRows[0]?.length ?? 0,
    cells: allRows,
  };
}

export function markdownToDoc(src: string): SerializedDoc {
  // Strip frontmatter — same shape the existing markdown plugin expects.
  const fm = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (fm) src = src.slice(fm[0].length);

  const tokens = marked.lexer(src);
  const blocks: SerializedBlock[] = [];

  for (const tok of tokens) {
    switch (tok.type) {
      case "heading": {
        const h = tok as Tokens.Heading;
        const depth = Math.min(Math.max(h.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({
          type: ("h" + depth) as `h${typeof depth}`,
          runs: tokensToRuns(h.tokens),
        });
        break;
      }
      case "paragraph": {
        blocks.push({
          type: "p",
          runs: tokensToRuns((tok as Tokens.Paragraph).tokens),
        });
        break;
      }
      case "code": {
        // Fenced code block → a real `code` block (the editor's
        // dedicated block type for monospaced multi-line content). The
        // `lang` from the fence info-string is preserved on the block.
        const c = tok as Tokens.Code;
        const text = c.text;
        blocks.push({
          type: "code",
          runs: text ? [{ text }] : [],
          ...(c.lang ? { lang: c.lang } : {}),
        });
        break;
      }
      case "blockquote": {
        // Flatten — render quote contents as paragraphs with `i` mark so
        // they read distinct from surrounding prose.
        const inner = markdownToDoc(
          (tok as Tokens.Blockquote).text,
        );
        for (const b of inner.blocks) {
          if (b.type === "p") {
            blocks.push({
              type: "p",
              runs: b.runs.map((r) => ({
                text: r.text,
                marks: [...new Set([...(r.marks ?? []), "i"])],
              })),
            });
          } else {
            blocks.push(b);
          }
        }
        break;
      }
      case "list":
        processList(tok as Tokens.List, blocks, 0);
        break;
      case "table":
        blocks.push(processTable(tok as Tokens.Table));
        break;
      case "hr":
        // No native HR block — render a paragraph of em-dashes as a visual
        // separator.
        blocks.push({ type: "p", runs: [{ text: "———", marks: ["code"] }] });
        break;
      case "space":
        // Markdown blank line. The editor doesn't need explicit spacers —
        // adjacent blocks already get the right margin from CSS. Skip.
        break;
      case "html":
        // Raw HTML — drop. Custom widgets (pkg-tabs etc.) won't survive.
        break;
      default:
        // Best effort for unknown block types.
        break;
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "p", runs: [] });
  }

  return { blocks };
}
