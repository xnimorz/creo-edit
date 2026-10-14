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

/**
 * The element to scroll to bring `el` into view: the nearest ancestor that
 * overflows vertically, `window` if there is none, or null if an
 * `overflow: hidden` ancestor clips `el` first.
 *
 * Stricter than `scrollAncestor`, which must accept a scroller that doesn't
 * overflow yet. Overflow is checked with `scrollHeight > clientHeight`
 * because `overflow-x: auto` also computes `overflow-y` to `auto`. A hidden
 * box that doesn't overflow (clearfix, rounded corners) is skipped.
 */
export function revealScroller(el: HTMLElement): HTMLElement | Window | null {
  let cur: HTMLElement | null = parentAcrossShadow(el);
  while (cur && cur !== document.body && cur !== document.documentElement) {
    let overflowY: string;
    try {
      overflowY = window.getComputedStyle(cur).overflowY;
    } catch {
      return null;
    }
    const overflows = cur.scrollHeight > cur.clientHeight;
    if (overflows && /^(auto|scroll|overlay)$/.test(overflowY)) return cur;
    if (overflows && /^(hidden|clip)$/.test(overflowY)) return null;
    cur = parentAcrossShadow(cur);
  }
  return window;
}

function parentAcrossShadow(el: HTMLElement): HTMLElement | null {
  if (el.parentElement) return el.parentElement;
  const host = (el.getRootNode() as { host?: Element }).host;
  return (host as HTMLElement | undefined) ?? null;
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
