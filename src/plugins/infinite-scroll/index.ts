// ---------------------------------------------------------------------------
// infiniteScrollPlugin — load more blocks as the user scrolls toward an
// edge of the editor's scroll container.
//
// The plugin is generic: it doesn't know what kind of blocks the host
// wants to load. The host supplies `loadBefore` and/or `loadAfter`
// callbacks; the plugin watches scroll position, throttles, and calls
// the callback when the viewport gets close to an edge. On prepend the
// plugin captures `scrollHeight + scrollTop` before the load and
// re-applies the delta after the next frame so the user's view stays
// anchored to whatever they were reading.
//
// Usage:
//
//   createEditor({
//     plugins: [
//       infiniteScrollPlugin({
//         scrollContainer: () => document.querySelector(".my-wrap"),
//         loadAfter: (editor) => editor.appendBlocks(nextDay()),
//         loadBefore: (editor) => editor.prependBlocks(prevDay()),
//       }),
//     ],
//   });
//
// The callbacks should mutate the editor synchronously via
// `editor.appendBlocks` / `editor.prependBlocks`. Async work is fine but
// the scroll-anchoring window is one animation frame — keep mutations
// synchronous when possible.
// ---------------------------------------------------------------------------

import type { BlockId, DistOmit, BlockSpec, DocState, Selection } from "../../model/types";
import type { EditorPlugin } from "../../plugin/types";

// Input shape mirrors the editor's BlockInsertInput — `id` optional so
// the plugin can pass through specs without manufacturing ids itself.
type Input = DistOmit<BlockSpec, "id"> & { id?: BlockId };

// The plugin reaches into the editor only via the public docStore /
// selStore / appendBlocks / prependBlocks surface. We accept a minimal
// shape so the plugin stays decoupled from `Editor` (avoiding a circular
// import with createEditor.ts).
export type InfiniteScrollEditor = {
  docStore: { get: () => DocState; subscribe: (fn: () => void) => () => void };
  selStore: { get: () => Selection };
  appendBlocks: (specs: Input[]) => BlockId[];
  prependBlocks: (specs: Input[]) => BlockId[];
};

export type InfiniteScrollOptions = {
  /**
   * The scrolling element to watch. Either an element, or a getter (the
   * element may not exist at editor-mount time). When omitted, the
   * plugin walks up from the editor root looking for the nearest
   * `overflow-y: auto|scroll` ancestor; falls back to `window`.
   */
  scrollContainer?: HTMLElement | (() => HTMLElement | null);
  /** Called when the user scrolls within `threshold` of the bottom. */
  loadAfter?: (editor: InfiniteScrollEditor) => void;
  /**
   * Called when the user scrolls within `threshold` of the top. The
   * plugin re-anchors `scrollTop` after the load so the viewport doesn't
   * jump.
   */
  loadBefore?: (editor: InfiniteScrollEditor) => void;
  /** Pixel distance from an edge that triggers a load. Default: 240. */
  threshold?: number;
  /**
   * Minimum gap between successive triggers in the SAME direction (ms).
   * Prevents back-to-back appends while the user is mid-flick. Default
   * 60ms — short enough to feel responsive while letting the renderer
   * commit a frame in between.
   */
  cooldownMs?: number;
};

const DEFAULT_THRESHOLD = 240;
const DEFAULT_COOLDOWN = 60;

function isWindowScroll(target: HTMLElement | Window): target is Window {
  return target === window;
}

function findScrollAncestor(start: HTMLElement): HTMLElement | Window {
  let cur: HTMLElement | null = start.parentElement;
  while (cur) {
    const cs = window.getComputedStyle(cur);
    const ov = cs.overflowY + cs.overflow;
    if (/(auto|scroll|overlay)/.test(ov)) return cur;
    cur = cur.parentElement;
  }
  return window;
}

function geometryOf(target: HTMLElement | Window): {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
} {
  if (isWindowScroll(target)) {
    return {
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: window.innerHeight,
    };
  }
  return {
    scrollTop: target.scrollTop,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
  };
}

function setScrollTop(target: HTMLElement | Window, top: number): void {
  if (isWindowScroll(target)) window.scrollTo({ top });
  else target.scrollTop = top;
}

// Schedule `cb` to run after the editor's renderer has committed the
// next batch of DOM mutations and the browser has performed a layout
// pass. We use a microtask + a 0ms timeout instead of `rAF` because some
// environments throttle rAF (background tabs, headless previews) — the
// throttling gates rAF callbacks behind a focus event we never receive,
// so the anchor adjustment never lands. The microtask drains creo's
// scheduler; the setTimeout yields back to the event loop so layout
// runs before we read scrollHeight.
function afterCommit(cb: () => void): void {
  Promise.resolve().then(() => setTimeout(cb, 0));
}

export function infiniteScrollPlugin(opts: InfiniteScrollOptions): EditorPlugin {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN;

  return {
    name: "infinite-scroll",
    decorations: [
      // The plugin doesn't actually need a per-block decoration; we
      // hijack the decoration `mount` lifecycle to attach a single
      // window-level listener. `match` returns true only for the FIRST
      // block in the doc so we don't double-mount. A dedicated
      // "editor lifecycle" hook would be cleaner — flag for later.
      {
        id: "infinite-scroll",
        layer: "absolute",
        match: (b) => b !== null,
        mount(_block, blockEl, host, _handle) {
          // The decoration manager creates one host per (def, block).
          // We don't render any per-block UI — the plugin only needs a
          // SINGLE editor-level scroll listener. Hide every host so the
          // absolute-positioned deco containers don't overlay the
          // editor blocks and steal clicks.
          host.style.display = "none";
          host.style.pointerEvents = "none";

          // Only run the listener / setup ONCE per editor. Subsequent
          // matching blocks land here, hide their host (above), then
          // bail out before re-attaching listeners.
          const editorRoot = blockEl.closest(
            "[data-creo-edit]",
          ) as HTMLElement | null;
          if (!editorRoot) return;
          const FLAG = "__creoInfiniteScrollMounted";
          if ((editorRoot as unknown as Record<string, unknown>)[FLAG]) return;
          (editorRoot as unknown as Record<string, unknown>)[FLAG] = true;

          const editor = (
            editorRoot as unknown as { __creoEdit?: InfiniteScrollEditor }
          ).__creoEdit;
          if (!editor) return;

          const resolveContainer = (): HTMLElement | Window => {
            if (typeof opts.scrollContainer === "function") {
              const el = opts.scrollContainer();
              if (el) return el;
            } else if (opts.scrollContainer) {
              return opts.scrollContainer;
            }
            return findScrollAncestor(editorRoot);
          };

          let lastFiredAt = 0;
          let lastDir: "up" | "down" | null = null;
          let pendingPrependAnchor:
            | { container: HTMLElement | Window; height: number; top: number }
            | null = null;

          // Scroll-event entry-point. Cooldown gates back-to-back
          // firings in the same direction during a single scroll
          // gesture. Each firing produces ONE doc mutation; the next
          // firing has to wait for either the scroll-direction to flip
          // or the cooldown to elapse — that's what keeps user input
          // (clicks, selection changes) from being starved by the
          // editor's renderPending flag during a load.
          const tryFire = (): void => {
            const sc = resolveContainer();
            const g = geometryOf(sc);
            const distFromBottom = g.scrollHeight - g.scrollTop - g.clientHeight;
            const now = Date.now();
            const cooldownOk = (dir: "up" | "down") =>
              lastDir !== dir || now - lastFiredAt > cooldownMs;
            if (opts.loadAfter && distFromBottom < threshold && cooldownOk("down")) {
              lastDir = "down";
              lastFiredAt = now;
              opts.loadAfter(editor);
              return;
            }
            if (opts.loadBefore && g.scrollTop < threshold && cooldownOk("up")) {
              lastDir = "up";
              lastFiredAt = now;
              // Capture geometry BEFORE the load so we can re-anchor.
              pendingPrependAnchor = {
                container: sc,
                height: g.scrollHeight,
                top: g.scrollTop,
              };
              opts.loadBefore(editor);
              return;
            }
          };

          // After every doc change, if a prepend anchor was queued,
          // re-apply scrollTop on the next frame so the user's viewport
          // stays put. We subscribe to docStore (not the scroll event)
          // because the load may be async — we want to wait until the
          // doc actually grew before reading the new scrollHeight.
          const unsubDoc = editor.docStore.subscribe(() => {
            if (!pendingPrependAnchor) return;
            const anchor = pendingPrependAnchor;
            pendingPrependAnchor = null;
            // Two-frame defer: the first frame is when creo's renderer
            // commits the DOM mutation; we read scrollHeight on the
            // SECOND frame after layout has settled. A single rAF
            // measured the OLD height because our docStore subscriber
            // fires synchronously inside set() and our rAF callback
            // queued before creo's renderer ran.
            afterCommit(() => {
              const next = geometryOf(anchor.container);
              const delta = next.scrollHeight - anchor.height;
              if (delta !== 0) {
                setScrollTop(anchor.container, anchor.top + delta);
              }
            });
          });

          const initialContainer = resolveContainer();
          // Listen on whichever container we resolved; if the host swaps
          // the container at runtime they should re-create the editor.
          const listenerTarget = initialContainer as
            | HTMLElement
            | (Window & typeof globalThis);
          const onScroll = (): void => tryFire();
          listenerTarget.addEventListener("scroll", onScroll, { passive: true });

          // No mount-time auto-fill — that historically chained many
          // docStore.set events through the editor's renderPending
          // window and starved user `selectionchange` events. Hosts
          // should seed enough content up-front so the viewport
          // overflows at mount; further loads happen as the user
          // scrolls.

          return () => {
            listenerTarget.removeEventListener("scroll", onScroll);
            unsubDoc();
            (editorRoot as unknown as Record<string, unknown>)[FLAG] = false;
          };
        },
      },
    ],
  };
}
