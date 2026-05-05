import { _ } from "creo";
import { div, store, view } from "creo";
import type { PublicView, Store } from "creo";
import { moveTo } from "./commands/navigationCommands";
import {
  tableInsertCol as cmdTableInsertCol,
  tableInsertRow as cmdTableInsertRow,
  tableRemoveCol as cmdTableRemoveCol,
  tableRemoveRow as cmdTableRemoveRow,
} from "./commands/tableCommands";
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
  BlockSpec,
  DocState,
  InlineRun,
  Mark,
  Selection,
} from "./model/types";
import { DocView } from "./render/DocView";
import { VirtualDoc } from "./virtual/VirtualDoc";

let __editorIdCounter = 0;

// ---------------------------------------------------------------------------
// Public-facing types
// ---------------------------------------------------------------------------

export type SerializedRun = {
  text: string;
  marks?: string[]; // mark identifiers
};

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

export type SerializedDoc = {
  blocks: SerializedBlock[];
};

export type EditorViewProps = {
  class?: string;
};

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

export type EditorMode = "regular" | "mono";

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
   * "regular" → system sans-serif body font, headings/blocks styled normally.
   * "mono"    → monospaced font on every block (good for code editors,
   *             markdown source, log inspection). Affects font-family on
   *             the editor root via the `creo-editor-mono` class.
   */
  mode?: EditorMode;
};

export type Editor = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  dispatch: (cmd: Command) => void;
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
};

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function deserializeRun(r: SerializedRun): InlineRun {
  if (!r.marks || r.marks.length === 0) return { text: r.text };
  // Filter to known marks.
  const allowed = new Set(["b", "i", "u", "s", "code"]);
  const marks = new Set<InlineRun extends { marks?: ReadonlySet<infer M> }
    ? M
    : never>();
  for (const m of r.marks) {
    if (allowed.has(m)) marks.add(m as never);
  }
  return marks.size === 0 ? { text: r.text } : { text: r.text, marks };
}

function deserializeDoc(s: SerializedDoc): DocState {
  const blocks: BlockSpec[] = s.blocks.map((sb) => {
    const id = sb.id ?? newBlockId();
    switch (sb.type) {
      case "p":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return {
          id,
          type: sb.type,
          runs: sb.runs.map(deserializeRun),
        } as BlockSpec;
      case "li":
        return {
          id,
          type: "li",
          ordered: sb.ordered,
          depth: sb.depth ?? 0,
          runs: sb.runs.map(deserializeRun),
        } as BlockSpec;
      case "code":
        return {
          id,
          type: "code",
          runs: sb.runs.map(deserializeRun),
          ...(sb.lang ? { lang: sb.lang } : {}),
        } as BlockSpec;
      case "img":
        return {
          id,
          type: "img",
          src: sb.src,
          alt: sb.alt,
          width: sb.width,
          height: sb.height,
        } as BlockSpec;
      case "table":
        return {
          id,
          type: "table",
          rows: sb.rows,
          cols: sb.cols,
          cells: sb.cells.map((row) =>
            row.map((cell) => cell.map(deserializeRun)),
          ),
        } as BlockSpec;
      case "columns":
        return {
          id,
          type: "columns",
          cols: sb.cols,
          cells: sb.cells.map((cell) => cell.map(deserializeRun)),
        } as BlockSpec;
    }
  });
  return docFromBlocks(blocks);
}

function serializeRun(r: InlineRun): SerializedRun {
  if (!r.marks || r.marks.size === 0) return { text: r.text };
  return { text: r.text, marks: [...r.marks] };
}

function serializeDoc(doc: DocState): SerializedDoc {
  const blocks: SerializedBlock[] = [];
  for (const id of doc.order) {
    const b = doc.byId.get(id)!;
    switch (b.type) {
      case "p":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        blocks.push({ id: b.id, type: b.type, runs: b.runs.map(serializeRun) });
        break;
      case "li":
        blocks.push({
          id: b.id,
          type: "li",
          ordered: b.ordered,
          depth: b.depth,
          runs: b.runs.map(serializeRun),
        });
        break;
      case "code":
        blocks.push({
          id: b.id,
          type: "code",
          runs: b.runs.map(serializeRun),
          ...(b.lang ? { lang: b.lang } : {}),
        });
        break;
      case "img":
        blocks.push({
          id: b.id,
          type: "img",
          src: b.src,
          alt: b.alt,
          width: b.width,
          height: b.height,
        });
        break;
      case "columns":
        blocks.push({
          id: b.id,
          type: "columns",
          cols: b.cols,
          cells: b.cells.map((cell) => cell.map(serializeRun)),
        });
        break;
      case "table":
        blocks.push({
          id: b.id,
          type: "table",
          rows: b.rows,
          cols: b.cols,
          cells: b.cells.map((row) =>
            row.map((cell) => cell.map(serializeRun)),
          ),
        });
        break;
    }
  }
  return { blocks };
}

// ---------------------------------------------------------------------------
// createEditor
// ---------------------------------------------------------------------------

function historyTagFor(cmd: Command): string {
  switch (cmd.t) {
    // Coalesce-eligible groups — same prefix → merged into one undo step.
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
  void nativeInput;
  void drop;
  void viewport;

  const history: History = createHistory({ docStore, selStore });
  // Microtask rebalance — keeps fractional indices short under adversarial
  // insertion patterns. No-op on every doc change unless any key has
  // outgrown the soft threshold.
  attachAutoRebalance(docStore);

  const dispatch = (cmd: Command): void => {
    // Snapshot for undo BEFORE mutating. Tag drives coalescing.
    history.record(historyTagFor(cmd));
    switch (cmd.t) {
      case "noop":
        return;
      case "insertText":
        cmdInsertText({ docStore, selStore }, cmd.text);
        return;
      case "deleteBackward":
        cmdDeleteBackward({ docStore, selStore });
        return;
      case "deleteForward":
        cmdDeleteForward({ docStore, selStore });
        return;
      case "splitBlock":
        cmdSplitBlock({ docStore, selStore });
        return;
      case "mergeBackward":
        cmdMergeBackward({ docStore, selStore });
        return;
      case "mergeForward":
        cmdMergeForward({ docStore, selStore });
        return;
      case "setBlockType":
        cmdSetBlockType({ docStore, selStore }, cmd.payload);
        return;
      case "toggleMark":
        cmdToggleMark({ docStore, selStore }, cmd.mark);
        return;
      case "toggleList":
        cmdToggleList({ docStore, selStore }, cmd.ordered);
        return;
      case "indentList":
        cmdIndentList({ docStore, selStore });
        return;
      case "outdentList":
        cmdOutdentList({ docStore, selStore });
        return;
      case "insertImage":
        cmdInsertImage(
          { docStore, selStore },
          { src: cmd.src, alt: cmd.alt, width: cmd.width, height: cmd.height },
        );
        return;
      case "insertTable":
        cmdInsertTable(
          { docStore, selStore },
          { rows: cmd.rows, cols: cmd.cols },
        );
        return;
      case "insertColumns":
        cmdInsertColumns({ docStore, selStore }, { cols: cmd.cols });
        return;
      case "tableInsertRow":
        cmdTableInsertRow({ docStore, selStore }, cmd.where);
        return;
      case "tableInsertCol":
        cmdTableInsertCol({ docStore, selStore }, cmd.where);
        return;
      case "tableRemoveRow":
        cmdTableRemoveRow({ docStore, selStore });
        return;
      case "tableRemoveCol":
        cmdTableRemoveCol({ docStore, selStore });
        return;
      case "moveCursor":
        moveTo({ docStore, selStore }, cmd.to, cmd.extend === true);
        return;
    }
  };

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

      return {
        onMount() {
          const root = document.querySelector(
            `[data-creo-editor="${editorId}"]`,
          ) as HTMLElement | null;
          if (!root) return;
          nativeInput = attachNativeInput(
            root,
            { docStore, selStore },
            {
              dispatch,
              undo: () => history.undo(),
              redo: () => history.redo(),
              selectAll: () => handleSelectAll(),
              uploadImage: opts.uploadImage,
            },
          );
          drop = attachDrop(root, { docStore, selStore }, opts.uploadImage);
          viewport = attachVisualViewport(root, { docStore, selStore });
        },
        render() {
          const modeCls =
            opts.mode === "mono" ? " creo-editor-mono" : " creo-editor-regular";
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
