# Editor API

`createEditor(options?)` returns an `Editor` handle: a small set of stores, a dispatcher, history controls, and the `EditorView` to mount.

## `createEditor(options?)`

```ts
import { createEditor } from "creo-editor";

const editor = createEditor({
  initial: { blocks: [/* ... */] },
  uploadImage: async (file) => "/uploads/" + file.name,
  virtualized: true,
  virtualEstimatedHeight: 32,
  mode: "wysiwyg",
  plugins: [],
});
```

### `EditorOptions`

| Field | Type | Default | What it does |
|---|---|---|---|
| `initial` | `SerializedDoc` | one empty `p` | Starting document. See [Block format](#/block-format). |
| `uploadImage` | `(File) => Promise<string>` | `URL.createObjectURL` | Called when the user pastes / drops an image. Returns the URL to store in the model. Without it, a temporary `blob:` URL is used. |
| `virtualized` | `boolean` | `false` | If `true`, only viewport-intersecting blocks are mounted. See [Virtualization](#/virtualization). |
| `virtualEstimatedHeight` | `number` | `32` | Estimated block height (px) used before measurement. Tune to your typical block size. |
| `mode` | `"wysiwyg" \| "md"` | `"wysiwyg"` | Editing mode. `"md"` pairs with `mdShortcutsPlugin` for markdown typing rules. See [Editing modes](#/editing-modes). |
| `plugins` | `EditorPlugin[]` | `[]` | Plugins to install in addition to the built-in defaults (paragraph, heading, list, code-block, image, cells). See [Authoring plugins](#/plugin-authoring). |

## The `Editor` handle

```ts
type Editor = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  dispatch: (cmd: DispatchableCommand) => void;
  undo: () => void;
  redo: () => void;
  EditorView: PublicView<EditorViewProps, void>;
  setDoc: (doc: SerializedDoc) => void;
  setDocFromHTML: (html: string) => void;
  toJSON: () => SerializedDoc;
  focus: () => void;
  blur: () => void;
  getMode: () => EditorMode;
  setMode: (mode: EditorMode) => void;
  registry: Registry;        // plugin registry (introspection)
};
```

### `docStore`

The reactive document. `Store<DocState>` where:

```ts
type DocState = {
  byId: Map<BlockId, Block>;
  order: BlockId[];          // sorted by Block.index ascending
};
```

Subscribe with `use(editor.docStore)` from any Creo `view`. The store is mutated only by commands and by `setDocFromHTML` — don't write to it directly unless you've thought carefully about history and selection invariants.

### `selStore`

The reactive selection — separate from `docStore` so caret motion never dirties document subscribers, and vice versa.

```ts
type Selection =
  | { kind: "caret"; at: Anchor }
  | { kind: "range"; anchor: Anchor; focus: Anchor };

type Anchor = {
  blockId: BlockId;
  path: number[];   // see "Anchor paths" below
  offset: number;
};
```

#### Anchor paths

The `path` field encodes position inside a block. The encoding depends on block type:

- **Text-bearing** (`p` / `h1`..`h6` / `li`): `[charOffset]`
- **Tables**: `[row, col, charOffset]`
- **Columns**: `[colIndex, charOffset]`
- **Images**: `[side]` where `side` is `0` (before) or `1` (after)

For most consumers you don't construct anchors by hand — you read them from selection events or pass anchors back via `dispatch({ t: "moveCursor", to: anchor })`.

### `dispatch(cmd)`

The single entry point for mutations. Snapshots state for undo before applying, then runs the matching command. See [Commands](#/commands) for the full union.

```ts
editor.dispatch({ t: "insertText", text: "hello" });
editor.dispatch({ t: "toggleMark", mark: "b" });
editor.dispatch({ t: "setBlockType", payload: { type: "h2" } });
```

### `undo()` / `redo()`

Walk the history stack. Same-tag adjacent commands are coalesced into one step (so a run of typing is one undo, not N).

### `EditorView`

The Creo view that renders the editor. Mount it inside any other view:

```ts
import { view, div } from "creo";

const App = view(() => ({
  render() {
    div({ class: "shell" }, () => {
      Toolbar();
      editor.EditorView();
    });
  },
}));
```

`EditorViewProps` accepts an optional `class` that's merged onto the editor root.

### `setDocFromHTML(html)`

Replaces the document with the result of parsing `html`. Resets selection to the end of the document and clears history.

```ts
editor.setDocFromHTML("<h1>Title</h1><p>Body</p>");
```

See [HTML interop](#/html-interop) for which HTML constructs round-trip.

### `toJSON()`

Returns a `SerializedDoc` — a plain JSON-safe object suitable for storage. Round-trips losslessly through `createEditor({ initial: doc })`.

### `focus()` / `blur()`

Moves keyboard focus to / from the editor root. Call `focus()` after any toolbar interaction so the user can keep typing without clicking back into the editor.

## `SerializedDoc`

```ts
type SerializedRun = {
  text: string;
  marks?: ("b" | "i" | "u" | "s" | "code")[];
};

type SerializedBlock =
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
      cells: SerializedRun[][][];   // [row][col][run]
    }
  | {
      id?: string;
      type: "columns";
      cols: number;
      cells: SerializedRun[][];     // [col][run]
    };

type SerializedDoc = { blocks: SerializedBlock[] };
```

`id` is optional on input — if omitted, a fresh id is generated. On output, the editor always includes ids so clients can use them as React/Creo keys, diff targets, or revision-tracking handles.
