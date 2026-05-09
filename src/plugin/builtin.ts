// ---------------------------------------------------------------------------
// Built-in plugins — every block kind currently shipped by the editor is
// expressed as a plugin so the core has no per-kind switches.
//
// M1 keeps `table` and `columns` here alongside the text-bearing built-ins.
// M2 will extract them into a separate first-party `cellsPlugin` module
// (still registered by default) — the structure here is already plugin-shaped
// so the migration is a file move.
// ---------------------------------------------------------------------------

import { p, h1, h2, h3, h4, h5, h6, li, view } from "creo";
import type { PublicView } from "creo";
import type {
  Block,
  BlockSpec,
  HeadingBlock,
  ImageBlock,
  InlineRun,
  ListItemBlock,
  Mark,
  ParagraphBlock,
} from "../model/types";
import { newBlockId } from "../model/doc";
import { ParagraphView } from "../render/blocks/ParagraphView";
import { HeadingView } from "../render/blocks/HeadingView";
import { ListItemView } from "../render/blocks/ListItemView";
import { CodeBlockView } from "../render/blocks/CodeBlockView";
import { ImageView } from "../render/blocks/ImageView";
import {
  codeBlockCodec,
  defaultTextCodec,
  imageCodec,
} from "./anchorCodec";
import type { BlockDef, EditorPlugin } from "./types";
import { cellsPlugin } from "../plugins/cells";

// ---------------------------------------------------------------------------
// Helpers shared across built-in plugins.
// ---------------------------------------------------------------------------

const ALLOWED_MARKS = new Set<Mark>(["b", "i", "u", "s", "code"]);

type SerializedRun = { text: string; marks?: string[] };

function deserializeRun(r: SerializedRun): InlineRun {
  if (!r.marks || r.marks.length === 0) return { text: r.text };
  const marks = new Set<Mark>();
  for (const m of r.marks) if (ALLOWED_MARKS.has(m as Mark)) marks.add(m as Mark);
  return marks.size === 0 ? { text: r.text } : { text: r.text, marks };
}

function serializeRun(r: InlineRun): SerializedRun {
  if (!r.marks || r.marks.size === 0) return { text: r.text };
  return { text: r.text, marks: [...r.marks] };
}

// ---------------------------------------------------------------------------
// HTML inline collection — shared by every text-bearing parser.
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
  for (const c of Array.from(el.childNodes)) out.push(...runsFor(c, nextMarks));
  return out;
}

function collectRuns(el: HTMLElement, marks: Mark[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const c of Array.from(el.childNodes)) out.push(...runsFor(c, marks));
  return out.filter((r) => r.text.length > 0);
}

// ---------------------------------------------------------------------------
// HTML serialization helpers.
// ---------------------------------------------------------------------------

const MARK_TAGS_SER: Record<Mark, string> = {
  b: "strong",
  i: "em",
  u: "u",
  s: "s",
  code: "code",
};

const MARK_ORDER: Mark[] = ["code", "b", "i", "u", "s"];

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runsToHtml(runs: InlineRun[]): string {
  let out = "";
  for (const r of runs) {
    let inner = escapeHtml(r.text);
    if (r.marks && r.marks.size) {
      for (const m of MARK_ORDER) {
        if (!r.marks.has(m)) continue;
        const tag = MARK_TAGS_SER[m];
        inner = `<${tag}>${inner}</${tag}>`;
      }
    }
    out += inner;
  }
  return out;
}

function numAttr(el: HTMLElement, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Paragraph
// ---------------------------------------------------------------------------

const paragraphDef: BlockDef<ParagraphBlock> = {
  type: "p",
  view: ParagraphView as PublicView<{ block: ParagraphBlock; key?: string }, void>,
  isTextBearing: true,
  anchorCodec: defaultTextCodec,
  htmlCodec: {
    matchHTML: ["p"],
    parseHTML(el, ctx) {
      const runs = collectRuns(el, ctx.marks);
      return { id: newBlockId(), type: "p", runs };
    },
    serializeHTML(b) {
      return `<p>${runsToHtml((b as ParagraphBlock).runs)}</p>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const pb = b as ParagraphBlock;
      return { id: pb.id, type: "p", runs: pb.runs.map(serializeRun) };
    },
    deserialize(s, id) {
      const sb = s as { runs: SerializedRun[] };
      return { id, type: "p", runs: sb.runs.map(deserializeRun) } as BlockSpec;
    },
  },
};

// ---------------------------------------------------------------------------
// Headings — one BlockDef per level (h1..h6) sharing the HeadingView.
// ---------------------------------------------------------------------------

function headingDef(level: 1 | 2 | 3 | 4 | 5 | 6): BlockDef<HeadingBlock> {
  const tag = `h${level}` as HeadingBlock["type"];
  return {
    type: tag,
    view: HeadingView as PublicView<{ block: HeadingBlock; key?: string }, void>,
    isTextBearing: true,
    anchorCodec: defaultTextCodec,
    htmlCodec: {
      matchHTML: [tag],
      parseHTML(el, ctx) {
        const runs = collectRuns(el, ctx.marks);
        return { id: newBlockId(), type: tag, runs };
      },
      serializeHTML(b) {
        const hb = b as HeadingBlock;
        return `<${hb.type}>${runsToHtml(hb.runs)}</${hb.type}>`;
      },
    },
    serializeCodec: {
      serialize(b) {
        const hb = b as HeadingBlock;
        return { id: hb.id, type: hb.type, runs: hb.runs.map(serializeRun) };
      },
      deserialize(s, id) {
        const sb = s as { type: HeadingBlock["type"]; runs: SerializedRun[] };
        return { id, type: sb.type, runs: sb.runs.map(deserializeRun) } as BlockSpec;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// List item — note: <ul>/<ol> grouping in render and HTML happens above the
// per-block layer (DocView's planSpans + serializer's listOpen tracker).
// The block itself only knows about its `ordered`/`depth` fields.
// ---------------------------------------------------------------------------

const listItemDef: BlockDef<ListItemBlock> = {
  type: "li",
  view: ListItemView as PublicView<{ block: ListItemBlock; key?: string }, void>,
  isTextBearing: true,
  anchorCodec: defaultTextCodec,
  htmlCodec: {
    // <li> parsing is tag-driven through the <ul>/<ol> walker in htmlParser
    // (depth needs ancestor context). We register `li` here so an orphan
    // <li> outside a list still produces a paragraph fallback below.
    matchHTML: ["li"],
    parseHTML(el, ctx) {
      const runs = collectRuns(el, ctx.marks);
      return { id: newBlockId(), type: "p", runs } as BlockSpec;
    },
    serializeHTML(b) {
      const lb = b as ListItemBlock;
      return `<li data-depth="${lb.depth}">${runsToHtml(lb.runs)}</li>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const lb = b as ListItemBlock;
      return {
        id: lb.id,
        type: "li",
        ordered: lb.ordered,
        depth: lb.depth,
        runs: lb.runs.map(serializeRun),
      };
    },
    deserialize(s, id) {
      const sb = s as {
        ordered: boolean;
        depth?: 0 | 1 | 2 | 3;
        runs: SerializedRun[];
      };
      return {
        id,
        type: "li",
        ordered: sb.ordered,
        depth: sb.depth ?? 0,
        runs: sb.runs.map(deserializeRun),
      } as BlockSpec;
    },
  },
};

// ---------------------------------------------------------------------------
// Code block
// ---------------------------------------------------------------------------

import type { CodeBlock } from "../model/types";

const codeBlockDef: BlockDef<CodeBlock> = {
  type: "code",
  view: CodeBlockView as PublicView<{ block: CodeBlock; key?: string }, void>,
  isTextBearing: true,
  anchorCodec: codeBlockCodec,
  htmlCodec: {
    matchHTML: ["pre"],
    parseHTML(el) {
      // <pre> typically wraps a <code> with `language-foo`.
      const codeEl = el.querySelector("code");
      const text = (codeEl ?? el).textContent ?? "";
      const langMatch = codeEl?.className.match(/language-(\S+)/);
      return {
        id: newBlockId(),
        type: "code",
        runs: text ? [{ text }] : [],
        ...(langMatch ? { lang: langMatch[1] } : {}),
      } as BlockSpec;
    },
    serializeHTML(b) {
      const cb = b as CodeBlock;
      const langCls = cb.lang
        ? ` class="language-${escapeHtml(cb.lang)}"`
        : "";
      return `<pre><code${langCls}>${runsToHtml(cb.runs)}</code></pre>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const cb = b as CodeBlock;
      return {
        id: cb.id,
        type: "code",
        runs: cb.runs.map(serializeRun),
        ...(cb.lang ? { lang: cb.lang } : {}),
      };
    },
    deserialize(s, id) {
      const sb = s as { runs: SerializedRun[]; lang?: string };
      return {
        id,
        type: "code",
        runs: sb.runs.map(deserializeRun),
        ...(sb.lang ? { lang: sb.lang } : {}),
      } as BlockSpec;
    },
  },
};

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

const imageDef: BlockDef<ImageBlock> = {
  type: "img",
  view: ImageView as PublicView<{ block: ImageBlock; key?: string }, void>,
  isTextBearing: false,
  isAtomic: true,
  anchorCodec: imageCodec,
  htmlCodec: {
    matchHTML: ["img"],
    parseHTML(el) {
      const src = el.getAttribute("src") ?? "";
      if (!src) return null;
      const alt = el.getAttribute("alt") ?? undefined;
      const w = numAttr(el, "width");
      const h = numAttr(el, "height");
      return {
        id: newBlockId(),
        type: "img",
        src,
        alt,
        width: w,
        height: h,
      } as BlockSpec;
    },
    serializeHTML(b) {
      const ib = b as ImageBlock;
      const attrs: string[] = [`src="${escapeHtml(ib.src)}"`];
      if (ib.alt) attrs.push(`alt="${escapeHtml(ib.alt)}"`);
      if (ib.width) attrs.push(`width="${ib.width}"`);
      if (ib.height) attrs.push(`height="${ib.height}"`);
      return `<img ${attrs.join(" ")}/>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const ib = b as ImageBlock;
      return {
        id: ib.id,
        type: "img",
        src: ib.src,
        alt: ib.alt,
        width: ib.width,
        height: ib.height,
      };
    },
    deserialize(s, id) {
      const sb = s as {
        src: string;
        alt?: string;
        width?: number;
        height?: number;
      };
      return {
        id,
        type: "img",
        src: sb.src,
        alt: sb.alt,
        width: sb.width,
        height: sb.height,
      } as BlockSpec;
    },
  },
};

// ---------------------------------------------------------------------------
// Plugin assembly
//
// Built-ins are split into per-kind plugins so users can opt out granularly
// (e.g. drop `imagePlugin` to disable images). `defaultPlugins` exports them
// all as a flat array in the order createEditor registers by default. The
// `cells` plugin (table + columns) is imported from src/plugins/cells.
// ---------------------------------------------------------------------------

export const paragraphPlugin: EditorPlugin = {
  name: "paragraph",
  blocks: [paragraphDef as BlockDef<Block>],
};

export const headingPlugin: EditorPlugin = {
  name: "heading",
  blocks: [
    headingDef(1) as BlockDef<Block>,
    headingDef(2) as BlockDef<Block>,
    headingDef(3) as BlockDef<Block>,
    headingDef(4) as BlockDef<Block>,
    headingDef(5) as BlockDef<Block>,
    headingDef(6) as BlockDef<Block>,
  ],
};

export const listPlugin: EditorPlugin = {
  name: "list",
  blocks: [listItemDef as BlockDef<Block>],
};

export const codeBlockPlugin: EditorPlugin = {
  name: "code-block",
  blocks: [codeBlockDef as BlockDef<Block>],
};

export const imagePlugin: EditorPlugin = {
  name: "image",
  blocks: [imageDef as BlockDef<Block>],
};

export { cellsPlugin };

/** All built-in plugins, in registration order. */
export const defaultPlugins: EditorPlugin[] = [
  paragraphPlugin,
  headingPlugin,
  listPlugin,
  codeBlockPlugin,
  imagePlugin,
  cellsPlugin,
];

// Suppress unused-import warnings for creo-element helpers that text-bearing
// blocks would have used had we inlined their views here.
void p;
void h1;
void h2;
void h3;
void h4;
void h5;
void h6;
void li;
void view;
