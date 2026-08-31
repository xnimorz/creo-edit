// ---------------------------------------------------------------------------
// Built-in plugins — every block kind currently shipped by the editor is
// expressed as a plugin so the core has no per-kind switches.
//
// M1 keeps `table` and `columns` here alongside the text-bearing built-ins.
// M2 will extract them into a separate first-party `cellsPlugin` module
// (still registered by default) — the structure here is already plugin-shaped
// so the migration is a file move.
// ---------------------------------------------------------------------------

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
import { collectRuns, escapeHtml, runsToHtml } from "../clipboard/inlineHtml";
import {
  deserializeRun,
  serializeRun,
  type SerializedRun,
} from "../model/runSerialize";
import type { BlockDef, EditorPlugin } from "./types";
import { cellsPlugin } from "../plugins/cells";

// ---------------------------------------------------------------------------
// Helpers shared across built-in plugins.
// ---------------------------------------------------------------------------

// Inline runs — HTML parsing/serialization and the JSON wire form both live
// in shared modules driven by the mark registry (see `clipboard/inlineHtml`
// and `model/runSerialize`). They used to be copied here, in `plugins/cells`
// and in `clipboard/htmlParser`, each with its own hard-coded five-mark table.

function numAttr(el: HTMLElement, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Validate a pasted image `src` at the model boundary. Strips control chars
 * (used to smuggle a scheme past naive filters, e.g. "java\nscript:") and
 * allows only scheme-less/relative URLs, http(s), and data:image/ — rejecting
 * javascript:, vbscript:, and non-image data: URIs. Returns null to drop the
 * image entirely when the src is unsafe.
 */
function safeImageSrc(raw: string): string | null {
  const s = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (s === "") return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!scheme) return s; // relative / scheme-less — no protocol to abuse
  const proto = scheme[1]!.toLowerCase();
  if (proto === "http" || proto === "https") return s;
  if (proto === "data" && /^data:image\//i.test(s)) return s;
  return null;
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
      const src = safeImageSrc(el.getAttribute("src") ?? "");
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
