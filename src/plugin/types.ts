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
import type { MarkDef } from "./markRegistry";
import type { MarkdownBlockCodec } from "../markdown/blockCodec";
import type { DocChange } from "../model/changes";

export type { BlockViewport, SelfVirtualizedDef, MarkDef, MarkdownBlockCodec };

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
  /** Active inline marks collected from ancestor elements, name → attrs.
   *  Pass straight to `collectRuns` from `clipboard/inlineHtml`. */
  marks: import("../model/types").MarkSet;
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

  /**
   * Markdown output for this block kind. Without one, `docToMarkdown` emits
   * nothing for the block — its built-in switch only knows the closed union.
   * Receives the SERIALIZED block, so it pairs with `serializeCodec`.
   */
  markdownCodec?: MarkdownBlockCodec;
};

// ---------------------------------------------------------------------------
// Commands — `t` keys are namespaced strings ("table.insertRow"). Built-in
// commands keep their existing flat names ("insertText", "splitBlock", ...)
// for back-compat with the typed `Command` union.
// ---------------------------------------------------------------------------

export type CommandCtx = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  /**
   * Re-enter the dispatcher. A plugin command that wants a built-in's
   * behaviour should dispatch it rather than reimplement it — nested
   * dispatches fold into the outer change batch and the outer undo step, so
   * composing this way costs nothing.
   */
  dispatch(cmd: { t: string; [k: string]: unknown }): boolean;
  dispatch(t: string, payload?: unknown): boolean;
  /**
   * Record a `DocChange` for the edit this command is making. Commands that
   * mutate `docStore` directly MUST call this, or `editor.onChange`
   * subscribers never learn the edit happened — which is exactly how the
   * shipped drag-handle and add-block plugins used to drop reorders and
   * inserts from any consumer persisting off the change stream.
   *
   * A no-op outside a dispatch, so a command is safe to call directly in a
   * test.
   */
  change(c: DocChange): void;
  /** The editor this command is running in. */
  editor: import("../createEditor").Editor;
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
  /**
   * The editor's full `CommandCtx`. A trigger's UI usually ends by running a
   * command-shaped action (a slash-menu item), and those take a `CommandCtx` —
   * so hand over the real one rather than making every trigger assemble a
   * partial from the stores it happens to have.
   */
  commandCtx: CommandCtx;
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
  /**
   * Inline marks this plugin contributes — rendering, HTML round-trip and
   * markdown for a mark name. Registered into the module-global mark
   * registry; the six built-ins (`b`, `i`, `u`, `s`, `code`, `link`) are
   * already there, and re-registering a name replaces its definition.
   */
  marks?: MarkDef[];
  commands?: CommandDef<unknown>[];
  keymap?: KeymapDef[];
  triggers?: TriggerDef[];
  decorations?: DecorationDef[];
  rangeDecorations?: RangeDecorationDef[];
  inlineWidgets?: InlineWidgetDef[];
  /** Tag prefixes whose history snapshots may coalesce. Defaults are
   *  ["text:"]; plugins can declare their own (e.g. "myPlugin:typing"). */
  historyCoalescePrefixes?: string[];

  /**
   * Called once, after the editor exists and every plugin is installed —
   * so a plugin may look up another's commands here. Not a DOM hook: the
   * root is not mounted yet. Return a teardown fn, or use `onDestroy`.
   */
  onInit?(editor: import("../createEditor").Editor): (() => void) | void;

  /**
   * Called from `editor.destroy()`, after the input pipeline and overlay
   * managers are torn down. Release anything the plugin allocated outside the
   * editor: timers, observers, network subscriptions.
   */
  onDestroy?(editor: import("../createEditor").Editor): void;

  /**
   * Intercept paste before the built-in clipboard path runs.
   *
   * Return `true` to claim the event — the editor calls `preventDefault()`
   * and does nothing further. Return `false` / nothing to fall through to the
   * normal HTML-then-plain-text handling. Hooks run in plugin registration
   * order and the first `true` wins.
   *
   * This is the doc-level counterpart to `BlockDef.htmlCodec.matchHTML`,
   * which can only claim one element at a time and cannot see the plain-text
   * or file flavours of the clipboard at all.
   */
  onPaste?(ctx: PasteCtx): boolean | void;

  /**
   * Transform the serialized document on its way out of `toJSON()` and on
   * its way in through `setDoc()`. `serializeDoc` runs after every block
   * codec, `deserializeDoc` before them — a plugin that keeps document-level
   * metadata (a title, a schema version) round-trips it here.
   */
  serializeDoc?(doc: SerializedDocLike): SerializedDocLike;
  deserializeDoc?(doc: SerializedDocLike): SerializedDocLike;
};

/** Minimal structural stand-in for `SerializedDoc`, to keep this module free
 *  of a value import from `createEditor`. */
export type SerializedDocLike = {
  blocks: { id?: string; type: string; [k: string]: unknown }[];
};

export type PasteCtx = {
  event: ClipboardEvent;
  /** Clipboard flavours, already read off the event. */
  html: string;
  text: string;
  files: readonly File[];
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  editor: import("../createEditor").Editor;
};
