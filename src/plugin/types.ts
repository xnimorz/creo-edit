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
  Block,
  BlockId,
  BlockSpec,
  DocState,
  InlineRun,
  Selection,
} from "../model/types";

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

export type BlockDef<B extends Block = Block> = {
  /** Discriminator — must match block.type. */
  type: B["type"];

  /** Creo view rendering the block. Receives the block + a stable key. */
  view: PublicView<{ block: B; key?: string }, void>;

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
   * Mount the decoration's UI into the supplied `host` element. Return an
   * optional cleanup fn (called on unmount). The decoration's UI is plain
   * DOM — plugins that want a creo subtree create their own creo app
   * inside `mount` and dispose it in the returned cleanup.
   */
  mount(
    block: Block,
    blockEl: HTMLElement,
    host: HTMLElement,
    handle: DecorationHandle,
  ): (() => void) | void;
  layer: "left" | "right" | "top" | "bottom" | "absolute";
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
  /** Tag prefixes whose history snapshots may coalesce. Defaults are
   *  ["text:"]; plugins can declare their own (e.g. "myPlugin:typing"). */
  historyCoalescePrefixes?: string[];
};
