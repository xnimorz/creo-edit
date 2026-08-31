// ---------------------------------------------------------------------------
// Unknown block types — preserve-and-passthrough.
//
// `deserializeDoc` used to drop any block whose type had no registered
// serialize codec, silently. A document saved with a plugin installed and
// reopened without it lost those blocks outright, and the loss only became
// permanent on the next save — the classic shape of silent data loss.
//
// Instead, the first time an unknown type is seen we register a full
// passthrough kit for it: an atomic anchor codec (the caret can sit before or
// after it, never inside), a placeholder view so it occupies real layout, and
// a serialize codec that hands back exactly the JSON that came in. The block
// survives a load → edit → save round trip untouched.
//
// If the real plugin is installed afterwards its registrations replace these,
// because the plugin registry is last-write-wins per type — and `createEditor`
// installs plugins before it deserializes, so a plugin that IS present always
// wins.
// ---------------------------------------------------------------------------

import { div, view } from "creo";
import { atomicCodec, registerAnchorCodec } from "./anchorCodec";
import { registerAtomic } from "./atomic";
import { registerSerializeCodec } from "./serializeCodec";
import { registerTextBearing } from "./textBearing";
import { getView, registerView, type BlockViewProps } from "./registry";
import type { Block, BlockId, BlockSpec } from "../model/types";

/** Where the untouched wire payload rides on the model block. */
export const OPAQUE_PAYLOAD = "__creoOpaqueBlock";

export type OpaqueBlock = {
  id: BlockId;
  index: string;
  type: string;
  [OPAQUE_PAYLOAD]: Record<string, unknown>;
};

export function isOpaqueBlock(b: Block): boolean {
  return OPAQUE_PAYLOAD in (b as object);
}

/**
 * Placeholder for a block whose plugin isn't installed. Non-editable and
 * visibly marked rather than invisible: a user who opens a document in a
 * client missing a plugin should see that something is there, not a gap.
 */
const UnknownBlockView = view<BlockViewProps>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    div({
      "data-block-id": b.id,
      "data-block-kind": b.type,
      "data-creo-unknown": "true",
      contenteditable: "false",
      class: "ce-unknown-block",
      title: `Unsupported block type "${b.type}"`,
    });
  },
}));

const registered = new Set<string>();

/** Register the passthrough kit for `type`, once. */
export function registerUnknownBlockType(type: string): void {
  if (registered.has(type)) return;
  registered.add(type);
  registerAtomic(type);
  registerTextBearing(type, false);
  registerAnchorCodec(type, atomicCodec);
  // Don't stomp a view someone already registered for this type.
  if (!getView(type)) registerView(type, UnknownBlockView);
  registerSerializeCodec(type, {
    serialize(b) {
      // Round-trip the original payload verbatim, with the (possibly
      // generated) id we gave it so the block keeps its identity.
      return { ...(b as unknown as OpaqueBlock)[OPAQUE_PAYLOAD], id: b.id, type: b.type };
    },
    deserialize(s, id) {
      const raw = (s ?? {}) as Record<string, unknown>;
      return {
        id,
        type: String(raw.type ?? type),
        [OPAQUE_PAYLOAD]: raw,
      } as unknown as BlockSpec;
    },
  });
}
