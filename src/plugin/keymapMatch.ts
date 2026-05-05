// ---------------------------------------------------------------------------
// Plugin keymap matcher — evaluates KeymapDef[] against a keyboard event in
// registration order. The first entry whose chord matches AND whose `when`
// predicate (if any) returns true wins.
//
// Chord syntax:
//   tokens joined by "+", e.g. "Tab", "Shift+Tab", "Mod+B", "Mod+Shift+S".
//   Modifiers: Mod (Cmd on Mac, Ctrl elsewhere), Shift, Alt, Ctrl, Meta.
//   Final token = e.key value (case-insensitive for single chars).
//
// Matching is STRICT on modifiers: "Tab" matches only when no modifier is
// held; "Shift+Tab" matches only when Shift (and only Shift) is held. This
// avoids ambiguous overlaps when a plugin registers both.
// ---------------------------------------------------------------------------

import type { CommandCtx, KeymapDef } from "./types";
import { isMac } from "../input/keymap";

type ParsedChord = {
  key: string;
  shift: boolean;
  alt: boolean;
  // After resolving Mod → meta on Mac / ctrl elsewhere.
  meta: boolean;
  ctrl: boolean;
};

function parseChord(chord: string): ParsedChord {
  const parts = chord.split("+");
  const last = parts[parts.length - 1] ?? "";
  let shift = false;
  let alt = false;
  let meta = false;
  let ctrl = false;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i] ?? "";
    if (m === "Shift") shift = true;
    else if (m === "Alt") alt = true;
    else if (m === "Mod") {
      if (isMac()) meta = true;
      else ctrl = true;
    } else if (m === "Meta" || m === "Cmd") meta = true;
    else if (m === "Ctrl" || m === "Control") ctrl = true;
  }
  return { key: last, shift, alt, meta, ctrl };
}

function eqKey(eventKey: string, chordKey: string): boolean {
  if (eventKey === chordKey) return true;
  if (eventKey.length === 1 && chordKey.length === 1) {
    return eventKey.toLowerCase() === chordKey.toLowerCase();
  }
  return false;
}

function chordMatches(e: KeyboardEvent, c: ParsedChord): boolean {
  if (!eqKey(e.key, c.key)) return false;
  if (e.shiftKey !== c.shift) return false;
  if (e.altKey !== c.alt) return false;
  if (e.metaKey !== c.meta) return false;
  if (e.ctrlKey !== c.ctrl) return false;
  return true;
}

const cache = new Map<string, ParsedChord>();
function chordOf(s: string): ParsedChord {
  let p = cache.get(s);
  if (!p) {
    p = parseChord(s);
    cache.set(s, p);
  }
  return p;
}

export function matchPluginKeymap(
  e: KeyboardEvent,
  entries: KeymapDef[],
  ctx: CommandCtx,
): KeymapDef | null {
  for (const entry of entries) {
    if (!chordMatches(e, chordOf(entry.chord))) continue;
    if (entry.when && !entry.when(ctx)) continue;
    return entry;
  }
  return null;
}
