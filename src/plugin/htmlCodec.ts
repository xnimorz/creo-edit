// ---------------------------------------------------------------------------
// HTML codec registry — paste-in / copy-out per block kind.
//
// Two indexes:
//   - parserByTag:    HTML tag → ordered parser fns (registration order)
//   - serializerByType: block.type → serialize fn
//
// Multiple plugins can claim the same tag (e.g. calendar + date-marker both
// match <div>). The parser tries each in registration order and takes the
// first that returns a block, so a declining parser (returns null) yields to
// the next, and ultimately to the generic walkers. Serialization is fully
// driven by registry entries — every built-in block kind registers a
// serializer so docToHtml / selectionToClipboard need no per-kind switch.
// ---------------------------------------------------------------------------

import type { Block, BlockSpec } from "../model/types";
import type { HtmlBlockCodec, HtmlParseCtx } from "./types";

type ParserFn = (el: HTMLElement, ctx: HtmlParseCtx) => BlockSpec | null;
type SerializerFn = (b: Block) => string;

const parsersByTag = new Map<string, ParserFn[]>();
const serializerByType = new Map<string, SerializerFn>();

export function registerHtmlBlockCodec(type: string, codec: HtmlBlockCodec): void {
  if (codec.parseHTML && codec.matchHTML) {
    for (const tag of codec.matchHTML) {
      const list = parsersByTag.get(tag);
      if (!list) {
        parsersByTag.set(tag, [codec.parseHTML]);
      } else if (!list.includes(codec.parseHTML)) {
        // Dedup by identity so re-installing the same plugin across editor
        // instances doesn't grow the chain (plugin parseHTML fns are stable
        // module-level references); distinct parsers for a tag still chain.
        list.push(codec.parseHTML);
      }
    }
  }
  if (codec.serializeHTML) {
    serializerByType.set(type, codec.serializeHTML);
  }
}

export function getHtmlParserForTag(tag: string): ParserFn | null {
  const list = parsersByTag.get(tag);
  if (!list || list.length === 0) return null;
  if (list.length === 1) return list[0]!;
  return (el, ctx) => {
    for (const parse of list) {
      const block = parse(el, ctx);
      if (block) return block;
    }
    return null;
  };
}

export function getHtmlSerializer(type: string): SerializerFn | null {
  return serializerByType.get(type) ?? null;
}
