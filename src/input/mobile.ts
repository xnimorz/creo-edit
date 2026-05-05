import type { Store } from "creo";
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
// When the soft keyboard opens, iOS shrinks the *visual* viewport without
// changing the *layout* viewport. We listen to `visualViewport.resize` and
// keep the editor's caret block in the upper third of whatever space is
// still visible. Also exposes `--creo-vv-height` / `--creo-vv-top` CSS
// custom properties so host pages can react (e.g. position floating UI
// above the keyboard).
// ---------------------------------------------------------------------------

export type ViewportStores = {
  selStore: Store<Selection>;
  docStore: Store<DocState>;
};

export type ViewportHandle = { destroy: () => void };

export function attachVisualViewport(
  root: HTMLElement,
  stores: ViewportStores,
): ViewportHandle {
  if (typeof window === "undefined") return { destroy: () => {} };
  const vv = (window as Window & {
    visualViewport?: VisualViewport;
  }).visualViewport;
  if (!vv) return { destroy: () => {} };

  const apply = () => {
    root.style.setProperty("--creo-vv-height", `${vv.height}px`);
    root.style.setProperty("--creo-vv-top", `${vv.offsetTop}px`);
    scrollCaretIntoUpperThird(root, stores);
  };

  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);

  return {
    destroy() {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    },
  };
}

function scrollCaretIntoUpperThird(
  root: HTMLElement,
  stores: ViewportStores,
): void {
  const sel = stores.selStore.get();
  const at = sel.kind === "caret" ? sel.at : sel.focus;
  const blockEl = root.querySelector(
    `[data-block-id="${at.blockId.replace(/"/g, '\\"')}"]`,
  ) as HTMLElement | null;
  if (!blockEl) return;
  const rect = blockEl.getBoundingClientRect();
  const vv = (window as Window & { visualViewport?: VisualViewport })
    .visualViewport;
  if (!vv) return;
  const vvTop = vv.offsetTop;
  const vvBottom = vvTop + vv.height;
  if (rect.top >= vvTop && rect.bottom <= vvBottom) return;
  const desiredTop = vvTop + vv.height / 3;
  const dy = rect.top - desiredTop;
  const scrollEl = findScrollableAncestor(root);
  if (scrollEl === window) {
    window.scrollTo({ top: window.scrollY + dy, behavior: "smooth" });
  } else {
    (scrollEl as HTMLElement).scrollTop += dy;
  }
}

function findScrollableAncestor(el: HTMLElement): HTMLElement | Window {
  let cur: HTMLElement | null = el;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (
      /(auto|scroll|overlay)/.test(
        style.overflowY + style.overflowX + style.overflow,
      )
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return window;
}
