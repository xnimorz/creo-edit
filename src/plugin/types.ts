// ---------------------------------------------------------------------------
// Plugin system — public types
//
// A plugin is a bag of optional contributions: block kinds, commands, keymap
// chords, text triggers, and per-block decorations. Each contribution is
// routed through its own registry; plugins compose by registering more
// entries into those registries.
//
// M1 wires up blocks, commands, keymap, and the data attributes/codecs that
// non-text-bearing blocks need (anchorMap, runsAt, HTML, JSON serialize).
// Triggers and decorations are declared here for forward compat; their
// runtime managers land in M3 / M4.
// ---------------------------------------------------------------------------

import type { PublicView, Store } from "creo";
import type {
  Anchor,
  AnchorRange,
  Block,
  BlockId,
  BlockSpec,
  DocState,
  InlineRun,
  Selection,
} from "../model/types";
import type {
  BlockViewport,
  SelfVirtualizedDef,
} from "./selfVirtualized";

export type { BlockViewport, SelfVirtualizedDef };

// ---------------------------------------------------------------------------
// Cell access — re-exported here so plugins can implement custom runs slots
// (table cells, columns cells, future "callout" containers, etc.) without
// reaching into model internals.
// ---------------------------------------------------------------------------

export type RunsCtx = {
  runs: InlineRun[];
  setRuns: (newRuns: InlineRun[]) => Block;
};

// ---------------------------------------------------------------------------
// DOM ↔ anchor codec — non-text-bearing blocks (table, columns, img,
// future plugin blocks) supply these to translate between DOM positions and
// the anchor's path[] encoding.
// ---------------------------------------------------------------------------

export type DomPoint = { node: Node; offset: number };

export type AnchorCodec = {
  /**
   * Given the outer block element + a DOM hit (node, localOffset) inside it,
   * produce an Anchor. Plugins for tables / columns walk into their cell
   * sub-element and extract row/col from data-cell / data-col before
   * computing the visible-character offset.
   */
  domToAnchor(blockEl: HTMLElement, hit: Node, localOffset: number): Anchor | null;

  /**
   * Given an Anchor, locate the (DOM node, offset) within the block's
   * mounted DOM. Returns null when the relevant sub-element isn't currently
   * mounted (e.g. virtualized off-screen).
   */
  anchorToDom(blockEl: HTMLElement, a: Anchor): DomPoint | null;

  /**
   * Optional bulk form of `anchorToDom`, positionally aligned with `anchors`.
   *
   * A range-decoration repaint resolves two anchors per range and thousands
   * of ranges per frame, most of them landing on the same handful of
   * sub-elements. A codec that can answer a whole batch with one pass over
   * its DOM (the code block sorts by offset and walks its lines once) should
   * implement this; everything else is served correctly, just more slowly, by
   * the default of calling `anchorToDom` per anchor.
   *
   * `anchors` arrive in whatever order the caller had them — implementations
   * that need sorted input must sort a copy and restore the original order.
   */
  anchorsToDom?(blockEl: HTMLElement, anchors: readonly Anchor[]): (DomPoint | null)[];

  /**
   * Return the scope element for IME composition diffing — e.g. the active
   * <td> for a table caret, or the active <div data-col> for columns.
   * Defaults to the block element itself for blocks without sub-scopes.
   */
  domScope?(blockEl: HTMLElement, a: Anchor): HTMLElement | null;
};

// ---------------------------------------------------------------------------
// HTML codec — paste in / copy out.
// ---------------------------------------------------------------------------

export type HtmlParseCtx = {
  /** Active inline marks (b/i/u/s/code) collected from ancestor elements. */
  marks: import("../model/types").Mark[];
};

export type HtmlBlockCodec = {
  /**
   * HTML tag names this block claims when parsing. The parser walks fragment
   * children, finds the first registered codec whose `matchHTML` includes
   * the tag, and calls `parseHTML`. Order = plugin registration order, so
   * built-ins should register `table` before generic `<div>` parsers.
   */
  matchHTML?: string[];
  parseHTML?(el: HTMLElement, ctx: HtmlParseCtx): BlockSpec | null;
  serializeHTML?(b: Block): string;
};

// ---------------------------------------------------------------------------
// JSON / SerializedBlock codec — toJSON / setDoc round-trip.
// ---------------------------------------------------------------------------

export type SerializeCodec = {
  serialize(b: Block): unknown;
  deserialize(s: unknown, id: BlockId): BlockSpec;
};

// ---------------------------------------------------------------------------
// BlockDef — everything a plugin needs to provide for a single block kind.
// ---------------------------------------------------------------------------

/**
 * Props a self-virtualized block's view receives. Same shape as an ordinary
 * block view plus the visible region, so a view can accept it without any
 * change until it actually opts in.
 */
export type SelfVirtualizedProps<B extends Block = Block> = {
  block: B;
  key?: string;
  /** Visible region in the block's own coordinate space, px from its top.
   *  Absent when the editor is not virtualized. */
  viewport?: BlockViewport;
};

export type BlockDef<B extends Block = Block> = {
  /** Discriminator — must match block.type. */
  type: B["type"];

  /** Creo view rendering the block. Receives the block + a stable key, plus
   *  a `viewport` when the block declares `selfVirtualized`. */
  view: PublicView<SelfVirtualizedProps<B>, void>;

  /**
   * Opt in to managing internal windowing. When present, `VirtualDoc` stops
   * measuring this block with ResizeObserver and trusts `measureHeight`, and
   * passes the visible region down through the view's props.
   *
   * Only worth it for blocks that are internally long AND uniform enough for
   * `measureHeight` to be arithmetic — code lines, log rows, table bodies. A
   * block that isn't simply doesn't opt in and keeps today's behaviour.
   *
   * See the note in `plugin/selfVirtualized.ts`: a block that opts in owns
   * its anchor codec's correctness across its own spacers.
   */
  selfVirtualized?: SelfVirtualizedDef<B>;

  /**
   * Resolve the runs slot at `anchor`. Defaults to "block.runs if present,
   * else null" (covers all text-bearing blocks). Override for blocks with
   * nested cells (table, columns).
   */
  runsAt?(b: B, a: Anchor): RunsCtx | null;

  /**
   * Whether the block is "text-bearing" — has a top-level `runs: InlineRun[]`
   * field that text commands operate on directly. Inferred from `runsAt`
   * presence at registration time when omitted; defaults to true if the
   * block exposes a `runs` field at runtime.
   */
  isTextBearing?: boolean;

  /**
   * "Atomic" non-editable block — caret can only sit before (side 0) or
   * after (side 1), never inside. Path encoding is `[side]`. The view should
   * render the outer element with `contenteditable="false"` so the browser
   * places the native caret around the block, not inside it. Backspace /
   * Delete on the block deletes the whole block. Implies `isTextBearing:
   * false` and uses `atomicCodec` by default if no `anchorCodec` is given.
   */
  isAtomic?: boolean;

  /** DOM ↔ anchor mapping. Optional — text-bearing blocks fall back to a
   *  shared default that walks visible text by character offset. */
  anchorCodec?: AnchorCodec;

  /** HTML round-trip. Optional — only needed for blocks that survive
   *  copy / paste with external apps. */
  htmlCodec?: HtmlBlockCodec;

  /** JSON SerializedBlock round-trip. Required for blocks that should
   *  survive `toJSON()` / `setDoc()`. */
  serializeCodec?: SerializeCodec;
};

// ---------------------------------------------------------------------------
// Commands — `t` keys are namespaced strings ("table.insertRow"). Built-in
// commands keep their existing flat names ("insertText", "splitBlock", ...)
// for back-compat with the typed `Command` union.
// ---------------------------------------------------------------------------

export type CommandCtx = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
};

export type CommandDef<P = unknown> = {
  t: string;
  /** Run the command. Return `false` to signal the command did not apply
   *  (e.g. arrow-nav at the table edge); the keymap dispatcher uses this to
   *  decide whether to preventDefault. Returning void or true means handled. */
  run(ctx: CommandCtx, payload: P): boolean | void;
  /**
   * Opt the command out of the read-only gate. The dispatcher refuses every
   * command while `editor.isEditable()` is false — set this on commands that
   * only move the caret / open UI and never touch the document (table cell
   * navigation, search jump-to-match, …) so they keep working in a diff or
   * transcript view. Default: false (gated).
   */
  readOnlySafe?: boolean;
};

// ---------------------------------------------------------------------------
// Keymap — chord → command. Chords are matched in registration order; the
// first matching entry whose `when` predicate (if any) returns true wins.
// ---------------------------------------------------------------------------

export type KeymapDef = {
  /**
   * Chord string. Modifiers join with "+". The platform-specific Mod token
   * resolves to Cmd on macOS, Ctrl elsewhere. Examples:
   *   "Mod+B", "Mod+Shift+S", "Tab", "Shift+Tab", "ArrowLeft".
   */
  chord: string;
  when?(ctx: CommandCtx): boolean;
  /** Command t + payload to dispatch when chord matches. */
  command: { t: string; payload?: unknown };
};

// ---------------------------------------------------------------------------
// Triggers — text watchers like "/" or "@". Manager lands in M3.
// ---------------------------------------------------------------------------

export type TriggerCtx = {
  /** Anchor of the trigger character that fired the match. */
  at: Anchor;
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  /**
   * Dispatch a command. Accepts the typed `Command` shape (preferred for
   * built-ins so payload fields land in the right place) or the open
   * `{ t: string; payload?: unknown }` shape for plugin commands.
   *
   * Two-arg form `(t, payload)` is sugar for `{ t, payload }`.
   */
  dispatch(cmd: { t: string; [k: string]: unknown }): void;
  dispatch(t: string, payload?: unknown): void;
  /** Element where popover UI should anchor. */
  caretRect(): DOMRect | null;
  /**
   * Request the trigger manager to close this trigger. Idempotent. Call
   * after committing the trigger's action so subsequent keystrokes (e.g.
   * Enter to split a block) flow through to the editor instead of being
   * captured by a stale controller.
   */
  close(): void;
};

export type TriggerController = {
  onTextChange?(query: string): void;
  onKey?(e: KeyboardEvent): boolean;
  close(): void;
};

export type TriggerDef = {
  /**
   * String prefix or RegExp matched against the most recently inserted
   * characters at the caret. String matches treat the value as a literal
   * trigger char (e.g. "/").
   */
  match: string | RegExp;
  open(ctx: TriggerCtx): TriggerController | null;
};

// ---------------------------------------------------------------------------
// Decorations — overlay UI per block. Manager lands in M4.
// ---------------------------------------------------------------------------

/**
 * DecorationManager passed to mount fns so plugins can read state-without-
 * subscribing-to-doc — e.g. "is this block currently hovered?". Decorations
 * MUST NOT subscribe directly to docStore inside mount; that would re-render
 * on every keystroke. Read live state via this handle on pointer events.
 */
export type DecorationHandle = {
  hoveredBlock(): import("../model/types").BlockId | null;
};

export type DecorationDef = {
  id: string;
  match(b: Block): boolean;
  /**
   * Elements within the block to anchor decorations to. Defaults to
   * `[blockEl]`, which is exactly the per-block behaviour.
   *
   * A code block returns its `.ce-code-line` children, giving one decoration
   * per line — which is what every gutter affordance (line numbers, diff
   * signs, diagnostics, fold arrows) actually needs.
   *
   * Called on every doc change and every reposition frame, so keep it to a
   * `querySelectorAll`. See `uniformTargets` when the list is long.
   */
  targets?(block: Block, blockEl: HTMLElement): HTMLElement[];
  /**
   * Mount the decoration's UI into the supplied `host` element. Return an
   * optional cleanup fn (called on unmount). The decoration's UI is plain
   * DOM — plugins that want a creo subtree create their own creo app
   * inside `mount` and dispose it in the returned cleanup.
   *
   * `target` is the element from `targets()` this instance is anchored to,
   * and equals the block element when `targets` is omitted. `index` is the
   * position within `targets()`, and is 0 when defaulted.
   */
  mount(
    block: Block,
    target: HTMLElement,
    host: HTMLElement,
    handle: DecorationHandle,
    index: number,
  ): (() => void) | void;
  layer: "left" | "right" | "top" | "bottom" | "absolute";
  /** Slot width in px reserved per decoration in the left / right gutter.
   *  Default 24. */
  slotWidth?: number;
  /**
   * Promise that every target has the same height and that they stack
   * contiguously from the first one's top — true for code lines, false for
   * anything with mixed content. When set, the manager measures only
   * `targets()[0]` per frame and derives the rest arithmetically, which is
   * what keeps a ~500-line gutter off the layout-thrash path.
   */
  uniformTargets?: boolean;
};

// ---------------------------------------------------------------------------
// Range decorations — arbitrary, overlapping spans painted with zero DOM
// mutation via the CSS Custom Highlight API.
// ---------------------------------------------------------------------------

/** The mounted window a range-decoration source is asked to cover. */
export type DecorationViewport = {
  firstBlock: BlockId;
  lastBlock: BlockId;
  /**
   * Visible half-open character window `[from, to)` within a block, when the
   * block renders sub-items the manager can measure — code-block lines today.
   * Returns null when the block is fully on screen, isn't measurable, or the
   * environment has no layout.
   *
   * `firstBlock` / `lastBlock` alone cannot express anything about a document
   * that IS one block: for a whole file in a single `code` block they are a
   * constant, so a source honouring "return only what intersects `viewport`"
   * still had to return every token range in the file to paint the fifty
   * lines on screen. This is how it narrows that.
   *
   * Optional, and absent on hosts that build a viewport themselves — always
   * feature-test before calling.
   */
  windowIn?: (block: BlockId) => { from: number; to: number } | null;
};

export type RangeDecorationDef = {
  id: string;
  /**
   * Ranges to paint. Called on doc change and on viewport change; return only
   * what intersects `viewport` for large documents. Ranges whose blocks are
   * not currently mounted are skipped silently, so an over-broad return is
   * correct-but-wasteful rather than wrong.
   *
   * `viewport` is null when the editor has no mounted blocks at all.
   */
  ranges(
    doc: DocState,
    viewport: DecorationViewport | null,
  ): AnchorRange[];
  /**
   * Registered as a CSS `::highlight(name)`; the host supplies the styling.
   * Names live in a document-global registry, so pick something namespaced
   * when more than one editor is on the page.
   */
  className: string;
  /** Paint order when ranges overlap. Higher wins. Default 0. */
  priority?: number;
};

// ---------------------------------------------------------------------------
// Inline widgets — non-text content placed WITHIN a line (ghost-text
// completions, LSP inlay hints). See plugin/inlineWidgets.ts for the three
// things a widget has to stay invisible to.
// ---------------------------------------------------------------------------

export type InlineWidgetPlacement = {
  anchor: Anchor;
  /** Opaque per-widget data handed back to `mount`. */
  data?: unknown;
};

export type InlineWidgetDef = {
  id: string;
  /**
   * Where widgets go. Called on doc change, selection change and viewport
   * change; return only what intersects `viewport` for large documents.
   * Placements whose block isn't mounted are retried on a later pass.
   *
   * `viewport` is null when the editor has no mounted blocks.
   */
  at(
    doc: DocState,
    viewport: DecorationViewport | null,
  ): InlineWidgetPlacement[];
  /**
   * Which side of the anchor the widget sits on. Widgets are zero-width to
   * the model either way, so this orders several widgets sharing one anchor
   * ("before" first) and is exposed as `data-affinity` for styling.
   * Default: "after".
   */
  affinity?: "before" | "after";
  /**
   * Whether the widget takes pointer events. Ghost text is inert so a click
   * lands on the text underneath; a clickable inlay hint is not.
   * Default: false.
   */
  interactive?: boolean;
  /**
   * Fill in the supplied host span. Return an optional cleanup fn. The host
   * already carries `data-ce-inline-widget` and `contenteditable="false"` —
   * do not remove either, they are what makes the widget invisible to the
   * anchor walk and to the browser's caret.
   */
  mount(
    host: HTMLElement,
    ctx: { anchor: Anchor; data?: unknown },
  ): (() => void) | void;
};

// ---------------------------------------------------------------------------
// EditorPlugin — top-level shape that users construct.
// ---------------------------------------------------------------------------

export type EditorPlugin = {
  name: string;
  blocks?: BlockDef<Block>[];
  commands?: CommandDef<unknown>[];
  keymap?: KeymapDef[];
  triggers?: TriggerDef[];
  decorations?: DecorationDef[];
  rangeDecorations?: RangeDecorationDef[];
  inlineWidgets?: InlineWidgetDef[];
  /** Tag prefixes whose history snapshots may coalesce. Defaults are
   *  ["text:"]; plugins can declare their own (e.g. "myPlugin:typing"). */
  historyCoalescePrefixes?: string[];
};
