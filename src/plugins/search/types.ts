// ---------------------------------------------------------------------------
// Public types for the search plugin. Kept in a separate module so the
// engine + UI can import them without pulling the plugin factory.
// ---------------------------------------------------------------------------

import type { BlockId } from "../../model/types";
import type { SearchMatch, SearchOpts } from "./engine";

export type { SearchMatch, SearchOpts } from "./engine";

export type SearchToggle = "caseSensitive" | "wholeWord" | "regex";

export type SearchSource = {
  /** Replace (or augment) the in-doc scan. Async OK. */
  search(
    query: string,
    opts: SearchOpts,
  ): SearchMatch[] | Promise<SearchMatch[]>;
  /** Called before jump-to-match for a blockId not yet in docStore. The
   *  host should load the chunk that contains the block and resolve when
   *  the block lands in docStore. */
  ensureLoaded?(blockId: BlockId): Promise<void>;
};

export type SearchToggleOpt = { initial?: boolean; show?: boolean };

export type SearchOptions = {
  /**
   * When true, the plugin claims `Mod+F` and prevents the browser's find
   * UI from opening. Default: `false` — opt-in to avoid surprising users
   * who expect native Cmd+F.
   */
  interceptBrowserFind?: boolean;

  /** Initial values + UI visibility for each toggle. Omitted toggles use
   *  `{ initial: false, show: false }`. */
  toggles?: {
    caseSensitive?: SearchToggleOpt;
    wholeWord?: SearchToggleOpt;
    regex?: SearchToggleOpt;
  };

  /** Backend search source (for infinite-scroll). When omitted, the
   *  plugin scans `docStore` only. */
  source?: SearchSource;

  /**
   * Render the UI yourself. When provided, the default panel is NOT
   * mounted — the callback gets a controller and a host element to
   * render whatever it wants. Return a cleanup fn called on plugin
   * teardown.
   */
  renderUI?: (controller: SearchController, host: HTMLElement) => () => void;

  /** Debounce (ms) on input change. Default: 80. */
  debounceMs?: number;
};

export type SearchState = {
  isOpen: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  matches: readonly SearchMatch[];
  activeIndex: number;
  /** Last engine error (e.g. invalid regex) — UI shows it inline. */
  error: string | null;
};

export type SearchController = {
  open(): void;
  close(): void;
  toggleOpen(): void;
  isOpen(): boolean;
  setQuery(q: string): void;
  query(): string;
  setToggle(t: SearchToggle, v: boolean): void;
  toggle(t: SearchToggle): boolean;
  matches(): readonly SearchMatch[];
  activeIndex(): number;
  setActiveIndex(i: number): void;
  next(): void;
  prev(): void;
  /** Subscribe to state changes; returns unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Snapshot the full state. */
  state(): SearchState;
};
