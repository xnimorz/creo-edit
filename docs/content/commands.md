# Commands

Every mutation goes through `editor.dispatch(cmd)`. The `Command` type is a discriminated union on `t` — TypeScript will tell you which extra fields each variant needs.

```ts
editor.dispatch({ t: "insertText", text: "hello" });
editor.dispatch({ t: "toggleMark", mark: "b" });
editor.dispatch({ t: "splitBlock" });
```

## Text editing

| Command | Effect |
|---|---|
| `{ t: "insertText", text }` | Insert literal text at the caret. If a range is selected, replaces it first. |
| `{ t: "deleteBackward" }` | Backspace. Deletes the selection if non-empty, otherwise the previous character (and merges blocks at start-of-block). |
| `{ t: "deleteForward" }` | Delete-forward. Symmetric with `deleteBackward`. |

## Structural

| Command | Effect |
|---|---|
| `{ t: "splitBlock" }` | Enter — split the current block at the caret. Mid-text → two blocks of the same type; at end of a heading → new paragraph below. |
| `{ t: "mergeBackward" }` | Backspace at start-of-block — merge with the previous block (joining text, dropping list/heading shape if appropriate). |
| `{ t: "mergeForward" }` | Delete at end-of-block — merge with the next block. |
| `{ t: "setBlockType", payload }` | Change the current block's type. Payload is `{ type: "p" \| "h1"…"h6" \| "li" }` (with `ordered`/`depth` for `li`). |

## Marks

| Command | Effect |
|---|---|
| `{ t: "toggleMark", mark }` | Toggle a `Mark` (`"b" \| "i" \| "u" \| "s" \| "code"`) over the selection (or at the caret as a "pending mark" applied to the next typed character). |

## Lists

| Command | Effect |
|---|---|
| `{ t: "toggleList", ordered }` | Convert the current paragraph into an `li` (ordered/unordered), or back into `p`. |
| `{ t: "indentList" }` | Increase `depth` of the current list item (max 3). |
| `{ t: "outdentList" }` | Decrease `depth`. At depth 0, converts back to a paragraph. |

## Insertion

| Command | Effect |
|---|---|
| `{ t: "insertImage", src, alt?, width?, height? }` | Insert an image block after the current block. |
| `{ t: "insertTable", rows, cols }` | Insert an empty table block. |
| `{ t: "insertColumns", cols }` | Insert an N-column layout block (similar to a 1-row table, rendered as flex columns). |

## Tables

| Command | Effect |
|---|---|
| `{ t: "tableInsertRow", where }` | `where: "above" \| "below"` — add a row relative to the current cell. |
| `{ t: "tableInsertCol", where }` | `where: "before" \| "after"` |
| `{ t: "tableRemoveRow" }` | Remove the row containing the selection. |
| `{ t: "tableRemoveCol" }` | Remove the column. |

These are no-ops if the selection isn't inside a table cell.

## Selection

| Command | Effect |
|---|---|
| `{ t: "moveCursor", to, extend? }` | Move the caret to an `Anchor`. With `extend: true`, the existing selection's `anchor` is held and `focus` becomes `to` (Shift+arrow behavior). |

For selection construction, the model exports helpers like `endOfDoc(doc)` from `creo-edit`'s public surface — see [Editor API](#/editor-api).

## History and coalescing

`dispatch` records a snapshot before applying each command, then groups same-tag adjacent records into one undo step:

| Command | History tag |
|---|---|
| `insertText` | `text:insert` |
| `deleteBackward` | `text:deleteBack` |
| `deleteForward` | `text:deleteFwd` |
| everything else | the command's own `t` (no coalescing — each is its own step) |

So a string of typed characters collapses into one undo, and a mark toggle made between two typed runs splits them into three undo steps.

You don't have to call into history yourself unless you want to coalesce custom flows — `editor.undo()` and `editor.redo()` are the only public hooks.
