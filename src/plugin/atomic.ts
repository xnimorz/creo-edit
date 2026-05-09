// ---------------------------------------------------------------------------
// Atomic-block registry — module-global Set tracking which block types are
// non-editable "atomic" islands. Atomic blocks have only two valid caret
// positions (before / after) encoded as `path: [side]` where side ∈ {0, 1}.
// They render with `contenteditable="false"` so the browser places the
// caret around the block, not inside it.
//
// Built-in `img` is registered by its plugin definition. Third-party
// plugins (calendar, embeds, formulas, …) opt in by setting
// `BlockDef.isAtomic = true` — the registry installer mirrors the flag
// into this Set so navigation / input / selection code can check the kind
// via a single helper without importing block-specific knowledge.
// ---------------------------------------------------------------------------

const atomicTypes = new Set<string>();

export function registerAtomic(type: string): void {
  atomicTypes.add(type);
}

export function isAtomicBlockType(type: string): boolean {
  return atomicTypes.has(type);
}
