// ---------------------------------------------------------------------------
// searchPlugin — in-page find for the editor.
//
// Works as an optional plugin. When `interceptBrowserFind: true`, claims
// `Mod+F` and prevents the browser's find UI from opening. Searches every
// loaded block in `docStore` (including those virtualized off-screen),
// highlights matches via the CSS Custom Highlight API, and scrolls the
// active match into view — handing virtualized off-screen blocks to
// `editor.scrollToBlock` so the height-index resolves the right Y.
//
// Hosts using `infiniteScrollPlugin` can supply `opts.source` so search
// queries hit a backend; `source.ensureLoaded(blockId)` is called before
// jump-to-match for blocks not currently in docStore.
//
// The default UI is a small floating panel, top-right of the editor. Hosts
// can replace it by passing `opts.renderUI`.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { BlockId, DocState, Selection } from "../../model/types";
import type { CommandCtx, EditorPlugin } from "../../plugin/types";
import { searchDoc, type SearchMatch, type SearchOpts } from "./engine";
import {
  clearHighlights,
  paintHighlights,
} from "./highlight";
import { jumpToMatch, nextIndex, prevIndex } from "./navigate";
import { ensureStylesInjected } from "./styles";
import { mountDefaultPanel } from "./ui";
import type {
  SearchController,
  SearchOptions,
  SearchSource,
  SearchState,
  SearchToggle,
} from "./types";

export type {
  SearchController,
  SearchOptions,
  SearchSource,
  SearchState,
  SearchToggle,
} from "./types";
export type { SearchMatch, SearchOpts } from "./engine";

// Internal — minimum surface from `__creoEdit` we depend on.
type EditorHandle = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  scrollToBlock: (
    blockId: BlockId,
    opts?: { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior },
  ) => void;
};

const ROOT_FLAG = "__creoSearchMounted";
const COMMAND_OPEN = "search.open";
const COMMAND_CLOSE = "search.close";

export function searchPlugin(opts: SearchOptions = {}): EditorPlugin {
  const debounceMs = opts.debounceMs ?? 80;

  // Per-editor state lives in a closure created at first mount. The
  // controller plus all DOM is stashed on `__creoEdit` via a side channel
  // so the keymap command can find it.
  type Wired = {
    controller: SearchController;
    open(): void;
    close(): void;
  };
  const wiredByRoot = new WeakMap<HTMLElement, Wired>();

  const findWiredFromCtx = (ctx: CommandCtx): Wired | null => {
    // The command has no direct DOM handle. Walk all editor roots and
    // find the one whose docStore identity matches. Cheap — there's
    // usually one editor on the page.
    const roots = document.querySelectorAll<HTMLElement>("[data-creo-edit]");
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i]!;
      const e = (r as unknown as { __creoEdit?: EditorHandle }).__creoEdit;
      if (e?.docStore === ctx.docStore) return wiredByRoot.get(r) ?? null;
    }
    return null;
  };

  return {
    name: "search",
    commands: [
      {
        t: COMMAND_OPEN,
        run(ctx) {
          const w = findWiredFromCtx(ctx);
          if (!w) return false;
          w.open();
          return true;
        },
      },
      {
        t: COMMAND_CLOSE,
        run(ctx) {
          const w = findWiredFromCtx(ctx);
          if (!w) return false;
          w.close();
          return true;
        },
      },
    ],
    keymap: opts.interceptBrowserFind
      ? [{ chord: "Mod+F", command: { t: COMMAND_OPEN } }]
      : [],
    decorations: [
      {
        id: "search",
        layer: "absolute",
        // Match the FIRST block only (so we don't double-mount). Same
        // pattern as infinite-scroll: `match` returns true for every
        // block but we guard the body with a per-root flag.
        match: (b) => b !== null,
        mount(_block, blockEl, host) {
          // The decoration manager creates one host per (def, block).
          // We don't render per-block UI; one editor-level panel is
          // enough. Hide every spare host.
          host.style.display = "none";
          host.style.pointerEvents = "none";

          const root = blockEl.closest(
            "[data-creo-edit]",
          ) as HTMLElement | null;
          if (!root) return;
          if ((root as unknown as Record<string, unknown>)[ROOT_FLAG]) return;
          (root as unknown as Record<string, unknown>)[ROOT_FLAG] = true;

          const editor = (root as unknown as { __creoEdit?: EditorHandle })
            .__creoEdit;
          if (!editor) {
            (root as unknown as Record<string, unknown>)[ROOT_FLAG] = false;
            return;
          }

          ensureStylesInjected();

          // ----- panel host (floating, sticky top-right) -----------------
          // We mount our own wrapper inside the editor's parent so the
          // panel is positioned relative to the scroll container and
          // sticks to the viewport edge as the user scrolls. The
          // decoration manager's per-block hosts can't do this — they're
          // pinned to their block.
          const panelHost = document.createElement("div");
          panelHost.className = "creo-search-host";
          // Sticky needs a non-static container with overflow constraints;
          // attaching as the FIRST child of the editor root works because
          // the root is `position: relative` and the panel itself uses
          // `position: sticky`.
          panelHost.style.position = "absolute";
          panelHost.style.top = "0";
          panelHost.style.left = "0";
          panelHost.style.right = "0";
          panelHost.style.height = "0";
          panelHost.style.zIndex = "100";
          panelHost.style.pointerEvents = "none";
          // Children (the panel) re-enable pointer-events on themselves.
          // Prepend so the sticky edge is the top of the editor's content.
          if (root.firstChild) root.insertBefore(panelHost, root.firstChild);
          else root.appendChild(panelHost);

          // ----- state ---------------------------------------------------
          const initial = (k: SearchToggle): boolean =>
            Boolean(opts.toggles?.[k]?.initial);
          const state: SearchState = {
            isOpen: false,
            query: "",
            caseSensitive: initial("caseSensitive"),
            wholeWord: initial("wholeWord"),
            regex: initial("regex"),
            matches: [],
            activeIndex: -1,
            error: null,
          };
          const subscribers = new Set<() => void>();
          const emit = () => {
            for (const fn of subscribers) fn();
          };

          // Stash the pre-open selection so Escape can restore it.
          let stashedSelection: Selection | null = null;

          // IME composition gate — pause re-scans while composing.
          let composing = false;
          const onCompStart = () => { composing = true; };
          const onCompEnd = () => {
            composing = false;
            scheduleRescan();
          };
          root.addEventListener("compositionstart", onCompStart);
          root.addEventListener("compositionend", onCompEnd);

          // ----- search execution ----------------------------------------
          let scanTimer: ReturnType<typeof setTimeout> | null = null;
          let scanSeq = 0;
          const runScan = async () => {
            if (composing) return;
            const seq = ++scanSeq;
            const q = state.query;
            const sopts: SearchOpts = {
              caseSensitive: state.caseSensitive,
              wholeWord: state.wholeWord,
              regex: state.regex,
            };
            if (q.length === 0) {
              state.matches = [];
              state.activeIndex = -1;
              state.error = null;
              repaint();
              emit();
              return;
            }
            // Validate regex up-front so the UI can show an error.
            if (sopts.regex) {
              try {
                new RegExp(q, sopts.caseSensitive ? "g" : "gi");
                state.error = null;
              } catch (e) {
                state.error = (e as Error).message;
                state.matches = [];
                state.activeIndex = -1;
                repaint();
                emit();
                return;
              }
            } else {
              state.error = null;
            }
            let matches: SearchMatch[];
            if (opts.source) {
              try {
                const r = await opts.source.search(q, sopts);
                if (seq !== scanSeq) return; // newer scan in flight
                matches = r;
              } catch (e) {
                state.error = (e as Error).message;
                state.matches = [];
                state.activeIndex = -1;
                repaint();
                emit();
                return;
              }
            } else {
              matches = searchDoc(editor.docStore.get(), q, sopts);
            }
            state.matches = matches;
            // Keep activeIndex on a sensible value across re-scans:
            //  - empty: -1
            //  - first scan: 0
            //  - subsequent: clamp to range
            if (matches.length === 0) state.activeIndex = -1;
            else if (state.activeIndex < 0) state.activeIndex = 0;
            else if (state.activeIndex >= matches.length)
              state.activeIndex = matches.length - 1;
            repaint();
            emit();
          };
          const scheduleRescan = () => {
            if (scanTimer) clearTimeout(scanTimer);
            scanTimer = setTimeout(runScan, debounceMs);
          };

          // ----- highlighting --------------------------------------------
          const repaint = () => {
            if (!state.isOpen) {
              clearHighlights();
              return;
            }
            paintHighlights(root, state.matches, state.activeIndex);
          };

          // Re-paint when blocks mount/unmount via VirtualDoc — Range
          // construction needs the live DOM. childList on the root
          // catches block insertions; subtree-scoped to catch them
          // wherever they land (DocView swaps the inner container as a
          // unit on some renders).
          let mutTimer: ReturnType<typeof setTimeout> | null = null;
          const mo = new MutationObserver((records) => {
            // Cheap filter: only repaint if at least one mutated element
            // is (or contains) a block element.
            let touched = false;
            for (const r of records) {
              for (const n of Array.from(r.addedNodes).concat(
                Array.from(r.removedNodes),
              )) {
                if (
                  n instanceof HTMLElement &&
                  (n.hasAttribute("data-block-id") ||
                    n.querySelector?.("[data-block-id]"))
                ) {
                  touched = true;
                  break;
                }
              }
              if (touched) break;
            }
            if (!touched) return;
            if (mutTimer) clearTimeout(mutTimer);
            mutTimer = setTimeout(repaint, 16);
          });
          mo.observe(root, { childList: true, subtree: true });

          // Re-scan on doc mutations (edits, infinite-scroll loads, undo).
          const unsubDoc = editor.docStore.subscribe(() => {
            if (!state.isOpen) return;
            scheduleRescan();
          });

          // ----- controller ----------------------------------------------
          const controller: SearchController = {
            state: () => ({ ...state, matches: state.matches }),
            isOpen: () => state.isOpen,
            open: () => {
              if (state.isOpen) {
                // Re-open while open: focus input via UI's subscriber.
                emit();
                return;
              }
              stashedSelection = editor.selStore.get();
              state.isOpen = true;
              // First open: kick off a scan if we have a query.
              if (state.query) scheduleRescan();
              else repaint();
              emit();
            },
            close: () => {
              if (!state.isOpen) return;
              state.isOpen = false;
              clearHighlights();
              if (stashedSelection) editor.selStore.set(stashedSelection);
              stashedSelection = null;
              emit();
            },
            toggleOpen: () => {
              if (state.isOpen) controller.close();
              else controller.open();
            },
            setQuery: (q) => {
              if (state.query === q) return;
              state.query = q;
              // Reset active index when the query changes meaningfully —
              // otherwise the user types one char and we keep "match #5"
              // even though the result list is entirely different.
              state.activeIndex = q.length === 0 ? -1 : 0;
              scheduleRescan();
              emit();
            },
            query: () => state.query,
            setToggle: (t, v) => {
              if (state[t] === v) return;
              state[t] = v;
              scheduleRescan();
              emit();
            },
            toggle: (t) => state[t],
            matches: () => state.matches,
            activeIndex: () => state.activeIndex,
            setActiveIndex: (i) => {
              if (state.activeIndex === i) return;
              state.activeIndex = i;
              repaint();
              emit();
            },
            next: () => {
              if (state.matches.length === 0) return;
              state.activeIndex = nextIndex(state.activeIndex, state.matches.length);
              const m = state.matches[state.activeIndex]!;
              void jumpToMatch(editor, m, opts.source);
              repaint();
              emit();
            },
            prev: () => {
              if (state.matches.length === 0) return;
              state.activeIndex = prevIndex(state.activeIndex, state.matches.length);
              const m = state.matches[state.activeIndex]!;
              void jumpToMatch(editor, m, opts.source);
              repaint();
              emit();
            },
            subscribe: (fn) => {
              subscribers.add(fn);
              return () => subscribers.delete(fn);
            },
          };

          // ----- UI ------------------------------------------------------
          let cleanupUI: () => void;
          if (opts.renderUI) {
            cleanupUI = opts.renderUI(controller, panelHost);
          } else {
            cleanupUI = mountDefaultPanel(panelHost, controller, opts);
          }

          wiredByRoot.set(root, {
            controller,
            open: controller.open,
            close: controller.close,
          });

          // ----- cleanup -------------------------------------------------
          return () => {
            cleanupUI();
            mo.disconnect();
            unsubDoc();
            if (scanTimer) clearTimeout(scanTimer);
            if (mutTimer) clearTimeout(mutTimer);
            clearHighlights();
            root.removeEventListener("compositionstart", onCompStart);
            root.removeEventListener("compositionend", onCompEnd);
            panelHost.remove();
            wiredByRoot.delete(root);
            (root as unknown as Record<string, unknown>)[ROOT_FLAG] = false;
          };
        },
      },
    ],
  };
}
