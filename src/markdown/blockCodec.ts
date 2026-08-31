// ---------------------------------------------------------------------------
// Markdown block codec registry — module-global, keyed by block type.
//
// `docToMarkdown`'s switch is exhaustive over the closed built-in union, so a
// plugin block used to serialize to nothing at all. A plugin registers here
// (via `BlockDef.markdownCodec`) and its blocks join the markdown output; a
// registration for a built-in type overrides the built-in rendering.
//
// The codec receives the SERIALIZED block, not the model block, because
// markdown serialization runs off `toJSON()` output — one walk of the
// document serves both the JSON and the markdown consumer.
// ---------------------------------------------------------------------------

export type MarkdownBlockCodec = {
  /**
   * Markdown for one block. Return `null` to decline (the built-in handling
   * runs instead, and unknown types are skipped).
   *
   * `state` carries the list-run bookkeeping `docToMarkdown` threads through
   * consecutive `li` blocks; a codec that isn't a list item can ignore it.
   */
  serialize(
    block: { type: string; [k: string]: unknown },
    state: { listKind: "ul" | "ol" | null; olCounter: number },
  ): string | null;
};

const codecByType = new Map<string, MarkdownBlockCodec>();

export function registerMarkdownCodec(
  type: string,
  codec: MarkdownBlockCodec,
): void {
  codecByType.set(type, codec);
}

export function getMarkdownCodec(type: string): MarkdownBlockCodec | null {
  return codecByType.get(type) ?? null;
}
