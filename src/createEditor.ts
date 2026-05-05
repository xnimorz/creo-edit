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
import { homeOfDoc, endOfDocAnchor } from "./controller/navigation";
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
import { toggleMark as cmdToggleMark } from "./commands/markCommands";
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
import { endOfDoc } from "./controller/selection";
import { createHistory, type History } from "./controller/history";
import { attachAutoRebalance } from "./model/rebalance";
import {
  attachNativeInput,
  type NativeInputHandle,
} from "./input/nativeInput";
import { docFromBlocks, emptyDoc, newBlockId } from "./model/doc";
import type {
  Anchor,
  Block,
  BlockSpec,
  DocState,
  InlineRun,
  Mark,
  Selection,
} from "./model/types";
import { DocView } from "./render/DocView";
import { VirtualDoc } from "./virtual/VirtualDoc";
import { defaultPlugins } from "./plugin/builtin";
import { Registry } from "./plugin/registry";
import {
  deserializeBlock as registryDeserializeBlock,
  serializeBlock as registrySerializeBlock,
} from "./plugin/serializeCodec";
import { TriggerManager } from "./plugin/triggers";
import { DecorationManager } from "./plugin/decorations";
import type { EditorPlugin } from "./plugin/types";

let __editorIdCounter = 0;

// ---------------------------------------------------------------------------
// Public-facing types
// ---------------------------------------------------------------------------

export type SerializedRun = {
  text: string;
  marks?: string[]; // mark identifiers
};

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
  | { t: "toggleMark"; mark: Mark }
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
  | { t: "moveCursor"; to: Anchor; extend?: boolean };

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
};

export type Editor = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  /** Dispatch any registered command — typed built-ins or plugin commands. */
  dispatch: (cmd: DispatchableCommand) => void;
  undo: () => void;
  redo: () => void;
  EditorView: PublicView<EditorViewProps, void>;
  setDocFromHTML: (html: string) => void;
  /**
   * Replace the entire document with a SerializedDoc. Resets selection to
   * the end and clears history — used for swapping content on top of a
   * long-lived editor instance (e.g. routing between different docs in a
   * docs site without reallocating the input pipeline & DOM listeners).
   */
  setDoc: (doc: SerializedDoc) => void;
  toJSON: () => SerializedDoc;
  // Imperative focus / blur — wired in M3+.
  focus: () => void;
  blur: () => void;
  /** Read or change the editing mode (wysiwyg ↔ md). */
  getMode: () => EditorMode;
  setMode: (mode: EditorMode) => void;
  /** Plugin registry for this editor instance — exposed for advanced
   *  consumers (devtools, the M3 trigger manager, etc.). */
  registry: Registry;
};

// ---------------------------------------------------------------------------
// Serialization helpers — registry-driven per-block.
// ---------------------------------------------------------------------------

function deserializeDoc(s: SerializedDoc): DocState {
  const blocks: BlockSpec[] = [];
  for (const sb of s.blocks) {
    const id = sb.id ?? newBlockId();
    const decoded = registryDeserializeBlock(sb.type, sb, id);
    if (decoded) blocks.push(decoded);
    // Unknown block types are silently dropped — same posture the old
    // exhaustive switch took for unrecognized variants.
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
  const editorId = `creo-editor-${++__editorIdCounter}`;

  // Install plugins BEFORE we touch any block-bearing state so the
  // serialize codec, anchor codecs, and view registry are ready.
  const registry = new Registry();
  for (const p of defaultPlugins) registry.install(p);
  if (opts.plugins) for (const p of opts.plugins) registry.install(p);

  const initialDoc = opts.initial
    ? deserializeDoc(opts.initial)
    : seedEmpty();
  const docStore = store.new<DocState>(initialDoc);

  // Selection store — separate from doc so caret movement doesn't dirty the
  // document subscribers (and vice versa).
  const selStore = store.new<Selection>(defaultSelection(initialDoc));

  let nativeInput: NativeInputHandle | null = null;
  let drop: DropHandle | null = null;
  let viewport: ViewportHandle | null = null;
  let decorations: DecorationManager | null = null;
  void nativeInput;
  void drop;
  void viewport;
  void decorations;

  const history: History = createHistory({ docStore, selStore });
  // Microtask rebalance — keeps fractional indices short under adversarial
  // insertion patterns. No-op on every doc change unless any key has
  // outgrown the soft threshold.
  attachAutoRebalance(docStore);

  const ctx = { docStore, selStore };

  // Trigger manager — needs `dispatch` for plugin trigger callbacks. Defined
  // before dispatch so the dispatch closure can reference it; the manager
  // gets the dispatch fn injected by closure rather than via `this`.
  let dispatchRef: ((cmd: DispatchableCommand) => void) | null = null;
  const triggers = new TriggerManager({
    registry,
    docStore,
    selStore,
    dispatch: (cmd) => dispatchRef?.(cmd),
  });

  const dispatch = (cmd: DispatchableCommand): void => {
    // Snapshot for undo BEFORE mutating. Tag drives coalescing.
    history.record(historyTagFor(cmd));
    switch (cmd.t) {
      case "noop":
        return;
      case "insertText":
        cmdInsertText(ctx, (cmd as Extract<Command, { t: "insertText" }>).text);
        return;
      case "deleteBackward":
        cmdDeleteBackward(ctx);
        return;
      case "deleteForward":
        cmdDeleteForward(ctx);
        return;
      case "splitBlock":
        cmdSplitBlock(ctx);
        return;
      case "mergeBackward":
        cmdMergeBackward(ctx);
        return;
      case "mergeForward":
        cmdMergeForward(ctx);
        return;
      case "setBlockType":
        cmdSetBlockType(ctx, (cmd as Extract<Command, { t: "setBlockType" }>).payload);
        return;
      case "toggleMark":
        cmdToggleMark(ctx, (cmd as Extract<Command, { t: "toggleMark" }>).mark);
        return;
      case "toggleList":
        cmdToggleList(ctx, (cmd as Extract<Command, { t: "toggleList" }>).ordered);
        return;
      case "indentList":
        cmdIndentList(ctx);
        return;
      case "outdentList":
        cmdOutdentList(ctx);
        return;
      case "insertImage": {
        const c = cmd as Extract<Command, { t: "insertImage" }>;
        cmdInsertImage(ctx, { src: c.src, alt: c.alt, width: c.width, height: c.height });
        return;
      }
      case "insertTable": {
        const c = cmd as Extract<Command, { t: "insertTable" }>;
        cmdInsertTable(ctx, { rows: c.rows, cols: c.cols });
        return;
      }
      case "insertColumns": {
        const c = cmd as Extract<Command, { t: "insertColumns" }>;
        cmdInsertColumns(ctx, { cols: c.cols });
        return;
      }
      case "tableInsertRow":
        registry.runCommand("tableInsertRow", { where: (cmd as Extract<Command, { t: "tableInsertRow" }>).where }, ctx);
        return;
      case "tableInsertCol":
        registry.runCommand("tableInsertCol", { where: (cmd as Extract<Command, { t: "tableInsertCol" }>).where }, ctx);
        return;
      case "tableRemoveRow":
        registry.runCommand("tableRemoveRow", undefined, ctx);
        return;
      case "tableRemoveCol":
        registry.runCommand("tableRemoveCol", undefined, ctx);
        return;
      case "moveCursor": {
        const c = cmd as Extract<Command, { t: "moveCursor" }>;
        moveTo(ctx, c.to, c.extend === true);
        return;
      }
      default: {
        // Plugin command — route through the registry. Payload shape is
        // plugin-defined; built-ins handled above don't reach this branch.
        const payload = (cmd as { payload?: unknown }).payload;
        registry.runCommand(cmd.t, payload, ctx);
        return;
      }
    }
  };

  dispatchRef = dispatch;

  const undo = (): void => {
    history.undo();
  };
  const redo = (): void => {
    history.redo();
  };

  const setDocFromHTML = (html: string): void => {
    const blocks = parseHTML(html);
    if (blocks.length === 0) return;
    docStore.set(docFromBlocks(blocks));
    selStore.set(defaultSelection(docStore.get()));
    history.reset();
  };

  const setDoc = (s: SerializedDoc): void => {
    docStore.set(deserializeDoc(s));
    selStore.set(defaultSelection(docStore.get()));
    history.reset();
  };

  const toJSON = (): SerializedDoc => serializeDoc(docStore.get());

  // Mode state — held in a creo store so the EditorView re-renders when it
  // changes. Default "wysiwyg" matches the legacy non-mode behavior.
  const modeStore = store.new<EditorMode>(opts.mode ?? "wysiwyg");
  const getMode = (): EditorMode => modeStore.get();
  const setMode = (m: EditorMode): void => {
    if (modeStore.get() === m) return;
    modeStore.set(m);
  };

  const focus = (): void => {
    const root = document.querySelector(
      `[data-creo-editor="${editorId}"]`,
    ) as HTMLElement | null;
    root?.focus();
  };
  const blur = (): void => {
    const root = document.querySelector(
      `[data-creo-editor="${editorId}"]`,
    ) as HTMLElement | null;
    root?.blur();
  };

  const handleSelectAll = (): void => {
    const doc = docStore.get();
    const start = homeOfDoc(doc);
    const end = endOfDocAnchor(doc);
    selStore.set({ kind: "range", anchor: start, focus: end });
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
            `[data-creo-editor="${editorId}"]`,
          ) as HTMLElement | null;
          if (!root) return;
          // Expose the editor stores on the root so decoration plugins
          // (drag handle, add-block) can access docStore/selStore without
          // an explicit handle argument. Marked as a hidden property so
          // it doesn't clutter the DOM inspector.
          (root as unknown as { __creoEditor?: unknown }).__creoEditor = {
            docStore,
            selStore,
            dispatch,
          };
          nativeInput = attachNativeInput(
            root,
            { docStore, selStore },
            {
              dispatch,
              undo: () => history.undo(),
              redo: () => history.redo(),
              selectAll: () => handleSelectAll(),
              uploadImage: opts.uploadImage,
              registry,
              triggers,
            },
          );
          drop = attachDrop(root, { docStore, selStore }, opts.uploadImage);
          viewport = attachVisualViewport(root, { docStore, selStore });
          // Decoration manager — only mounts a layer if at least one
          // plugin contributes a decoration. Cheap to instantiate either
          // way; the layer is empty when there are no decorations.
          if (registry.decorations.length > 0) {
            decorations = new DecorationManager({
              registry,
              docStore,
              editorRoot: root,
            });
          }
        },
        render() {
          const mode = modeStore.get();
          const modeCls = mode === "md" ? " creo-editor-md" : " creo-editor-wysiwyg";
          const cls =
            (props()?.class
              ? `creo-editor ${props()!.class}`
              : "creo-editor") + modeCls;
          div(
            {
              class: cls,
              "data-creo-editor": editorId,
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

  return {
    docStore,
    selStore,
    dispatch,
    undo,
    redo,
    EditorView,
    setDocFromHTML,
    setDoc,
    toJSON,
    focus,
    blur,
    getMode,
    setMode,
    registry,
  };
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

// Avoid an unused-import warning on Block in some downstream typings.
void (null as unknown as Block);
void (null as unknown as InlineRun);
