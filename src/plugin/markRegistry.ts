// ---------------------------------------------------------------------------
// Mark registry — module-global, like the atomic / view / codec registries.
//
// One `MarkDef` per mark name says how the mark renders, how it survives an
// HTML round trip, and how it serializes to markdown. Everything that used to
// hard-code the five boolean marks in a `MARK_ORDER` array now walks this
// registry, so a plugin adding a `highlight` or `comment` mark gets rendering,
// copy/paste and markdown for free.
//
// The six built-ins (`b`, `i`, `u`, `s`, `code`, `link`) register themselves
// at module load, so a bare `htmlParser` import behaves the same as a fully
// built editor.
//
// `order` decides nesting: lower numbers wrap CLOSER to the text. Fixing the
// order is what keeps toggling a mark from reshuffling the DOM tree under a
// run — the reconciler and the anchor walk both prefer a stable shape.
// ---------------------------------------------------------------------------

import type { MarkAttrs, MarkName } from "../model/types";

export type MarkDef = {
  name: MarkName;
  /** Element wrapping the run when rendered and when serialized to HTML.
   *  Omit for a mark that is model-only (a comment thread painted through
   *  range decorations, say). */
  tag?: string;
  /**
   * DOM attributes for the wrapper, derived from the mark's attrs. Values are
   * written verbatim — a mark carrying a URL is responsible for validating it
   * (see `safeHref` on the built-in link mark).
   */
  domAttrs?(attrs: MarkAttrs): Record<string, string> | undefined;
  /** Tag names (lower-case) that produce this mark when parsing HTML. */
  matchHTML?: string[];
  /**
   * Attrs to record when parsing a matched element. Return `null` for a
   * boolean mark, or `false` to decline the element entirely (its children
   * are still walked, just without this mark).
   */
  parseHTML?(el: HTMLElement): MarkAttrs | false;
  /** Markdown wrapping. A symmetric delimiter pair, or a full formatter for
   *  marks whose syntax isn't a wrap (links). */
  markdown?:
    | { open: string; close: string }
    | ((inner: string, attrs: MarkAttrs) => string);
  /** Nesting order — lower wraps closer to the text. Default 100. */
  order?: number;
};

const defs = new Map<MarkName, MarkDef>();
/** Ascending by `order`, rebuilt lazily after each registration. */
let ordered: MarkDef[] | null = null;
const byTag = new Map<string, MarkDef>();

export function registerMark(def: MarkDef): void {
  defs.set(def.name, def);
  ordered = null;
  if (def.matchHTML) {
    for (const t of def.matchHTML) byTag.set(t.toLowerCase(), def);
  }
}

export function getMarkDef(name: MarkName): MarkDef | null {
  return defs.get(name) ?? null;
}

/** Every registered mark, innermost-wrapping first. */
export function orderedMarkDefs(): readonly MarkDef[] {
  if (ordered) return ordered;
  ordered = [...defs.values()].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100),
  );
  return ordered;
}

/** The mark an HTML tag maps to when parsing, if any. */
export function markDefForTag(tag: string): MarkDef | null {
  return byTag.get(tag.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Built-in marks
// ---------------------------------------------------------------------------

/**
 * Refuse `javascript:` / `data:` and friends. Anything that isn't a URL we
 * recognise becomes a relative href, which is inert. Applied on the way INTO
 * the DOM (rendering and HTML serialization) rather than on the way into the
 * model, so a host that stores a href we'd reject still gets it back from
 * `toJSON()` intact.
 */
export function safeHref(href: string): string {
  const t = href.trim();
  // A scheme-relative or absolute path, a fragment, or a query is always fine.
  if (/^(\/|#|\?|\.)/.test(t)) return t;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t);
  if (!m) return t; // no scheme at all — relative
  const scheme = m[1]!.toLowerCase();
  return scheme === "http" ||
    scheme === "https" ||
    scheme === "mailto" ||
    scheme === "tel"
    ? t
    : "#";
}

function boolMark(
  name: MarkName,
  tag: string,
  matchHTML: string[],
  order: number,
  markdown?: { open: string; close: string },
): MarkDef {
  return { name, tag, matchHTML, order, ...(markdown ? { markdown } : {}) };
}

registerMark(
  boolMark("code", "code", ["code"], 10, { open: "`", close: "`" }),
);
registerMark(
  boolMark("b", "strong", ["b", "strong"], 20, { open: "**", close: "**" }),
);
registerMark(boolMark("i", "em", ["i", "em"], 30, { open: "*", close: "*" }));
registerMark(boolMark("u", "u", ["u"], 40));
registerMark(
  boolMark("s", "s", ["s", "strike", "del"], 50, { open: "~~", close: "~~" }),
);

registerMark({
  name: "link",
  tag: "a",
  order: 60,
  matchHTML: ["a"],
  domAttrs(attrs) {
    const href = (attrs as { href?: unknown } | null)?.href;
    if (typeof href !== "string") return undefined;
    const title = (attrs as { title?: unknown } | null)?.title;
    return {
      href: safeHref(href),
      ...(typeof title === "string" && title ? { title } : {}),
    };
  },
  parseHTML(el) {
    const href = el.getAttribute("href");
    // An <a> with no href is a named anchor, not a link — decline it so its
    // text still comes through unmarked.
    if (!href) return false;
    const title = el.getAttribute("title");
    return { href, ...(title ? { title } : {}) };
  },
  markdown(inner, attrs) {
    const href = (attrs as { href?: unknown } | null)?.href;
    if (typeof href !== "string") return inner;
    const title = (attrs as { title?: unknown } | null)?.title;
    const t = typeof title === "string" && title ? ` "${title}"` : "";
    return `[${inner}](${href}${t})`;
  },
});
