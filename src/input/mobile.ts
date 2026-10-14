import type { Store } from "creo";
import { anchorToDom } from "../dom/anchorMap";
import { revealScroller } from "../dom/scroll";
import type { DocState, Selection } from "../model/types";

// ---------------------------------------------------------------------------
// Coarse-pointer detection — true on phones / tablets, false on desktop.
// Runtime-checked once and cached.
// ---------------------------------------------------------------------------

let __coarsePointer: boolean | null = null;
export function isCoarsePointer(): boolean {
  if (__coarsePointer != null) return __coarsePointer;
  if (typeof window === "undefined" || !window.matchMedia) {
    __coarsePointer = false;
    return false;
  }
  __coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  return __coarsePointer;
}

/** Test-only override (clears the cache so the next read re-detects). */
export function __resetCoarsePointerCache(): void {
  __coarsePointer = null;
}

// ---------------------------------------------------------------------------
// Visual viewport tracking
//
// The soft keyboard shrinks the visual viewport and can cover the caret.
// When the viewport shrinks, the focused editor scrolls the minimum needed to
// show its caret again, if the caret was visible before.
//
// It does not react to `visualViewport.scroll` (iOS fires it on every pan
// with the keyboard up), to unfocused or read-only editors, or on mount.
// Each of those caused scroll jumps.
//
// Also writes `--creo-vv-height` / `--creo-vv-top` on the root, once per
// frame and only when they change.
// ---------------------------------------------------------------------------

export type ViewportStores = {
  selStore: Store<Selection>;
  docStore: Store<DocState>;
};

export type ViewportOptions = {
  isEditable: () => boolean;
  /** `EditorOptions.keepCaretVisible`. */
  keepCaretVisible: boolean;
};

export type ViewportHandle = { destroy: () => void };

/** Vertical extent of the visual viewport, in client coordinates. */
type ViewportBox = { top: number; height: number };

/** Gap kept between the caret and the visible edge. */
const REVEAL_MARGIN = 24;

export function attachVisualViewport(
  root: HTMLElement,
  stores: ViewportStores,
  opts: ViewportOptions,
): ViewportHandle {
  if (typeof window === "undefined") return { destroy: () => {} };
  const vv = (window as Window & {
    visualViewport?: VisualViewport;
  }).visualViewport;
  if (!vv) return { destroy: () => {} };

  let lastHeight = vv.height;
  let lastTop = vv.offsetTop;
  let lastScale = vv.scale;
  // Viewport before the current series of shrinks. The keyboard can open
  // over several resize events, so this is kept until the viewport grows.
  let before: ViewportBox | null = null;
  let reveal = false;
  let scheduled = false;
  let destroyed = false;

  const flush = () => {
    scheduled = false;
    if (destroyed) return;
    setIfChanged(root, "--creo-vv-height", `${vv.height}px`);
    setIfChanged(root, "--creo-vv-top", `${vv.offsetTop}px`);
    if (!reveal) return;
    reveal = false;
    if (before && opts.isEditable() && ownsFocus(root)) {
      revealCaret(root, stores, { top: vv.offsetTop, height: vv.height }, before);
    }
  };
  // At most one flush per frame. Tests have no rAF, so fall back to a microtask.
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(flush);
    else queueMicrotask(flush);
  };

  const onResize = () => {
    // Only a shrink can cover the caret. A scale change is a pinch-zoom.
    if (
      opts.keepCaretVisible &&
      vv.scale === lastScale &&
      vv.height < lastHeight - 1
    ) {
      before ??= { top: lastTop, height: lastHeight };
      reveal = true;
    } else {
      before = null;
    }
    lastHeight = vv.height;
    lastTop = vv.offsetTop;
    lastScale = vv.scale;
    schedule();
  };
  // A pan only updates `--creo-vv-top`.
  const onScroll = () => {
    lastTop = vv.offsetTop;
    schedule();
  };

  flush();
  vv.addEventListener("resize", onResize);
  vv.addEventListener("scroll", onScroll);

  return {
    destroy() {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onScroll);
      destroyed = true;
    },
  };
}

function setIfChanged(el: HTMLElement, name: string, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/** Focus is on the root, or inside it but not inside a nested editor. */
function ownsFocus(root: HTMLElement): boolean {
  const active = (root.getRootNode() as Document | ShadowRoot).activeElement;
  if (!active) return false;
  if (active === root) return true;
  return root.contains(active) && active.closest("[data-creo-edit]") === root;
}

function revealCaret(
  root: HTMLElement,
  stores: ViewportStores,
  now: ViewportBox,
  before: ViewportBox,
): void {
  const caret = caretRect(root, stores);
  if (!caret) return;
  const scroller = revealScroller(root);
  if (!scroller) return;

  // Caret was already off screen: the user scrolled away, so leave it.
  const was = visibleBand(scroller, before);
  if (caret.bottom <= was.top || caret.top >= was.bottom) return;
  const { top, bottom } = visibleBand(scroller, now);

  // Scroll the minimum distance, with a margin if there is room.
  const margin = Math.min(
    REVEAL_MARGIN,
    Math.max(0, (bottom - top - caret.height) / 2),
  );
  let dy = 0;
  if (caret.top < top + margin) dy = caret.top - (top + margin);
  else if (caret.bottom > bottom - margin) dy = caret.bottom - (bottom - margin);
  if (dy === 0) return;

  const behavior: ScrollBehavior = prefersReducedMotion() ? "auto" : "smooth";
  // Absolute target, so a resize during a smooth scroll still lands right.
  if (scroller === window) {
    window.scrollTo({ top: window.scrollY + dy, behavior });
  } else {
    const el = scroller as HTMLElement;
    el.scrollTo({ top: el.scrollTop + dy, behavior });
  }
}

/**
 * Visible area: the visual viewport intersected with the scroller and its
 * clipping ancestors, minus the scroller's `scroll-padding`.
 */
function visibleBand(
  scroller: HTMLElement | Window,
  vv: ViewportBox,
): { top: number; bottom: number } {
  let top = vv.top;
  let bottom = vv.top + vv.height;
  const clipTo = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    top = Math.max(top, r.top + el.clientTop);
    bottom = Math.min(bottom, r.top + el.clientTop + el.clientHeight);
  };
  let padded = document.documentElement;
  if (scroller !== window) {
    padded = scroller as HTMLElement;
    clipTo(padded);
    for (let el = padded.parentElement; el && el !== document.body; el = el.parentElement) {
      if (/^(auto|scroll|overlay|hidden|clip)$/.test(window.getComputedStyle(el).overflowY)) {
        clipTo(el);
      }
    }
  }
  const pad = window.getComputedStyle(padded);
  return {
    top: top + px(pad.scrollPaddingTop),
    bottom: bottom - px(pad.scrollPaddingBottom),
  };
}

/**
 * Rect of the caret (the focus end of a range), not of its block. Uses the
 * native selection when it is inside this editor, else the model selection.
 */
function caretRect(
  root: HTMLElement,
  stores: ViewportStores,
): { top: number; bottom: number; height: number } | null {
  let node: Node | null = null;
  let offset = 0;
  const native = root.ownerDocument.getSelection?.();
  if (native?.focusNode && root.contains(native.focusNode)) {
    node = native.focusNode;
    offset = native.focusOffset;
  } else {
    const sel = stores.selStore.get();
    const point = anchorToDom(sel.kind === "caret" ? sel.at : sel.focus, root);
    if (!point) return null;
    node = point.node;
    offset = point.offset;
  }
  const range = root.ownerDocument.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const r = range.getBoundingClientRect();
  if (r.height > 0) return r;
  // A collapsed range between elements (empty paragraph) has no rect.
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return el ? el.getBoundingClientRect() : null;
}

function px(v: string): number {
  return v.endsWith("px") ? parseFloat(v) || 0 : 0;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
