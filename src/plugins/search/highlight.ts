// ---------------------------------------------------------------------------
// highlight.ts — paint search matches via the CSS Custom Highlight API.
//
// Two named highlights:
//   creo-search          — every visible match (yellow-ish)
//   creo-search-current  — only the active match (orange-ish)
//
// Matches in unmounted blocks (virtualized off-screen) are skipped — they
// have no DOM. The MutationObserver in index.ts re-renders highlights when
// VirtualDoc mounts/unmounts blocks, so a previously-skipped match lights
// up as soon as its block scrolls into view.
// ---------------------------------------------------------------------------

import { anchorToDom } from "../../dom/anchorMap";
import type { SearchMatch } from "./engine";

export const HL_ALL = "creo-search";
export const HL_CURRENT = "creo-search-current";

type HighlightCtor = new (...ranges: AbstractRange[]) => Highlight;
type HighlightRegistry = {
  set(name: string, value: Highlight): void;
  delete(name: string): void;
  get?(name: string): Highlight | undefined;
};
type CSSWithHighlights = typeof CSS & {
  highlights?: HighlightRegistry;
};

export function isHighlightApiSupported(): boolean {
  if (typeof CSS === "undefined") return false;
  return Boolean((CSS as CSSWithHighlights).highlights) && typeof (globalThis as { Highlight?: unknown }).Highlight === "function";
}

function buildRange(
  root: HTMLElement,
  match: SearchMatch,
): Range | null {
  const a = anchorToDom(match.start, root);
  const b = anchorToDom(match.end, root);
  if (!a || !b) return null;
  try {
    const r = new Range();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  } catch {
    return null;
  }
}

/**
 * Sync the named highlights with the current match list and active index.
 *
 * Returns the number of matches that landed in DOM (i.e. mounted). The
 * caller can use it for diagnostics — e.g. if `0 < total`, some matches
 * are off-screen and waiting on virtualization to mount their blocks.
 */
export function paintHighlights(
  root: HTMLElement,
  matches: readonly SearchMatch[],
  activeIndex: number,
): number {
  if (!isHighlightApiSupported()) return 0;
  const css = CSS as CSSWithHighlights;
  const highlights = css.highlights!;
  const Hi = (globalThis as unknown as { Highlight: HighlightCtor }).Highlight;

  const allRanges: Range[] = [];
  let currentRange: Range | null = null;
  let mounted = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const r = buildRange(root, m);
    if (!r) continue;
    mounted++;
    if (i === activeIndex) currentRange = r;
    else allRanges.push(r);
  }
  // Always set the "all" highlight even if empty so prior matches clear.
  highlights.set(HL_ALL, new Hi(...allRanges));
  if (currentRange) {
    highlights.set(HL_CURRENT, new Hi(currentRange));
  } else {
    highlights.delete(HL_CURRENT);
  }
  return mounted;
}

export function clearHighlights(): void {
  if (!isHighlightApiSupported()) return;
  const css = CSS as CSSWithHighlights;
  css.highlights!.delete(HL_ALL);
  css.highlights!.delete(HL_CURRENT);
}
