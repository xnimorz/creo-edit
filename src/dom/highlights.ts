// ---------------------------------------------------------------------------
// CSS Custom Highlight API shim.
//
// Painting ranges through `CSS.highlights` is the only way to decorate
// arbitrary, overlapping spans of text without touching the DOM — no span
// splitting, no fighting whatever run structure the model already has, and
// nothing for the anchor map's character walk to trip over.
//
// This module is the single place that touches the API. The search plugin and
// the public range-decoration manager both go through it.
// ---------------------------------------------------------------------------

type HighlightCtor = new (...ranges: AbstractRange[]) => Highlight;

type HighlightRegistry = {
  set(name: string, value: Highlight): void;
  delete(name: string): void;
  get?(name: string): Highlight | undefined;
};

type CSSWithHighlights = typeof CSS & {
  highlights?: HighlightRegistry;
};

/**
 * Whether this environment can paint range decorations.
 *
 * Chromium (so Electron) has had the API since 105; Safari since 17.2.
 * Firefox shipped it in 140. When this returns false, `setHighlight` is a
 * no-op and NOTHING is painted — there is no DOM fallback, because a DOM
 * fallback would have to split runs and would then be visible to the
 * character-offset walk. Hosts that need to degrade should branch on
 * `editor.supportsRangeDecorations()` and render their own affordance
 * (e.g. a gutter marker via a sub-block decoration) instead.
 */
export function isHighlightApiSupported(): boolean {
  if (typeof CSS === "undefined") return false;
  return (
    Boolean((CSS as CSSWithHighlights).highlights) &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === "function"
  );
}

function registry(): HighlightRegistry | null {
  if (!isHighlightApiSupported()) return null;
  return (CSS as CSSWithHighlights).highlights ?? null;
}

/**
 * Register `ranges` under the highlight name `name`, which the host styles
 * with `::highlight(name)`. Always call it — even with an empty list — so a
 * previous paint under the same name clears.
 *
 * `priority` decides who wins where two highlights overlap; higher paints on
 * top. Returns false when the API is unavailable.
 */
export function setHighlight(
  name: string,
  ranges: readonly AbstractRange[],
  priority = 0,
): boolean {
  const reg = registry();
  if (!reg) return false;
  const Ctor = (globalThis as unknown as { Highlight: HighlightCtor }).Highlight;
  const hl = new Ctor(...ranges);
  // `priority` is a plain property on Highlight; guard the assignment so an
  // older implementation without it doesn't throw in strict mode.
  try {
    (hl as Highlight & { priority?: number }).priority = priority;
  } catch {
    // Non-writable in this engine — ordering falls back to insertion order.
  }
  reg.set(name, hl);
  return true;
}

export function deleteHighlight(name: string): void {
  registry()?.delete(name);
}
