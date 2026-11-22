// ---------------------------------------------------------------------------
// The mermaid block: definition and codecs.
//
// Atomic — the caret sits before or after it, never inside; the source is one
// string attribute. What the block looks like is `view.ts`; this file is what
// it IS in JSON, HTML and markdown.
//
// Interop is the point of the codecs. A diagram leaves as the thing every
// markdown tool already understands — a fenced block tagged `mermaid` — in
// both the markdown and the HTML flavour (`<pre><code class="language-mermaid">`),
// and comes back from that same shape.
// ---------------------------------------------------------------------------

import {
  newBlockId,
  type Block,
  type BlockDef,
  type BlockSpec,
  type SerializedDocLike,
} from "creo-edit";
import { MERMAID_TYPE, type MermaidBlock } from "./types";
import { MermaidView } from "./view";

export const isMermaidBlock = (b: Block | undefined | null): boolean =>
  !!b && (b as { type: string }).type === MERMAID_TYPE;

/** The block as a `MermaidBlock`, or null if it is something else. */
export const asMermaid = (b: Block | undefined | null): MermaidBlock | null =>
  isMermaidBlock(b) ? (b as unknown as MermaidBlock) : null;

export function mermaidSpec(source: string, id: string = newBlockId()): BlockSpec {
  return { id, type: MERMAID_TYPE, source } as unknown as BlockSpec;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The mermaid source inside an element, if the element is a mermaid fence. */
function sourceOf(el: HTMLElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "pre") {
    const code = el.querySelector("code");
    const marked =
      el.getAttribute("data-block-kind") === MERMAID_TYPE ||
      el.classList.contains("mermaid") ||
      (!!code && /(^|\s)(language|lang)-mermaid(\s|$)/.test(code.className));
    return marked ? ((code ?? el).textContent ?? "") : null;
  }
  // `<div class="mermaid">` is how pages that run mermaid.js mark a diagram.
  // An already-rendered one holds an <svg>, not source — leave that alone.
  if (tag === "div" && el.classList.contains("mermaid") && !el.querySelector("svg")) {
    return el.textContent ?? "";
  }
  return null;
}

/** Shortest fence that the source does not itself contain. */
function fenceFor(source: string): string {
  let longest = 0;
  for (const m of source.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export const mermaidBlockDef: BlockDef<Block> = {
  type: MERMAID_TYPE as Block["type"],
  view: MermaidView as BlockDef<Block>["view"],
  isTextBearing: false,
  isAtomic: true,
  htmlCodec: {
    matchHTML: ["pre", "div"],
    parseHTML(el) {
      const source = sourceOf(el);
      // null declines: an ordinary <pre> goes on to the built-in code parser.
      return source === null ? null : mermaidSpec(source.replace(/\n$/, ""));
    },
    serializeHTML(b) {
      const source = asMermaid(b)?.source ?? "";
      return `<pre data-block-kind="${MERMAID_TYPE}"><code class="language-mermaid">${escapeHtml(source)}</code></pre>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const m = b as unknown as MermaidBlock;
      return { id: m.id, type: MERMAID_TYPE, source: m.source };
    },
    deserialize(s, id) {
      const source = (s as { source?: unknown } | null)?.source;
      return mermaidSpec(typeof source === "string" ? source : "", id);
    },
  },
  markdownCodec: {
    serialize(block) {
      const source = typeof block.source === "string" ? block.source : "";
      const fence = fenceFor(source);
      return `${fence}mermaid\n${source}\n${fence}`;
    },
  },
};

/**
 * `deserializeDoc` step for `adoptCodeBlocks`: a `code` block whose `lang` is
 * "mermaid" — what a markdown parser makes of a mermaid fence — becomes a
 * diagram block, keeping its id.
 */
export function adoptCodeBlocks(doc: SerializedDocLike): SerializedDocLike {
  let changed = false;
  const blocks = doc.blocks.map((b) => {
    if (b.type !== "code" || b.lang !== "mermaid") return b;
    changed = true;
    const runs = Array.isArray(b.runs) ? (b.runs as { text?: unknown }[]) : [];
    const source = runs.map((r) => (typeof r.text === "string" ? r.text : "")).join("");
    return { ...(b.id ? { id: b.id } : {}), type: MERMAID_TYPE, source };
  });
  return changed ? { ...doc, blocks } : doc;
}
