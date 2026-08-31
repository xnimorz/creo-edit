// ---------------------------------------------------------------------------
// Text-bearing block registry — module-global Set mirroring the atomic-block
// registry next door (./atomic).
//
// "Text-bearing" means the block has a top-level `runs: InlineRun[]` that the
// text commands operate on directly. `setBlockType`, `splitBlock`,
// `mergeBackward`, `toggleMark` and the clipboard serializer all gate on it,
// so a plugin block that is NOT registered here is inert to all of them —
// which is what made Enter inside a plugin `task` block do nothing.
//
// `BlockDef.isTextBearing` is mirrored into this Set by `Registry.install`.
// When the flag is omitted it is inferred: an atomic block is never
// text-bearing, a block that ships a custom `runsAt` addresses nested slots
// rather than a top-level `runs` field, and everything else is assumed to
// carry `runs`. `isTextBearing(block)` still confirms the field exists at
// runtime, so a mis-declared flag degrades to "not text-bearing" rather than
// throwing halfway through a command.
// ---------------------------------------------------------------------------

const textBearingTypes = new Set<string>([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "code",
]);

export function registerTextBearing(type: string, isTextBearing: boolean): void {
  if (isTextBearing) textBearingTypes.add(type);
  else textBearingTypes.delete(type);
}

export function isTextBearingType(type: string): boolean {
  return textBearingTypes.has(type);
}
