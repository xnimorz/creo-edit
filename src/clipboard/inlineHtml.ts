// ---------------------------------------------------------------------------
// Inline HTML ↔ InlineRun[]. Shared by every block-level HTML codec so mark
// parsing and mark serialization live in one place and follow the mark
// registry rather than a hard-coded tag table.
//
// A tag maps to a mark through `markDefForTag`; the mark's `parseHTML` decides
// the attrs it records (and may decline the element, which is how an `<a>`
// with no href comes through as plain text). On the way out, a mark's `tag`
// plus `domAttrs` produce the wrapper, in the registry's `order` — the same
// order `InlineRunsView` renders in, so copy → paste is idempotent.
// ---------------------------------------------------------------------------

import { markDefForTag, orderedMarkDefs } from "../plugin/markRegistry";
import { NO_MARKS, withMark } from "../model/marks";
import type { InlineRun, MarkSet } from "../model/types";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function withMarks(text: string, marks: MarkSet): InlineRun {
  return marks.size ? { text, marks } : { text };
}

/** Runs produced by one DOM node, with `marks` inherited from its ancestors. */
export function runsFromNode(node: Node, marks: MarkSet): InlineRun[] {
  if (node.nodeType === 3) {
    const t = (node as Text).data;
    if (t.length === 0) return [];
    return [withMarks(t, marks)];
  }
  if (node.nodeType !== 1) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return [withMarks("\n", marks)];
  let next = marks;
  const def = markDefForTag(tag);
  if (def) {
    const attrs = def.parseHTML ? def.parseHTML(el) : null;
    // `false` = the element matched a mark's tag but declined it (an <a>
    // with no href). Its children still parse, just without the mark.
    if (attrs !== false) next = withMark(marks, def.name, attrs);
  }
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) out.push(...runsFromNode(c, next));
  return out;
}

/** Every run under `el`, dropping empties. */
export function collectRuns(el: HTMLElement, marks: MarkSet = NO_MARKS): InlineRun[] {
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) out.push(...runsFromNode(c, marks));
  return out.filter((r) => r.text.length > 0);
}

/** Inline HTML for a run list — the inverse of `collectRuns`. */
export function runsToHtml(runs: InlineRun[]): string {
  let out = "";
  for (const r of runs) {
    let inner = escapeHtml(r.text);
    if (r.marks && r.marks.size) {
      for (const def of orderedMarkDefs()) {
        if (!def.tag) continue;
        const attrs = r.marks.get(def.name);
        if (attrs === undefined) continue;
        const domAttrs = def.domAttrs?.(attrs);
        const attrStr = domAttrs
          ? Object.entries(domAttrs)
              .map(([k, v]) => ` ${k}="${escapeHtml(String(v))}"`)
              .join("")
          : "";
        inner = `<${def.tag}${attrStr}>${inner}</${def.tag}>`;
      }
    }
    out += inner;
  }
  return out;
}
