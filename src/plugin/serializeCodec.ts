// ---------------------------------------------------------------------------
// JSON SerializedBlock codec registry — toJSON / setDoc round-trip per
// block kind. The createEditor serializer/deserializer walks doc.order and
// dispatches to the registered codec by `block.type`. Plugins must register
// a codec for any block kind they want to survive setDoc / toJSON.
// ---------------------------------------------------------------------------

import type { Block, BlockId, BlockSpec } from "../model/types";
import type { SerializeCodec } from "./types";

const codecByType = new Map<string, SerializeCodec>();

export function registerSerializeCodec(type: string, codec: SerializeCodec): void {
  codecByType.set(type, codec);
}

export function getSerializeCodec(type: string): SerializeCodec | null {
  return codecByType.get(type) ?? null;
}

// `locked` belongs to every block type, so it is carried here rather than by
// each type's codec.
export function serializeBlock(b: Block): unknown | null {
  const c = codecByType.get(b.type);
  if (!c) return null;
  const out = c.serialize(b);
  return b.locked === true && out !== null && typeof out === "object"
    ? { ...(out as object), locked: true }
    : out;
}

export function deserializeBlock(type: string, s: unknown, id: BlockId): BlockSpec | null {
  const c = codecByType.get(type);
  if (!c) return null;
  const out = c.deserialize(s, id);
  return out !== null && (s as { locked?: unknown } | null)?.locked === true
    ? ({ ...out, locked: true } as BlockSpec)
    : out;
}
