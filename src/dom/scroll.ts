// ---------------------------------------------------------------------------
// Scroll-container resolution.
//
// `scroll` does not bubble. An editor living inside its own `overflow: auto`
// pane therefore never delivers a scroll event to `window` — anything that
// listens there sees nothing when the text actually moves, and gets a
// pointless wake-up every time the surrounding PAGE moves instead. Both wrong
// directions at once, which is why viewport-sensitive machinery (the
// virtualizer, the range-decoration manager, the inline-widget manager) all
// resolve their scroller through here rather than reaching for `window`.
// ---------------------------------------------------------------------------

/**
 * Nearest ancestor of `el` that actually scrolls, or null when the page
 * itself is the scroller.
 *
 * `getComputedStyle` in a headless environment can throw or return a
 * partially-filled object; treat that as "no scrollable ancestor" rather than
 * taking the caller down.
 */
export function scrollAncestor(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    try {
      const style = window.getComputedStyle(cur);
      if (
        /(auto|scroll|overlay)/.test(
          `${style.overflowY}${style.overflowX}${style.overflow}`,
        )
      ) {
        return cur;
      }
    } catch {
      return null;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** The thing to attach a `scroll` listener to for `el`: its scrollable
 *  ancestor when it has one, else `window`. */
export function scrollSourceFor(el: HTMLElement): HTMLElement | Window {
  return scrollAncestor(el) ?? window;
}

/** Current scroll offset of whatever scrolls `el`. */
export function scrollTopOf(el: HTMLElement): number {
  const sc = scrollAncestor(el);
  if (sc) return sc.scrollTop;
  return window.scrollY ?? document.documentElement.scrollTop ?? 0;
}
