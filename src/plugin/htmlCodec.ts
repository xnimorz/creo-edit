// ---------------------------------------------------------------------------
// HTML codec registry — paste-in / copy-out per block kind.
//
// Two indexes:
//   - parserByTag:    HTML tag → parser fn (first plugin registered wins)
//   - serializerByType: block.type → serialize fn
//
// The HTML parser walks fragment children and calls the parser for the
// first matched tag, falling through to the generic walkers for unknown
// elements (block-element-wrap-into-paragraph, etc.). Serialization is
// fully driven by registry entries — every built-in block kind registers a
// serializer so docToHtml / selectionToClipboard need no per-kind switch.
// ---------------------------------------------------------------------------

import type { Block, BlockSpec } from "../model/types";
import type { HtmlBlockCodec, HtmlParseCtx } from "./types";

type ParserFn = (el: HTMLElement, ctx: HtmlParseCtx) => BlockSpec | null;
type SerializerFn = (b: Block) => string;

const parserByTag = new Map<string, ParserFn>();
const serializerByType = new Map<string, SerializerFn>();

export function registerHtmlBlockCodec(type: string, codec: HtmlBlockCodec): void {
  if (codec.parseHTML && codec.matchHTML) {
    for (const tag of codec.matchHTML) {
      // First registration wins — built-ins land before user plugins.
      if (!parserByTag.has(tag)) parserByTag.set(tag, codec.parseHTML);
    }
  }
  if (codec.serializeHTML) {
    serializerByType.set(type, codec.serializeHTML);
  }
}

export function getHtmlParserForTag(tag: string): ParserFn | null {
  return parserByTag.get(tag) ?? null;
}

export function getHtmlSerializer(type: string): SerializerFn | null {
  return serializerByType.get(type) ?? null;
}
