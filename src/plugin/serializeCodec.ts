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

export function serializeBlock(b: Block): unknown | null {
  const c = codecByType.get(b.type);
  if (!c) return null;
  return c.serialize(b);
}

export function deserializeBlock(type: string, s: unknown, id: BlockId): BlockSpec | null {
  const c = codecByType.get(type);
  if (!c) return null;
  return c.deserialize(s, id);
}
