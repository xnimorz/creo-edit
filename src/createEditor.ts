import { _ } from "creo";
import { div, store, view } from "creo";
import type { PublicView, Store } from "creo";
import { moveTo } from "./commands/navigationCommands";
import { attachDrop, type DropHandle } from "./clipboard/drop";
import { parseHTML } from "./clipboard/htmlParser";
import {
  attachVisualViewport,
  type ViewportHandle,
} from "./input/mobile";
import {
  endOfBlock,
  endOfDocAnchor,
  homeOfBlock,
  homeOfDoc,
} from "./controller/navigation";
import { isAtomicBlockType } from "./plugin/atomic";
import {
  insertColumns as cmdInsertColumns,
  insertImage as cmdInsertImage,
  insertTable as cmdInsertTable,
} from "./commands/insertCommands";
import {
  indentList as cmdIndentList,
  outdentList as cmdOutdentList,
  toggleList as cmdToggleList,
} from "./commands/listCommands";
import {
  removeMark as cmdRemoveMark,
  toggleMark as cmdToggleMark,
} from "./commands/markCommands";
import {
  insertBlocks as cmdInsertBlocks,
  moveBlock as cmdMoveBlock,
  removeBlocksCmd,
  replaceBlocks as cmdReplaceBlocks,
  type InsertBlocksPayload,
  type MoveBlockPayload,
} from "./commands/blockCommands";
import { clearEditorRef, setEditorRef } from "./dom/editorRef";
import {
  mergeBackward as cmdMergeBackward,
  mergeForward as cmdMergeForward,
  setBlockType as cmdSetBlockType,
  splitBlock as cmdSplitBlock,
  type SetBlockTypePayload,
} from "./commands/structuralCommands";
import {
  deleteBackward as cmdDeleteBackward,
  deleteForward as cmdDeleteForward,
  insertText as cmdInsertText,
} from "./commands/textCommands";
import { clampSelection, endOfDoc } from "./controller/selection";
import { createHistory, type History } from "./controller/history";
import { attachAutoRebalance } from "./model/rebalance";
import {
  attachNativeInput,
  type NativeInputHandle,
} from "./input/nativeInput";
import { docFromBlocks, emptyDoc, insertManyAt, newBlockId } from "./model/doc";
import { blockTextOf } from "./model/blockText";
import {
  collectChanges,
  mapAnchor as mapAnchorPure,
  recordChange,
  type DocChange,
  type MapBias,
} from "./model/changes";
import type {
  Anchor,
  Block,
  BlockId,
  BlockSpec,
  DistOmit,
  DocState,
  MarkAttrs,
  MarkName,
  Selection,
} from "./model/types";

/**
 * Input shape for `appendBlocks` / `prependBlocks` — same as `BlockSpec`
 * but with `id` optional. The editor generates an id when missing so most
 * callers can stay terse:
 *
 *   editor.appendBlocks([{ type: "p", runs: [] }]);
 */
export type BlockInsertInput = DistOmit<BlockSpec, "id"> & { id?: BlockId };
import { DocView } from "./render/DocView";
import { VirtualDoc } from "./virtual/VirtualDoc";
import { defaultPlugins } from "./plugin/builtin";
import { Registry } from "./plugin/registry";
import {
  deserializeBlock as registryDeserializeBlock,
  serializeBlock as registrySerializeBlock,
} from "./plugin/serializeCodec";
import { registerUnknownBlockType } from "./plugin/unknownBlock";
import { TriggerManager } from "./plugin/triggers";
import { DecorationManager } from "./plugin/decorations";
import { RangeDecorationManager } from "./plugin/rangeDecorations";
import { InlineWidgetManager } from "./plugin/inlineWidgets";
import type { CommandCtx, EditorPlugin, PasteCtx } from "./plugin/types";

let __editorIdCounter = 0;

// ---------------------------------------------------------------------------
// Public-facing types
// ---------------------------------------------------------------------------

/**
 * Wire form of one inline run. `marks` is `{ name: attrs }` — attrs is `null`
 * for the boolean marks (`b`, `i`, `u`, `s`, `code`) and an object for marks
 * that carry data (`link` → `{ href, title? }`).
 *
 * The pre-0.4 `string[]` form is still accepted on read, so documents saved
 * before marks carried data load unchanged; `toJSON()` always emits the
 * object form.
 */
import type { SerializedRun } from "./model/runSerialize";
export type { SerializedRun };

/**
 * SerializedBlock — wire shape the editor reads from `setDoc()` and emits
 * from `toJSON()`. Built-in block types are listed exhaustively here so the
 * compiler still catches typos in user code. Plugins that introduce new
 * block types extend the runtime serialize codec registry without changing
 * this type — their entries appear as the catch-all `Record<string, unknown>`
 * branch.
 */
export type SerializedBlock =
  | { id?: string; type: "p"; runs: SerializedRun[] }
  | { id?: string; type: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"; runs: SerializedRun[] }
  | {
      id?: string;
      type: "li";
      ordered: boolean;
      depth?: 0 | 1 | 2 | 3;
      runs: SerializedRun[];
    }
  | {
      id?: string;
      type: "code";
      runs: SerializedRun[];
      lang?: string;
    }
  | {
      id?: string;
      type: "img";
      src: string;
      alt?: string;
      width?: number;
      height?: number;
    }
  | {
      id?: string;
      type: "table";
      rows: number;
      cols: number;
      cells: SerializedRun[][][];
    }
  | {
      id?: string;
      type: "columns";
      cols: number;
      cells: SerializedRun[][];
    }
  | {
      id?: string;
      type: "calendar";
      date: string;
      days: number;
    }
  | {
      id?: string;
      type: "date-marker";
      date: string;
    };

/**
 * Catch-all shape for plugin-introduced block types. Plugins serializing
 * outside the built-in union should cast through this when constructing
 * `SerializedDoc.blocks` — the runtime serialize codec registry handles
 * dispatch by `type` and ignores extra fields.
 */
export type ExternalSerializedBlock = {
  id?: string;
  type: string;
  [k: string]: unknown;
};

export type SerializedDoc = {
  blocks: SerializedBlock[];
};

export type EditorViewProps = {
  class?: string;
};

/** Options for the wholesale-replacement APIs (`setDoc`, `setDocFromHTML`). */
export type SetDocOptions = {
  /** Re-clamp the current selection onto the new document instead of jumping
   *  to end-of-doc. Only meaningful when block ids are stable across the
   *  swap. Default false. */
  preserveSelection?: boolean;
  /** Keep the undo stack across the swap. Default false — undoing across a
   *  document swap restores the OLD document, which is rarely what a host
   *  routing between documents wants, and exactly what an in-place refresh
   *  does. */
  preserveHistory?: boolean;
};

/**
 * Built-in command shape. Plugin commands dispatch through the same
 * `dispatch()` entry point using the `{ t: string; payload?: unknown }`
 * fallback shape — see `Editor.dispatch` below.
 */
export type Command =
  | { t: "noop" }
  | { t: "insertText"; text: string }
  | { t: "deleteBackward" }
  | { t: "deleteForward" }
  | { t: "splitBlock" }
  | { t: "mergeBackward" }
  | { t: "mergeForward" }
  | { t: "setBlockType"; payload: SetBlockTypePayload }
  | { t: "toggleMark"; mark: MarkName; attrs?: MarkAttrs }
  | { t: "removeMark"; mark: MarkName }
  | { t: "toggleList"; ordered: boolean }
  | { t: "indentList" }
  | { t: "outdentList" }
  | {
      t: "insertImage";
      src: string;
      alt?: string;
      width?: number;
      height?: number;
    }
  | { t: "insertTable"; rows: number; cols: number }
  | { t: "insertColumns"; cols: number }
  | { t: "tableInsertRow"; where: "above" | "below" }
  | { t: "tableInsertCol"; where: "before" | "after" }
  | { t: "tableRemoveRow" }
  | { t: "tableRemoveCol" }
  | { t: "moveCursor"; to: Anchor; extend?: boolean }
  | { t: "moveBlock"; payload: MoveBlockPayload }
  | { t: "insertBlocks"; payload: InsertBlocksPayload }
  | { t: "removeBlocks"; blockIds: BlockId[] }
  | { t: "replaceBlocks"; blocks: BlockInsertInput[] };

/** Anything dispatchable — the typed `Command` union for built-ins, plus the
 *  open `{ t: string; payload?: unknown }` shape for plugin commands. */
export type DispatchableCommand =
  | Command
  | { t: string; payload?: unknown };

/**
 * Editing mode.
 *
 *  - `"wysiwyg"`: rich-text editor with all blocks rendered visually.
 *  - `"md"`: raw markdown source view (the doc is serialized to markdown
 *    and edited as plain text); markdown-shortcut input rules also active
 *    when the user re-enters wysiwyg via mdShortcutsPlugin.
 *
 * Replaces the older `"regular" | "mono"` cosmetic flag — host apps that
 * want a monospaced editor should add their own CSS class.
 */
export type EditorMode = "wysiwyg" | "md";

export type EditorOptions = {
  initial?: SerializedDoc;
  uploadImage?: (f: File) => Promise<string>;
  /**
   * Enable virtualized rendering — only blocks intersecting the viewport
   * are mounted. Recommended for documents with > ~500 blocks. The host
   * page must put a scroll container around the editor for this to work.
   */
  virtualized?: boolean;
  /** Estimated block height (px) when virtualized — default 32. */
  virtualEstimatedHeight?: number;
  /**
   * Initial editing mode — see `EditorMode`. Defaults to `"wysiwyg"`.
   * Toggle at runtime via `editor.setMode(...)`.
   */
  mode?: EditorMode;
  /**
   * Plugins to install in addition to the default set (paragraph, heading,
   * list, code-block, image, cells). Registered AFTER built-ins so plugin
   * codecs can override built-in HTML matchers by registering more specific
   * tag matchers.
   */
  plugins?: EditorPlugin[];
  /**
   * Whether the document accepts input. Accepts a thunk so a host can flip it
   * without recreating the editor (e.g. an agent is mid-write).
   *
   * Honoured in two places: the root's `contenteditable` attribute, and the
   * command dispatcher — mutating commands return `false` while read-only, so
   * keymap fall-through still works. Plugin commands opt back in via
   * `CommandDef.readOnlySafe`. Attribute-only would be insufficient because
   * `dispatch()` is public.
   *
   * Host-level document APIs (`setDoc`, `setDocFromHTML`, `appendBlocks`,
   * `prependBlocks`) are deliberately NOT gated — that's how a read-only
   * viewer loads its content.
   *
   * Default: true.
   */
  editable?: boolean | (() => boolean);
  /**
   * What to do with serialized blocks whose type has no registered codec.
   * Default `"preserve"` — they round-trip opaquely instead of vanishing.
   * See `UnknownBlockPolicy`.
   */
  unknownBlocks?: UnknownBlockPolicy;
  /**
   * Turn native spellcheck on for the editable root. Off by default because
   * the browser's red squiggles fight with `rangeDecorations` on a code or
   * diff view; a prose editor generally wants it on.
   */
  spellcheck?: boolean;
};

export type Editor = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  /**
   * Dispatch any registered command — typed built-ins or plugin commands.
   * Returns `false` when the command did not apply: unknown command, a plugin
   * command that returned false, or a mutating command while the editor is
   * read-only.
   */
  dispatch: (cmd: DispatchableCommand) => boolean;
  undo: () => void;
  redo: () => void;
  /**
   * Subscribe to the change batches each `dispatch` produces. Returns an
   * unsubscribe fn. Fires AFTER the stores are updated, so a listener reading
   * `docStore` sees the post-edit document.
   *
   * Feed the batch to `mapAnchor` to move anything anchored outside the
   * document — review comments, diagnostics, bookmarks — through the edit;
   * or forward it to a language server as an incremental `didChange` instead
   * of resending the whole file.
   *
   * Batches are empty for commands that don't move text (mark toggles, list
   * indent, caret motion), and a single `{ kind: "replaceDoc" }` for
   * wholesale swaps (`setDoc`, `setDocFromHTML`, undo, redo) where no anchor
   * survives.
   */
  onChange: (cb: (changes: DocChange[]) => void) => () => void;
  /**
   * Move an anchor through a set of changes. Returns null when the anchored
   * text was deleted outright, its block was removed, or the block's internal
   * shape changed unmappably.
   *
   * Also exported standalone as `mapAnchor` for callers batching up changes
   * off the editor instance.
   */
  mapAnchor: (
    anchor: Anchor,
    changes: readonly DocChange[],
    bias?: MapBias,
  ) => Anchor | null;
  /** Whether the document currently accepts input. Resolves the `editable`
   *  thunk if one was supplied. */
  isEditable: () => boolean;
  /** Replace the `editable` option with a fixed boolean and re-sync the root's
   *  `contenteditable` attribute. */
  setEditable: (editable: boolean) => void;
  EditorView: PublicView<EditorViewProps, void>;
  setDocFromHTML: (html: string, opts?: SetDocOptions) => void;
  /**
   * Replace the entire document with a SerializedDoc. By default resets the
   * selection to end-of-doc and clears history — used for swapping content on
   * top of a long-lived editor instance (e.g. routing between documents in a
   * docs site without reallocating the input pipeline & DOM listeners).
   * `opts.preserveSelection` / `opts.preserveHistory` opt out of each.
   *
   * For changes arriving on the SAME document from outside — a sync engine, an
   * agent, a collaborator — prefer the targeted commands
   * (`replaceBlocks`, `insertBlocks`, `removeBlocks`, `moveBlock` via
   * `dispatch`). They preserve untouched block identity, the caret and the
   * undo stack, and emit per-block `DocChange`s an `onChange` consumer can map
   * anchors through — none of which a wholesale replacement can do.
   */
  setDoc: (doc: SerializedDoc, opts?: SetDocOptions) => void;
  /**
   * Serialize the whole document. Memoized on `docStore` identity, so calling
   * it repeatedly between edits is free — hosts that hash, diff or re-derive
   * from the doc on every keystroke don't each pay a full walk.
   */
  toJSON: () => SerializedDoc;
  /**
   * Plain text straight off the model — the whole document (blocks joined by
   * `\n`), or one block when `blockId` is given. Cheaper and more direct than
   * `toJSON()` for hosts that only want characters: hashing the buffer,
   * diffing against disk, computing line starts, feeding a language server.
   */
  getText: (blockId?: BlockId) => string;
  /**
   * Append `specs` to the end of the doc. Preserves all existing block
   * identities (no full rebuild) so existing renders stay; the renderer's
   * identity-based shouldUpdate skips them. Returns the assigned block ids.
   * Specs may omit `id`; an id is generated when missing. Selection is left
   * untouched — callers move the caret separately if they want it on a new
   * block.
   */
  appendBlocks: (specs: BlockInsertInput[]) => BlockId[];
  /**
   * Prepend `specs` to the start of the doc. Same identity-preserving
   * mutation as `appendBlocks`. NOTE: prepending grows the doc upward; the
   * viewport will jump unless the host re-anchors scrollTop. The
   * `infiniteScrollPlugin` does this anchoring automatically; manual
   * callers can capture `scrollHeight` + `scrollTop` before the call and
   * adjust after the next animation frame.
   */
  prependBlocks: (specs: BlockInsertInput[]) => BlockId[];
  // Imperative focus / blur — wired in M3+.
  focus: () => void;
  blur: () => void;
  /** Read or change the editing mode (wysiwyg ↔ md). */
  getMode: () => EditorMode;
  setMode: (mode: EditorMode) => void;
  /** Plugin registry for this editor instance — exposed for advanced
   *  consumers (devtools, the M3 trigger manager, etc.). */
  registry: Registry;
  /**
   * The `CommandCtx` this editor's commands run with. Hand it to anything
   * that takes command-shaped actions — a slash-menu item's `run`, a toolbar
   * button — instead of assembling `{ docStore, selStore }` by hand, which is
   * how those call sites ended up mutating the stores directly and emitting
   * no changes.
   */
  commandCtx: CommandCtx;
  /**
   * Scroll a block into view by id. Works for both virtualized and
   * non-virtualized editors — for virtualized off-screen blocks, jumps
   * the scroll container to the height-index-resolved Y. Used by the
   * search plugin's jump-to-match; safe for any host code that wants
   * to focus a specific block (e.g. permalink navigation).
   */
  scrollToBlock: (
    blockId: BlockId,
    opts?: { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior },
  ) => void;
  /**
   * Whether this environment can paint `rangeDecorations` (the CSS Custom
   * Highlight API). When false NOTHING is painted — there is deliberately no
   * DOM fallback, because splitting spans to fake it would be visible to the
   * character-offset walk. Hosts that must degrade should branch on this and
   * render their own affordance instead.
   */
  supportsRangeDecorations: () => boolean;
  /**
   * Request a recompute + repaint of every registered range decoration. The
   * manager already refreshes on doc / scroll / block-mount changes; call
   * this when the state a source reads (a comment list, a diagnostics array)
   * changed without the document changing.
   *
   * Coalesced into the next animation frame, so calling it from a view
   * lifecycle hook — the natural place, since that's where you learn your
   * diagnostics moved — keeps the repaint off the keystroke's own task, and N
   * calls in one frame cost one repaint.
   */
  refreshRangeDecorations: () => void;
  /**
   * Repaint every range decoration NOW, before returning. Only for callers
   * that must observe the painted highlights synchronously (tests, a
   * measurement pass); prefer `refreshRangeDecorations()` everywhere else.
   */
  refreshRangeDecorationsSync: () => void;
  /**
   * Recompute and re-place every registered inline widget. The manager
   * already syncs on document, selection and viewport changes; call this when
   * the state a widget source reads changed on its own — a completion
   * arriving from a language server, inlay hints landing from an LSP round
   * trip.
   */
  refreshInlineWidgets: () => void;
  /**
   * Tear down the input pipeline, drop handlers, viewport tracking, overlay
   * managers, trigger manager and every plugin's `onInit` teardown /
   * `onDestroy`, and clear the change listeners and the root's editor
   * reference. Idempotent. The DOM the renderer produced is the host's to
   * unmount.
   */
  destroy: () => void;
};

// ---------------------------------------------------------------------------
// Serialization helpers — registry-driven per-block.
// ---------------------------------------------------------------------------

/**
 * What to do with a block whose type has no registered codec — a document
 * written by a client that had a plugin this one doesn't.
 *
 *  - `"preserve"` (default): keep it as an opaque, non-editable block that
 *    round-trips its original JSON byte-for-byte through the next `toJSON()`.
 *    Nothing is lost by opening a document in a client missing a plugin.
 *  - `"drop"`: discard it (the pre-0.4 behaviour, silent data loss).
 *  - `"throw"`: refuse the whole document.
 */
export type UnknownBlockPolicy = "preserve" | "drop" | "throw";

function deserializeDoc(
  s: SerializedDoc,
  policy: UnknownBlockPolicy = "preserve",
): DocState {
  const blocks: BlockSpec[] = [];
  for (const sb of s.blocks) {
    const id = sb.id ?? newBlockId();
    let decoded = registryDeserializeBlock(sb.type, sb, id);
    if (!decoded) {
      if (policy === "throw") {
        throw new Error(
          `creo-edit: no block codec registered for type "${sb.type}". ` +
            `Install the plugin that provides it, or set ` +
            `\`unknownBlocks: "preserve"\` to round-trip it opaquely.`,
        );
      }
      if (policy === "drop") continue;
      registerUnknownBlockType(sb.type);
      decoded = registryDeserializeBlock(sb.type, sb, id);
    }
    if (decoded) blocks.push(decoded);
  }
  return docFromBlocks(blocks);
}

function serializeDoc(doc: DocState): SerializedDoc {
  const blocks: SerializedBlock[] = [];
  for (const id of doc.order) {
    const b = doc.byId.get(id)!;
    const enc = registrySerializeBlock(b);
    if (enc) blocks.push(enc as SerializedBlock);
  }
  return { blocks };
}

// ---------------------------------------------------------------------------
// createEditor
// ---------------------------------------------------------------------------

/**
 * Every `t` the dispatch switch handles itself. Used by the read-only gate to
 * tell "built-in, refuse it" apart from "plugin command, ask the registry".
 */
const BUILTIN_COMMANDS = new Set<string>([
  "noop",
  "insertText",
  "deleteBackward",
  "deleteForward",
  "splitBlock",
  "mergeBackward",
  "mergeForward",
  "setBlockType",
  "toggleMark",
  "removeMark",
  "toggleList",
  "indentList",
  "outdentList",
  "insertImage",
  "insertTable",
  "insertColumns",
  "tableInsertRow",
  "tableInsertCol",
  "tableRemoveRow",
  "tableRemoveCol",
  "moveCursor",
  "moveBlock",
  "insertBlocks",
  "removeBlocks",
  "replaceBlocks",
]);

/** Built-ins that never touch the document, so they survive read-only mode. */
const READ_ONLY_SAFE_BUILTINS = new Set<string>(["noop", "moveCursor"]);

function historyTagFor(cmd: DispatchableCommand): string {
  switch (cmd.t) {
    case "insertText":
      return "text:insert";
    case "deleteBackward":
      return "text:deleteBack";
    case "deleteForward":
      return "text:deleteFwd";
    default:
      return cmd.t;
  }
}

function defaultSelection(doc: DocState): Selection {
  return { kind: "caret", at: endOfDoc(doc) };
}

export function createEditor(opts: EditorOptions = {}): Editor {
  const editorId = `creo-edit-${++__editorIdCounter}`;

  // Install plugins BEFORE we touch any block-bearing state so the
  // serialize codec, anchor codecs, and view registry are ready.
  const registry = new Registry();
  const installedPlugins: EditorPlugin[] = [...defaultPlugins, ...(opts.plugins ?? [])];
  for (const p of installedPlugins) registry.install(p);

  const initialDoc = opts.initial
    ? deserializeDoc(opts.initial, opts.unknownBlocks ?? "preserve")
    : seedEmpty();
  const docStore = store.new<DocState>(initialDoc);

  // Selection store — separate from doc so caret movement doesn't dirty the
  // document subscribers (and vice versa).
  const selStore = store.new<Selection>(defaultSelection(initialDoc));

  let nativeInput: NativeInputHandle | null = null;
  let drop: DropHandle | null = null;
  let viewport: ViewportHandle | null = null;
  let decorations: DecorationManager | null = null;
  let rangeDecorations: RangeDecorationManager | null = null;
  let inlineWidgets: InlineWidgetManager | null = null;
  void nativeInput;
  void drop;
  void viewport;
  void decorations;
  void rangeDecorations;
  void inlineWidgets;

  // The registry supplies the coalescing rule, so a plugin's
  // `historyCoalescePrefixes` finally has an effect — it was collected into
  // `Registry.coalescePrefixes` and never consulted, because `createHistory`
  // hard-coded `tag.startsWith("text:")`.
  const history: History = createHistory({ docStore, selStore }, registry);
  // Microtask rebalance — keeps fractional indices short under adversarial
  // insertion patterns. No-op on every doc change unless any key has
  // outgrown the soft threshold.
  attachAutoRebalance(docStore);

  // The command context every command — built-in and plugin — receives.
  // `dispatch` and `editor` are filled by closure/getter rather than by value
  // because both are defined further down; nothing reads them until a command
  // actually runs, by which point both exist.
  let editorSelf: Editor | null = null;
  const ctx: CommandCtx = {
    docStore,
    selStore,
    dispatch: ((a: unknown, b?: unknown): boolean =>
      typeof a === "string"
        ? dispatch({ t: a, payload: b })
        : dispatch(a as DispatchableCommand)) as CommandCtx["dispatch"],
    change: recordChange,
    get editor(): Editor {
      return editorSelf!;
    },
  };

  // -------------------------------------------------------------------------
  // Read-only support. `editableOpt` holds whatever the host supplied — a
  // boolean or a thunk — and is re-read on every check so a thunk-driven flip
  // takes effect without recreating the editor.
  // -------------------------------------------------------------------------
  let editableOpt: boolean | (() => boolean) = opts.editable ?? true;
  const isEditable = (): boolean =>
    typeof editableOpt === "function" ? editableOpt() !== false : editableOpt !== false;
  const setEditable = (editable: boolean): void => {
    editableOpt = editable;
    nativeInput?.syncEditable();
  };
  // Plugin commands are gated inside the registry so keymap fall-through
  // (matchPluginKeymap → runCommand) sees the same answer as dispatch().
  registry.isEditable = isEditable;

  // Trigger manager — needs `dispatch` for plugin trigger callbacks. Defined
  // before dispatch so the dispatch closure can reference it; the manager
  // gets the dispatch fn injected by closure rather than via `this`.
  let dispatchRef: ((cmd: DispatchableCommand) => void) | null = null;
  const triggers = new TriggerManager({
    registry,
    docStore,
    selStore,
    dispatch: (cmd) => dispatchRef?.(cmd),
    commandCtx: ctx,
  });

  // ---- Change stream -----------------------------------------------------
  const changeListeners = new Set<(changes: DocChange[]) => void>();
  const onChange = (cb: (changes: DocChange[]) => void): (() => void) => {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
  };
  const emitChanges = (changes: DocChange[]): void => {
    if (changes.length === 0 || changeListeners.size === 0) return;
    // Snapshot the listener set so a subscriber unsubscribing (or a new one
    // subscribing) mid-emit doesn't disturb this pass.
    for (const cb of [...changeListeners]) {
      try {
        cb(changes);
      } catch {
        // A misbehaving listener must not abort the edit that already landed.
      }
    }
  };

  const runDispatch = (cmd: DispatchableCommand): boolean => {
    // Read-only gate. Built-ins that never touch the document are allowed
    // through; every other built-in is refused before `history.record` so no
    // empty undo step is pushed. Plugin commands are gated inside
    // `registry.runCommand`, which honours `CommandDef.readOnlySafe`.
    if (!isEditable() && !READ_ONLY_SAFE_BUILTINS.has(cmd.t)) {
      if (BUILTIN_COMMANDS.has(cmd.t)) return false;
      const def = registry.commands.get(cmd.t);
      if (!def || def.readOnlySafe !== true) return false;
    }
    // Snapshot for undo BEFORE mutating. Tag drives coalescing.
    history.record(historyTagFor(cmd));
    switch (cmd.t) {
      case "noop":
        return true;
      case "insertText":
        cmdInsertText(ctx, (cmd as Extract<Command, { t: "insertText" }>).text);
        return true;
      case "deleteBackward":
        cmdDeleteBackward(ctx);
        return true;
      case "deleteForward":
        cmdDeleteForward(ctx);
        return true;
      case "splitBlock":
        cmdSplitBlock(ctx);
        return true;
      case "mergeBackward":
        cmdMergeBackward(ctx);
        return true;
      case "mergeForward":
        cmdMergeForward(ctx);
        return true;
      case "setBlockType":
        cmdSetBlockType(ctx, (cmd as Extract<Command, { t: "setBlockType" }>).payload);
        return true;
      case "toggleMark": {
        const c = cmd as Extract<Command, { t: "toggleMark" }>;
        return cmdToggleMark(ctx, c.mark, c.attrs ?? null);
      }
      case "removeMark":
        return cmdRemoveMark(ctx, (cmd as Extract<Command, { t: "removeMark" }>).mark);
      case "toggleList":
        cmdToggleList(ctx, (cmd as Extract<Command, { t: "toggleList" }>).ordered);
        return true;
      case "indentList":
        cmdIndentList(ctx);
        return true;
      case "outdentList":
        cmdOutdentList(ctx);
        return true;
      case "insertImage": {
        const c = cmd as Extract<Command, { t: "insertImage" }>;
        cmdInsertImage(ctx, { src: c.src, alt: c.alt, width: c.width, height: c.height });
        return true;
      }
      case "insertTable": {
        const c = cmd as Extract<Command, { t: "insertTable" }>;
        cmdInsertTable(ctx, { rows: c.rows, cols: c.cols });
        return true;
      }
      case "insertColumns": {
        const c = cmd as Extract<Command, { t: "insertColumns" }>;
        cmdInsertColumns(ctx, { cols: c.cols });
        return true;
      }
      case "tableInsertRow":
        return registry.runCommand("tableInsertRow", { where: (cmd as Extract<Command, { t: "tableInsertRow" }>).where }, ctx);
      case "tableInsertCol":
        return registry.runCommand("tableInsertCol", { where: (cmd as Extract<Command, { t: "tableInsertCol" }>).where }, ctx);
      case "tableRemoveRow":
        return registry.runCommand("tableRemoveRow", undefined, ctx);
      case "tableRemoveCol":
        return registry.runCommand("tableRemoveCol", undefined, ctx);
      case "moveCursor": {
        const c = cmd as Extract<Command, { t: "moveCursor" }>;
        moveTo(ctx, c.to, c.extend === true);
        return true;
      }
      case "moveBlock":
        return cmdMoveBlock(ctx, (cmd as Extract<Command, { t: "moveBlock" }>).payload);
      case "insertBlocks":
        return cmdInsertBlocks(
          ctx,
          (cmd as Extract<Command, { t: "insertBlocks" }>).payload,
        );
      case "removeBlocks":
        return removeBlocksCmd(
          ctx,
          (cmd as Extract<Command, { t: "removeBlocks" }>).blockIds,
        );
      case "replaceBlocks":
        return cmdReplaceBlocks(
          ctx,
          (cmd as Extract<Command, { t: "replaceBlocks" }>).blocks,
        );
      default: {
        // Plugin command — route through the registry. Payload shape is
        // plugin-defined; built-ins handled above don't reach this branch.
        const payload = (cmd as { payload?: unknown }).payload;
        return registry.runCommand(cmd.t, payload, ctx);
      }
    }
  };

  /**
   * Single mutation entry point. Wraps the command in a change collector so
   * the batch it produced reaches `onChange` subscribers — commands emit into
   * an ambient sink rather than threading a return value through every nested
   * call, so `insertText → mergeBackward → insertText` still yields one flat,
   * ordered batch.
   */
  // Depth guard: a plugin command that re-enters `dispatch` would otherwise
  // deliver its changes twice — once for the inner call, then again as part
  // of the outer batch that `collectChanges` folds them into. Only the
  // outermost dispatch emits, and it emits everything in order.
  let dispatchDepth = 0;
  const dispatch = (cmd: DispatchableCommand): boolean => {
    dispatchDepth++;
    let batch: DocChange[];
    let result: boolean;
    try {
      const collected = collectChanges(() => runDispatch(cmd));
      result = collected.result;
      batch = collected.changes;
    } finally {
      dispatchDepth--;
    }
    if (dispatchDepth === 0) emitChanges(batch);
    return result;
  };

  dispatchRef = dispatch;

  // Undo / redo mutate the document, so they follow the same gate. They
  // restore whole snapshots, so no anchor can be mapped across them —
  // subscribers get `replaceDoc` and re-derive.
  const undo = (): void => {
    if (!isEditable()) return;
    if (history.undo()) emitChanges([{ kind: "replaceDoc", reason: "undo" }]);
  };
  const redo = (): void => {
    if (!isEditable()) return;
    if (history.redo()) emitChanges([{ kind: "replaceDoc", reason: "redo" }]);
  };

  /**
   * Swap the document wholesale. `preserveSelection` re-clamps the current
   * caret onto the new document instead of jumping to the end, and
   * `preserveHistory` keeps the undo stack — both off by default, which is
   * the old behaviour and the right one for "the host routed to a different
   * document".
   *
   * For changes arriving from OUTSIDE on the SAME document — a sync engine, an
   * agent, a collaborator — reach for `replaceBlocks` / `insertBlocks` /
   * `removeBlocks` / `moveBlock` instead. They keep every untouched block's
   * identity (so the renderer re-renders only what moved), keep the caret, keep
   * undo, and emit per-block changes an `onChange` consumer can map anchors
   * through. `setDoc` can do none of that: it is a replacement, and it says so.
   */
  const applyReplacement = (
    next: DocState,
    reason: "setDoc" | "setDocFromHTML",
    replaceOpts?: SetDocOptions,
  ): void => {
    const prevSel = selStore.get();
    docStore.set(next);
    selStore.set(
      replaceOpts?.preserveSelection
        ? clampSelection(next, prevSel)
        : defaultSelection(next),
    );
    if (!replaceOpts?.preserveHistory) history.reset();
    emitChanges([{ kind: "replaceDoc", reason }]);
  };

  const setDocFromHTML = (html: string, htmlOpts?: SetDocOptions): void => {
    const blocks = parseHTML(html);
    if (blocks.length === 0) return;
    applyReplacement(docFromBlocks(blocks), "setDocFromHTML", htmlOpts);
  };

  const setDoc = (s: SerializedDoc, setOpts?: SetDocOptions): void => {
    // Plugin doc-level deserialize hooks run before the block codecs, in
    // registration order, so a plugin can migrate or unwrap the payload.
    let wire: SerializedDoc = s;
    for (const p of installedPlugins) {
      if (p.deserializeDoc) wire = p.deserializeDoc(wire as never) as SerializedDoc;
    }
    applyReplacement(
      deserializeDoc(wire, opts.unknownBlocks ?? "preserve"),
      "setDoc",
      setOpts,
    );
  };

  // Serialization is O(doc) and hosts call it far more often than they think
  // — once to hash the buffer, once per diagnostic, once to diff against
  // disk. `DocState` is replaced wholesale on every mutation, so its identity
  // is an exact cache key: one serialize per document version, no matter how
  // many callers ask.
  let jsonCacheDoc: DocState | null = null;
  let jsonCache: SerializedDoc | null = null;
  const toJSON = (): SerializedDoc => {
    const doc = docStore.get();
    if (jsonCacheDoc === doc && jsonCache) return jsonCache;
    let out = serializeDoc(doc);
    for (const p of installedPlugins) {
      if (p.serializeDoc) out = p.serializeDoc(out as never) as SerializedDoc;
    }
    jsonCacheDoc = doc;
    jsonCache = out;
    return out;
  };

  const getText = (blockId?: BlockId): string => {
    const doc = docStore.get();
    if (blockId !== undefined) {
      const b = doc.byId.get(blockId);
      return b ? blockTextOf(b) : "";
    }
    const parts: string[] = [];
    for (const id of doc.order) {
      const b = doc.byId.get(id);
      if (b) parts.push(blockTextOf(b));
    }
    return parts.join("\n");
  };

  // ---------------------------------------------------------------------
  // appendBlocks / prependBlocks — identity-preserving doc growth used by
  // the infinite-scroll plugin and any host that wants to add blocks
  // without disturbing existing block renders or the caret.
  // ---------------------------------------------------------------------
  const ensureIds = (specs: BlockInsertInput[]): BlockSpec[] => {
    return specs.map(
      (s) => (s.id ? s : { ...s, id: newBlockId() }) as BlockSpec,
    );
  };
  const emitInserts = (ids: BlockId[], at: number): void => {
    emitChanges(
      ids.map((blockId, i) => ({
        kind: "insertBlock" as const,
        blockId,
        index: at + i,
      })),
    );
  };
  const appendBlocks = (specs: BlockInsertInput[]): BlockId[] => {
    if (specs.length === 0) return [];
    const withIds = ensureIds(specs);
    const doc = docStore.get();
    const at = doc.order.length;
    docStore.set(insertManyAt(doc, at, withIds));
    const ids = withIds.map((s) => s.id!);
    emitInserts(ids, at);
    return ids;
  };
  const prependBlocks = (specs: BlockInsertInput[]): BlockId[] => {
    if (specs.length === 0) return [];
    const withIds = ensureIds(specs);
    const doc = docStore.get();
    docStore.set(insertManyAt(doc, 0, withIds));
    const ids = withIds.map((s) => s.id!);
    emitInserts(ids, 0);
    return ids;
  };

  // Mode state — held in a creo store so the EditorView re-renders when it
  // changes. Default "wysiwyg" matches the legacy non-mode behavior.
  const modeStore = store.new<EditorMode>(opts.mode ?? "wysiwyg");
  const getMode = (): EditorMode => modeStore.get();
  const setMode = (m: EditorMode): void => {
    if (modeStore.get() === m) return;
    modeStore.set(m);
  };

  const scrollToBlock = (
    blockId: BlockId,
    opts?: { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior },
  ): void => {
    const order = docStore.get().order;
    const idx = order.indexOf(blockId);
    if (idx < 0) return;
    const root = getRoot();
    if (!root) return;
    const escaped = blockId.replace(/(["\\])/g, "\\$1");
    const el = root.querySelector(
      `[data-block-kind][data-block-id="${escaped}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({
        block: opts?.block ?? "center",
        behavior: opts?.behavior ?? "auto",
      });
      return;
    }
    // Virtualized off-screen — defer to VirtualDoc's height-index-aware
    // scroller exposed at mount time.
    const v = (root as unknown as {
      __creoVirtual?: {
        scrollToIndex: (
          i: number,
          opts?: { block?: "start" | "center" | "end" | "nearest"; behavior?: ScrollBehavior },
        ) => void;
      };
    }).__creoVirtual;
    v?.scrollToIndex(idx, opts);
  };

  const focus = (): void => {
    getRoot()?.focus();
  };
  const blur = (): void => {
    getRoot()?.blur();
  };

  // Cmd+A selects the editable "section" surrounding the caret — the run
  // of blocks bounded by the nearest atomic blocks (calendar, date-marker,
  // image…) above and below, rather than the entire doc. Wiping the
  // current list with Cmd+A → Backspace shouldn't also wipe every other
  // section's content. Pressing Cmd+A again when the section is already
  // fully selected expands to the whole doc so the "select everything"
  // intent stays reachable.
  const handleSelectAll = (): void => {
    const doc = docStore.get();
    if (doc.order.length === 0) return;
    const sel = selStore.get();
    const pivotId = sel.kind === "caret" ? sel.at.blockId : sel.anchor.blockId;
    const pivotIdx = doc.order.indexOf(pivotId);
    const pivotBlock = pivotIdx >= 0 ? doc.byId.get(pivotId) : undefined;

    // Caret on an atomic block, or pivot block missing — fall back to
    // the original whole-doc behavior.
    if (!pivotBlock || isAtomicBlockType(pivotBlock.type)) {
      selStore.set({
        kind: "range",
        anchor: homeOfDoc(doc),
        focus: endOfDocAnchor(doc),
      });
      return;
    }

    // Walk outward to find the editable section's edges.
    let startIdx = pivotIdx;
    while (startIdx > 0) {
      const prev = doc.byId.get(doc.order[startIdx - 1]!);
      if (prev && isAtomicBlockType(prev.type)) break;
      startIdx--;
    }
    let endIdx = pivotIdx;
    while (endIdx < doc.order.length - 1) {
      const next = doc.byId.get(doc.order[endIdx + 1]!);
      if (next && isAtomicBlockType(next.type)) break;
      endIdx++;
    }
    const startId = doc.order[startIdx]!;
    const endId = doc.order[endIdx]!;
    const sectionStart = homeOfBlock(doc, {
      blockId: startId,
      path: [0],
      offset: 0,
    });
    const sectionEnd = endOfBlock(doc, {
      blockId: endId,
      path: [0],
      offset: 0,
    });

    // Progressive expansion: if the section is ALREADY fully selected,
    // expand to whole-doc. Detected by comparing the current range's
    // ordered endpoints with the section's endpoints.
    if (sel.kind === "range") {
      const docStart = homeOfDoc(doc);
      const docEnd = endOfDocAnchor(doc);
      const a = sel.anchor;
      const f = sel.focus;
      const matchesSection =
        (anchorEq(a, sectionStart) && anchorEq(f, sectionEnd)) ||
        (anchorEq(a, sectionEnd) && anchorEq(f, sectionStart));
      const alreadyWholeDoc =
        (anchorEq(a, docStart) && anchorEq(f, docEnd)) ||
        (anchorEq(a, docEnd) && anchorEq(f, docStart));
      if (matchesSection && !alreadyWholeDoc) {
        selStore.set({ kind: "range", anchor: docStart, focus: docEnd });
        return;
      }
    }

    selStore.set({ kind: "range", anchor: sectionStart, focus: sectionEnd });
  };

  const anchorEq = (a: Anchor, b: Anchor): boolean =>
    a.blockId === b.blockId &&
    a.offset === b.offset &&
    a.path.length === b.path.length &&
    a.path.every((v, i) => v === b.path[i]);

  // ---- Plugin paste hooks --------------------------------------------
  // Read the clipboard flavours once and offer them to each plugin in
  // registration order; the first `true` claims the event.
  const runPasteHooks = (e: ClipboardEvent): boolean => {
    if (!installedPlugins.some((p) => p.onPaste)) return false;
    const data = e.clipboardData;
    const pasteCtx: PasteCtx = {
      event: e,
      html: data?.getData("text/html") ?? "",
      text: data?.getData("text/plain") ?? "",
      files: data?.files ? Array.from(data.files) : [],
      docStore,
      selStore,
      editor: editorSelf!,
    };
    for (const p of installedPlugins) {
      try {
        if (p.onPaste?.(pasteCtx) === true) return true;
      } catch {
        // A misbehaving hook must not swallow the paste.
      }
    }
    return false;
  };

  // ---- Root element ----------------------------------------------------
  // Captured at mount rather than re-resolved with `document.querySelector`
  // on every call: the query form returns null before mount (so `focus()` was
  // a silent no-op) and finds nothing at all inside a shadow root, since the
  // document-level query cannot cross the boundary.
  let rootEl: HTMLElement | null = null;
  const getRoot = (): HTMLElement | null => rootEl;

  // ---- Teardown --------------------------------------------------------
  const pluginTeardowns: (() => void)[] = [];
  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    nativeInput?.destroy();
    nativeInput = null;
    drop?.destroy();
    drop = null;
    viewport?.destroy();
    viewport = null;
    decorations?.destroy();
    decorations = null;
    rangeDecorations?.destroy();
    rangeDecorations = null;
    inlineWidgets?.destroy();
    inlineWidgets = null;
    triggers.destroy();
    for (const t of pluginTeardowns.splice(0)) {
      try {
        t();
      } catch {
        // One plugin's failed teardown must not strand the others.
      }
    }
    for (const p of installedPlugins) {
      try {
        p.onDestroy?.(editorSelf!);
      } catch {
        // Same.
      }
    }
    changeListeners.clear();
    if (rootEl) clearEditorRef(rootEl);
    rootEl = null;
  };

  // EditorView — minimal contentEditable wrapper. The browser handles caret,
  // drag-selection, IME composition, and the long-press OS context menu;
  // attachNativeInput intercepts beforeinput and translates it into commands.
  const EditorView: PublicView<EditorViewProps, void> = view<EditorViewProps>(
    ({ props, use }) => {
      const doc = use(docStore);
      // Subscribe to mode changes so the wrapper re-renders (and CSS class
      // updates).
      void use(modeStore);

      return {
        onMount() {
          const root = document.querySelector(
            `[data-creo-edit="${editorId}"]`,
          ) as HTMLElement | null;
          if (!root) return;
          rootEl = root;
          // Publish the editor on its root so decorations and block views —
          // which the renderer creates, and which therefore receive no editor
          // argument — can walk up and find it (`dom/editorRef`). It is the
          // whole typed `Editor` now, not an ad-hoc bag of five fields.
          setEditorRef(root, editorSelf!);
          root.spellcheck = opts.spellcheck === true;
          nativeInput = attachNativeInput(
            root,
            { docStore, selStore },
            {
              dispatch,
              undo,
              redo,
              selectAll: () => handleSelectAll(),
              uploadImage: opts.uploadImage,
              registry,
              commandCtx: ctx,
              onPaste: runPasteHooks,
              triggers,
              isEditable,
            },
          );
          drop = attachDrop(
            root,
            { docStore, selStore },
            opts.uploadImage,
            isEditable,
          );
          viewport = attachVisualViewport(root, { docStore, selStore });
          // Decoration manager — only mounts a layer if at least one
          // plugin contributes a decoration. Cheap to instantiate either
          // way; the layer is empty when there are no decorations.
          // Guard against repeated onMount invocations (Creo re-mounts the
          // view when its props identity changes, e.g. on plugin toggles in
          // the demo): tear down the previous instance before creating a
          // new one so we don't accumulate orphan layers + listeners.
          if (registry.decorations.length > 0) {
            decorations?.destroy();
            decorations = new DecorationManager({
              registry,
              docStore,
              editorRoot: root,
            });
          }
          if (registry.rangeDecorations.length > 0) {
            rangeDecorations?.destroy();
            rangeDecorations = new RangeDecorationManager({
              registry,
              docStore,
              editorRoot: root,
            });
          }
          if (registry.inlineWidgets.length > 0) {
            inlineWidgets?.destroy();
            inlineWidgets = new InlineWidgetManager({
              registry,
              docStore,
              selStore,
              editorRoot: root,
            });
          }
        },
        render() {
          const mode = modeStore.get();
          const modeCls = mode === "md" ? " creo-edit-md" : " creo-edit-wysiwyg";
          const cls =
            (props()?.class
              ? `creo-edit ${props()!.class}`
              : "creo-edit") + modeCls;
          div(
            {
              class: cls,
              "data-creo-edit": editorId,
              // `cursor: text` so hovering shows the I-beam. Image blocks
              // override this to keep the default pointer arrow.
              //
              // `white-space: pre-wrap` is REQUIRED — the default `normal`
              // collapses trailing spaces visually, so typing a space at
              // end-of-line would advance the model offset but never render.
              style: "position:relative;cursor:text;white-space:pre-wrap;",
            },
            () => {
              if (opts.virtualized) {
                VirtualDoc({
                  docStore,
                  selStore,
                  estimatedHeight: opts.virtualEstimatedHeight,
                  // Without this the virtualizer resolves "the first editor
                  // in the document", which is the wrong one as soon as a
                  // page holds two.
                  editorId,
                });
              } else {
                DocView({ doc: doc.get() });
              }
            },
          );
          void _;
        },
      };
    },
  );

  const editor: Editor = {
    docStore,
    selStore,
    dispatch,
    undo,
    redo,
    onChange,
    mapAnchor: mapAnchorPure,
    isEditable,
    setEditable,
    EditorView,
    setDocFromHTML,
    setDoc,
    toJSON,
    getText,
    appendBlocks,
    prependBlocks,
    focus,
    blur,
    getMode,
    setMode,
    registry,
    commandCtx: ctx,
    scrollToBlock,
    supportsRangeDecorations: () => RangeDecorationManager.isSupported(),
    refreshRangeDecorations: () => rangeDecorations?.schedule(),
    refreshRangeDecorationsSync: () => rangeDecorations?.refresh(),
    refreshInlineWidgets: () => inlineWidgets?.sync(),
    destroy,
  };
  editorSelf = editor;

  // Plugin init runs last, so a plugin can look up another plugin's commands
  // and hold the editor handle. Not a DOM hook — the root is not mounted yet.
  for (const p of installedPlugins) {
    try {
      const teardown = p.onInit?.(editor);
      if (teardown) pluginTeardowns.push(teardown);
    } catch (err) {
      // One plugin failing to initialise must not take the editor down with
      // it — the rest of the document still has to load.
      console.error(`creo-edit: plugin "${p.name}" onInit failed`, err);
    }
  }

  return editor;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedEmpty(): DocState {
  // A fresh editor needs at least one empty paragraph so the user has
  // something to type into.
  const block: BlockSpec = {
    id: newBlockId(),
    type: "p",
    runs: [],
  };
  return docFromBlocks([block]);
}

// Re-export emptyDoc for convenience.
export { emptyDoc };
