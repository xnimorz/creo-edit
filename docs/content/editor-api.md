# Editor API

`createEditor(options?)` returns an `Editor` handle: a small set of stores, a dispatcher, history controls, and the `EditorView` to mount.

## `createEditor(options?)`

```ts
import { createEditor } from "creo-edit";

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
| `virtualized` | `boolean \| (() => boolean)` | `false` | Mount only the blocks near the viewport. A thunk is read at every render of the root — window only the documents long enough to need it. See [Virtualization](#/virtualization). |
| `virtualEstimatedHeight` | `number` | `32` | Estimated block height (px) used before measurement. Tune to your typical block size. |
| `virtualEstimateHeight` | `(block) => number` | — | A per-block estimate, for a steadier scrollbar. |
| `virtualOverscan` | `number` | `1.5` | Viewport heights mounted above and below what is visible. |
| `virtualHidden` | `Store<ReadonlySet<BlockId>>` | — | Blocks not drawn and taking no height (folded sections). |
| `virtualSpacerStyle` | `(doc, nextIndex) => string` | — | Extra style for a spacer — CSS carried through the document, such as list counters. |
| `mode` | `"wysiwyg" \| "md"` | `"wysiwyg"` | Editing mode. `"md"` pairs with `mdShortcutsPlugin` for markdown typing rules. See [Editing modes](#/editing-modes). |
| `plugins` | `EditorPlugin[]` | `[]` | Plugins to install in addition to the built-in defaults (paragraph, heading, list, code-block, image, cells). See [Authoring plugins](#/plugin-authoring). |
| `editable` | `boolean \| (() => boolean)` | `true` | Whether the document accepts input. See [Read-only editors](#read-only-editors). |
| `keepCaretVisible` | `boolean` | `true` | Scroll the caret back into view when the soft keyboard covers it. See [Mobile](#/mobile). |
| `confirmDelete` | `(block) => boolean` | — | Asked before a selected atomic block is deleted; `false` keeps it. See [Atomic blocks are selected before they are deleted](#atomic-blocks-are-selected-before-they-are-deleted). |

## The `Editor` handle

```ts
type Editor = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  dispatch: (cmd: DispatchableCommand) => boolean;
  undo: () => void;
  redo: () => void;
  EditorView: PublicView<EditorViewProps, void>;
  setDoc: (doc: SerializedDoc) => void;
  setDocFromHTML: (html: string) => void;
  toJSON: () => SerializedDoc;
  getText: (blockId?: BlockId) => string;
  appendBlocks: (specs: BlockInsertInput[]) => BlockId[];
  prependBlocks: (specs: BlockInsertInput[]) => BlockId[];
  applyBlocks: (patch: BlockPatch, opts?: { history?: boolean }) => BlockId[];
  focus: () => void;
  blur: () => void;
  getMode: () => EditorMode;
  setMode: (mode: EditorMode) => void;
  scrollToBlock: (id: BlockId, opts?) => void;
  registry: Registry;        // plugin registry (introspection)

  // Read-only
  isEditable: () => boolean;
  setEditable: (editable: boolean) => void;

  // Position mapping
  onChange: (cb: (changes: DocChange[]) => void) => () => void;
  mapAnchor: (a: Anchor, changes: readonly DocChange[], bias?: "left" | "right") => Anchor | null;

  // Plugin overlays
  supportsRangeDecorations: () => boolean;
  refreshRangeDecorations: () => void;      // coalesced into the next frame
  refreshRangeDecorationsSync: () => void;  // repaints before returning
  refreshInlineWidgets: () => void;
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

Returns `false` when the command did not apply: an unknown command, a plugin command that returned `false`, or a mutating command while the editor is read-only.

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

The result is memoized on the document's identity, so calling it repeatedly between edits costs nothing — one serialization per document version, however many callers ask.

### `getText(blockId?)`

Plain text straight off the model: the whole document with blocks joined by `\n`, or one block when `blockId` is given. Table cells join with `\t` across and `\n` down; atomic blocks (images) contribute nothing.

Characters are counted exactly the way anchors count them — a `code` block's newlines are real characters in both — so `getText(id).slice(0, anchor.offset)` is the text before that anchor. Reach for this rather than `toJSON()` when you only want characters: hashing the buffer, diffing against disk, computing line starts, feeding a language server.

### `applyBlocks(patch, opts?)`

For changes that arrive from outside on the same document while someone may be reading or typing in it: a file re-read from disk, an agent's rewrite, a sync. The host decides *what* changed; the editor applies it without replacing the document.

```ts
editor.applyBlocks({
  remove: ["b3"],
  replace: [{ id: "b1", type: "p", runs: [{ text: "The new wording" }] }],
  insert: [{ blocks: [{ id: "n1", type: "h2", runs: [{ text: "Risks" }] }], after: "b1" }],
});
```

- Applied in the order `remove`, `replace`, `insert`. Blocks are in wire form, as `setDoc` takes them. A `replace` keeps the block's place; an id the document does not have is ignored. An `insert` run goes after `after` (`null` for the start), before `before`, or at the end.
- Not gated by `editable`, like `setDoc`.
- Untouched blocks keep their identity, so only what changed re-renders.
- `onChange` hears per-block changes. A text block whose text changed is one `text` change over the span that differs, so an anchor before or after it maps instead of being dropped; the same text with a new type or marks is `blockAttrs`; a table or other shape that no offset describes is `resetBlock`; blocks that changed order are `moveBlock`.
- The selection is carried through those changes, and clamped only where its text is gone.
- No undo step unless `{ history: true }`. History is snapshots, so undoing past an unrecorded patch restores a document from before it.

### `focus()` / `blur()`

Moves keyboard focus to / from the editor root. Call `focus()` after any toolbar interaction so the user can keep typing without clicking back into the editor.

## Read-only editors

A diff view, a commit-detail pane or an agent transcript must not be editable. Set `editable: false`:

```ts
const viewer = createEditor({ initial: doc, editable: false });
```

This is honoured in **two** places, not one:

- the `contenteditable` attribute on the editor root, which stops the browser originating edits (typing, IME, drop, paste); and
- the command dispatcher — every mutating command returns `false` instead of running.

The attribute alone would be insufficient, because `dispatch()` is public: a plugin or the host could still mutate the document straight through it.

Pass a **thunk** when the host wants to flip the flag without recreating the editor — e.g. while an agent is mid-write:

```ts
let agentWriting = false;
const editor = createEditor({ editable: () => !agentWriting });
```

The thunk is re-read on every check, and the `contenteditable` attribute is re-synced on the events that precede any edit (focus, pointerdown). `setEditable(bool)` replaces the option with a fixed value and syncs immediately.

What stays available while read-only:

- caret motion (`moveCursor`), selection, copy — a cut degrades to a copy;
- plugin commands that opt in with `readOnlySafe: true` (the built-in table / columns navigation commands do);
- host-level document APIs — `setDoc`, `setDocFromHTML`, `appendBlocks`, `prependBlocks`, `applyBlocks`. That's how a read-only viewer loads its content, so gating them would be self-defeating.

`undo()` / `redo()` are gated, and refused commands are rejected *before* the history snapshot, so read-only dispatches leave no empty undo steps behind.

## Atomic blocks are selected before they are deleted

A Backspace or Delete next to an atomic block (an image, a rule, a diagram, any `isAtomic` plugin block) selects it first; the next press deletes it. That covers a caret on the block itself, at the start of the block after it (Backspace) and at the end of the block before it (Delete). A press meant for one character never takes a whole diagram with it.

- "Selected" is a range from one side of the block to the other. Build one with `nodeSelection(blockId)`; `nodeSelectedBlock(doc, selection)` reads it back.
- The block's view is passed `selected: true` while it is selected, and only its view re-renders when that changes.
- `confirmDelete(block)` is asked before the second press deletes; return `false` to keep the block — for instance to ask in your own dialog, then `dispatch({ t: "deleteAtomic", blockId })` once the user agrees.
- The deletion is the built-in `deleteAtomic` command: one undo step, a `removeBlock` change, refused when read-only or locked.

## Locked blocks

Some blocks are not the user's to change — a decision already agreed, text quoted from elsewhere, a block another party owns — but should still read, select and copy like the rest. Mark them `locked`:

```ts
editor.setDoc({ blocks: [
  { type: "p", runs: [{ text: "Decided: the schema stays." }], locked: true },
  { type: "p", runs: [{ text: "Your notes here" }] },
] });
```

- Every editing command is refused when its changes would reach a locked block: typing, deleting, splitting it, merging into or out of it, formatting, pasting into it, a range delete that reaches it. The refusal is whole — no undo step, no `onChange`, the redo trail kept — and `dispatch` returns `false`.
- Selecting, copying and `moveBlock` still work: the lock is about content, not position.
- The host's own APIs (`setDoc`, `applyBlocks`, `appendBlocks`) are not refused; they are how the owner changes it.
- `locked: true` round-trips through `toJSON()` / `setDoc()` for every block type.
- A type whose blocks are always (or conditionally) locked declares `BlockDef.locked(block)`.
- The built-in views draw a locked block with `contenteditable="false"` and `data-locked="true"`, so the browser cannot type or compose into it. A plugin view does the same by spreading `lockedAttrs(block)` into its outer element. `isLockedBlock(block)` answers for either source.

## Position mapping across edits

An `Anchor` held **outside** the document — a review comment, an LSP diagnostic, a bookmark — silently points at the wrong place after the next keystroke. Re-anchoring by searching for the original text is a heuristic that fails as soon as two lines are identical.

`onChange` gives you a description of what each dispatch did, and `mapAnchor` moves an anchor through it:

```ts
import { mapAnchor, type DocChange, type Anchor } from "creo-edit";

let commentFrom: Anchor | null = /* ... */;
let commentTo: Anchor | null = /* ... */;

editor.onChange((changes: DocChange[]) => {
  // Bias outward so text typed at either edge stays inside the comment.
  commentFrom = commentFrom && mapAnchor(commentFrom, changes, "right");
  commentTo = commentTo && mapAnchor(commentTo, changes, "left");
  // A range needs BOTH ends mapped — and a collapse means its text is gone.
  if (!commentFrom || !commentTo || commentFrom.offset >= commentTo.offset) {
    detachComment();
  }
});
```

`onChange` returns an unsubscribe fn and fires *after* the stores are updated.

> **Mapping a range, not just a point.** `mapAnchor` moves *one* anchor. When
> you track a range, map both endpoints and then check whether they collapsed:
> deleting the text *between* two anchors nulls neither of them, because
> neither endpoint is strictly inside the deleted span — they both survive, on
> top of each other. `from >= to` is how you learn the covered text is gone.
> Only an anchor strictly inside a deletion maps to `null`.

### `DocChange`

```ts
type DocChange =
  // A text edit, in the block's own coordinate space. `container` is the
  // anchor path minus its trailing char offset: [] for text-bearing blocks,
  // [row, col] for a table cell, [col] for a columns cell.
  | { kind: "text"; blockId: BlockId; container: number[];
      from: number; to: number; insertedLength: number }
  // `blockId` split at `at`; the tail now lives in the new block `into`.
  | { kind: "split"; blockId: BlockId; at: number; into: BlockId }
  // `blockId` was consumed into `into`, starting at `atOffset`.
  | { kind: "merge"; blockId: BlockId; into: BlockId; atOffset: number }
  | { kind: "insertBlock"; blockId: BlockId; index: number }
  | { kind: "removeBlock"; blockId: BlockId }
  // Internal shape changed unmappably (a table row inserted above the
  // anchor's row). Anchors inside the block map to null.
  | { kind: "resetBlock"; blockId: BlockId }
  // Whole document replaced (setDoc / setDocFromHTML / undo / redo). On
  // undo and redo it is `described`: the changes before it in the batch say
  // what the step changed block by block, and anchors map through it.
  | { kind: "replaceDoc"; reason?: "setDoc" | "setDocFromHTML" | "undo" | "redo"; described?: true };
```

Granularity is per-block rather than a whole-document offset space. `mapAnchor` returns `null` when the anchored text was deleted outright, its block was removed, or its block was reset — which is the honest answer, and better than a plausible wrong anchor.

The same batches are what LSP incremental sync wants for `didChange`, so a host can forward them instead of resending the whole file on every keystroke.

Batches are empty for commands that move no text (mark toggles, list indent / outdent, `setBlockType`, caret motion).

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
      depth?: number;
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
