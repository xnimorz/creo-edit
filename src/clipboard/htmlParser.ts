// ---------------------------------------------------------------------------
// HTML parser — sanitize + walk into BlockSpec[] for `setDocFromHTML` and
// paste handling.
//
// Per-block tag parsers live in plugins (registered via `BlockDef.htmlCodec`).
// This file owns:
//  - sanitization (strip script/style/on* attrs, neutralize javascript:)
//  - structural walking (recurse into block-element wrappers like
//    <div>/<section>/<article>, group <li> by their <ul>/<ol> ancestor and
//    track nested-list depth)
//  - the bare-text-into-paragraph fallback so unknown HTML still produces
//    something usable
//
// Note: <ul>/<ol> handling stays here because depth + ordered-flag are
// derived from ancestor list elements, not from the <li> alone.
// ---------------------------------------------------------------------------

import { newBlockId } from "../model/doc";
import { getHtmlParserForTag } from "../plugin/htmlCodec";
import type { BlockSpec, InlineRun, Mark } from "../model/types";

/**
 * Parse a fragment of HTML into a sanitized list of BlockSpec.
 *
 * Sanitization rules:
 *  - `<script>`, `<style>`, `<link>`, `<meta>` content is dropped entirely.
 *  - All `on*` attributes are stripped.
 *  - `javascript:` URLs become "#".
 *  - Unknown elements become inline (their text content is preserved, marks
 *    of any ancestor mark elements still apply).
 *  - Block elements outside our model (article, section, etc.) become
 *    paragraphs (recursing into their children when those are themselves
 *    block-level).
 *
 * Falls back to a single paragraph if no block-level structure is present.
 */
export function parseHTML(html: string): BlockSpec[] {
  const sanitized = sanitize(html);
  const tpl = document.createElement("template");
  tpl.innerHTML = sanitized;
  const frag = tpl.content;
  const out: BlockSpec[] = [];
  for (const node of Array.from(frag.childNodes)) {
    walkBlock(node, [], out);
  }
  if (out.length === 0) {
    const text = collectText(frag);
    if (text.trim().length) {
      out.push({
        id: newBlockId(),
        type: "p",
        runs: [{ text }],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sanitization — drop dangerous tags / URLs before parsing into a Document.
// ---------------------------------------------------------------------------

function sanitize(html: string): string {
  let s = html;
  s = s.replace(/<\s*(script|style|link|meta)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  s = s.replace(/<\s*(script|style|link|meta)\b[^>]*\/?>/gi, "");
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "$1=\"#\"");
  return s;
}

// ---------------------------------------------------------------------------
// Block walker — delegates per-tag work to plugin-registered parsers.
// ---------------------------------------------------------------------------

const PARAGRAPH_WRAPPER_TAGS = new Set([
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "blockquote",
]);

function walkBlock(node: Node, marks: Mark[], out: BlockSpec[]): void {
  if (node.nodeType === 3) {
    const t = (node as Text).data;
    if (t.trim().length === 0) return;
    out.push({
      id: newBlockId(),
      type: "p",
      runs: [{ text: t, ...(marks.length ? { marks: new Set(marks) } : {}) }],
    });
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  // List handling — ul/ol drive the walker recursively, accumulating depth.
  if (tag === "ul" || tag === "ol") {
    walkList(el, tag === "ol", 0, marks, out);
    return;
  }

  // Bare <br/> outside any block — empty paragraph.
  if (tag === "br") {
    out.push({ id: newBlockId(), type: "p", runs: [] });
    return;
  }

  // Plugin-registered parser for this tag wins.
  const parser = getHtmlParserForTag(tag);
  if (parser) {
    const block = parser(el, { marks });
    if (block) out.push(block);
    return;
  }

  // Unknown wrapper — recurse into block children, otherwise flatten as a
  // paragraph.
  if (PARAGRAPH_WRAPPER_TAGS.has(tag) || tag === "html" || tag === "body") {
    if (hasBlockChild(el)) {
      for (const c of Array.from(el.childNodes)) walkBlock(c, marks, out);
      return;
    }
    const runs = collectRuns(el, marks);
    if (runs.length === 0 && el.childElementCount === 0) return;
    out.push({ id: newBlockId(), type: "p", runs: runs.length ? runs : [] });
    return;
  }

  // Truly unknown element with mixed content — flatten or recurse.
  if (hasBlockChild(el)) {
    for (const c of Array.from(el.childNodes)) walkBlock(c, marks, out);
    return;
  }
  const runs = collectRuns(el, marks);
  if (runs.length) out.push({ id: newBlockId(), type: "p", runs });
}

function walkList(
  listEl: HTMLElement,
  ordered: boolean,
  depth: 0 | 1 | 2 | 3,
  marks: Mark[],
  out: BlockSpec[],
): void {
  for (const child of Array.from(listEl.children)) {
    if (child.tagName.toLowerCase() !== "li") continue;
    const li = child as HTMLElement;
    const runs: InlineRun[] = [];
    for (const c of Array.from(li.childNodes)) {
      if (c.nodeType === 1) {
        const t = (c as HTMLElement).tagName.toLowerCase();
        if (t === "ul" || t === "ol") continue;
      }
      runs.push(...runsFor(c, marks));
    }
    out.push({
      id: newBlockId(),
      type: "li",
      ordered,
      depth,
      runs,
    });
    for (const c of Array.from(li.children)) {
      const t = c.tagName.toLowerCase();
      if (t === "ul" || t === "ol") {
        const nested = c as HTMLElement;
        const nestedOrdered = t === "ol";
        const nextDepth = (Math.min(3, depth + 1) as 0 | 1 | 2 | 3);
        walkList(nested, nestedOrdered, nextDepth, marks, out);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inline-runs collection — kept here so the structural walker (lists,
// fallbacks) can build runs without going through the plugin registry.
// ---------------------------------------------------------------------------

const MARK_TAGS: Record<string, Mark> = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  s: "s",
  strike: "s",
  del: "s",
  code: "code",
};

function runsFor(node: Node, marks: Mark[]): InlineRun[] {
  if (node.nodeType === 3) {
    const t = (node as Text).data;
    if (t.length === 0) return [];
    return [
      {
        text: t,
        ...(marks.length ? { marks: new Set(marks) } : {}),
      },
    ];
  }
  if (node.nodeType !== 1) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") {
    return [{ text: "\n", ...(marks.length ? { marks: new Set(marks) } : {}) }];
  }
  const additional = MARK_TAGS[tag];
  const nextMarks = additional ? [...marks, additional] : marks;
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) {
    out.push(...runsFor(c, nextMarks));
  }
  return out;
}

function collectRuns(el: HTMLElement, marks: Mark[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) {
    out.push(...runsFor(c, marks));
  }
  return out.filter((r) => r.text.length > 0);
}

function collectText(node: Node): string {
  let s = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) s += (n as Text).data;
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(node);
  return s;
}

function hasBlockChild(el: HTMLElement): boolean {
  for (const c of Array.from(el.children)) {
    const tag = c.tagName.toLowerCase();
    if (
      tag === "p" ||
      tag === "div" ||
      tag === "section" ||
      tag === "article" ||
      tag === "aside" ||
      tag === "header" ||
      tag === "footer" ||
      tag === "main" ||
      tag === "blockquote" ||
      tag === "ul" ||
      tag === "ol" ||
      tag === "li" ||
      tag === "table" ||
      tag === "h1" ||
      tag === "h2" ||
      tag === "h3" ||
      tag === "h4" ||
      tag === "h5" ||
      tag === "h6"
    ) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Plain text → blocks
// ---------------------------------------------------------------------------

export function parsePlainText(text: string): BlockSpec[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const paragraphs = normalized.split(/\n+/);
  return paragraphs.map((para) => ({
    id: newBlockId(),
    type: "p",
    runs: para.length ? [{ text: para }] : [],
  }));
}
