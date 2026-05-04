# Architecture

This page is a tour of the engine, not an API reference. If you want to understand WHY the editor behaves the way it does — or you're considering forking it — start here.

## Two stores, on purpose

The editor exposes two reactive stores:

```ts
docStore: Store<DocState>
selStore: Store<Selection>
```

They're separate because text editors have a fundamental performance asymmetry: the cursor moves on every keystroke, but the document only changes on most of them. If the cursor lived in `DocState`, every arrow key would dirty every document subscriber. Splitting them means typing dirties only `docStore`, arrow keys dirty only `selStore`, and your own UI can subscribe to whichever it actually cares about.

The cost is a small amount of cross-store coordination inside commands (a delete needs both the doc and the selection to compute its result). The win is that an editor with a big rendered surface stays fast.

## No `contentEditable`

`contentEditable` lets the browser own a region of the DOM and translate user input into mutations. That's convenient until you have to make the model the source of truth, at which point you're parsing the browser's mutations back into your model — and the gap between "what the browser did" and "what your model says" is full of edge cases.

The editor takes the other path. A hidden `<textarea>` lives at the caret position. `keydown`, `input`, `compositionstart/update/end`, and `paste`/`copy`/`cut` all fire on the textarea, get classified by `inputPipeline.ts`, and dispatched as commands. The visible document is rendered output of `docStore` — no `contentEditable` set anywhere.

The win:

- **Deterministic input.** Every keystroke goes through one entry point.
- **IME works.** Composition events fire on the textarea exactly as they do on a normal one.
- **Mobile soft keyboards work.** Same.
- **Clipboard works.** `paste` on a hidden textarea is no different from a visible one, with the upside that we can intercept and route HTML / plain / file payloads through our own paste pipeline.

The cost:

- **No native selection UI on touch devices.** We draw our own handles and mobile toolbar.
- **No browser spellcheck UI on the visible text.** The textarea is hidden, so the OS doesn't draw underlines on document text.

## Block model

```ts
type DocState = {
  byId: Map<BlockId, Block>;
  order: BlockId[];   // sorted by Block.index ascending
};
```

`order` is sorted by each block's `index: FracIndex` — a base-62 fractional key (`model/fractional.ts`). To insert between two blocks you pick a key that sorts between their keys; no array splice, no renumber. Insert-between is O(log n), insert-at-end is O(1).

Fractional keys can grow unbounded under adversarial insertion patterns (always insert between A and the next key after A, repeatedly). The editor watches for keys that exceed a soft length threshold and rebalances — it walks the order, generates evenly-spaced keys, and writes them back. `attachAutoRebalance` schedules this in a microtask after every doc change, so the check is cheap and the rebalance only runs when needed.

The `id` field is opaque (`newBlockId()` issues monotonically-increasing ids). `byId.get(id)` is the canonical way to look up a block; `iterBlocks(doc)` walks them in order.

## Anchors

Positions inside blocks are encoded as `{ blockId, path: number[], offset }`. The path encodes which "slot" inside the block the position refers to:

- text-bearing (`p`/`h*`/`li`): `[charOffset]`
- `table`: `[row, col, charOffset]`
- `columns`: `[colIndex, charOffset]`
- `img`: `[side]` where `side` is 0 (before) or 1 (after)

`runsAt(block, anchor)` (`model/cellAccess.ts`) is the canonical way to walk into the right runs slot regardless of block kind. New code that operates on "the runs at this anchor" should always go through it, not hand-roll path indexing.

## Commands and history

`createEditor.dispatch(cmd)` is the single mutation entry point. Two things happen:

1. `history.record(tag)` snapshots `docStore` and `selStore` with a string tag.
2. The command runs, mutating one or both stores via the `commands/<group>Commands.ts` modules.

History uses tag-based coalescing. Adjacent records with the same tag merge into one undo step. Typing inserts repeat with tag `"text:insert"` so a stream of typed characters is one undo. A bold-toggle in the middle changes the tag and breaks the run.

Commands are deliberately small and composable. Higher-level flows (paste, drop, "select all then delete") are sequences of dispatches, NOT new commands.

## Rendering

`DocView` is a keyed reconciler over `doc.order`. Each block maps to one of the views in `render/blocks/` — `ParagraphView`, `HeadingView`, `ListItemView`, `TableView`, `ImageView`, `ColumnsView`. Inline runs go through `InlineRunsView`.

The performance contract is **O(1) blocks per keystroke**: when you type into block X, only X's `InlineRunsView` should re-render. The mechanism is two-part:

1. Blocks are immutable — when you mutate a block, you replace the whole `Block` value with a new one. So Creo's identity check (`prev === next`) tells the reconciler exactly which slots changed.
2. `DocView`'s `shouldUpdate` returns `false` for blocks whose identity hasn't changed.

Result: a 10,000-block document with one untouched character takes the same render time as a 10-block one with the same edit. If you ever see render time growing with document size, that's a regression — block identity has been compromised somewhere upstream.

## Virtualization

`VirtualDoc` is the alternate render path opted into by `virtualized: true`. Only blocks intersecting `[scrollTop − overscan, scrollTop + viewport + overscan]` are mounted. A `HeightIndex` (Fenwick tree of measured per-block heights) resolves "what blocks are at this scroll offset" in O(log n).

Heights are estimated for unmeasured blocks (`virtualEstimatedHeight`) and replaced with real measurements as they mount. Cumulative offsets are exact for visited blocks and approximate for the rest — visible scroll position is therefore stable, and the scroll thumb's "completion" estimate gets more accurate as the user explores.

## Public API surface

`src/index.ts` is the contract. Anything exported there is part of the package; anything else is internal and may change without a major version bump. The export list is intentionally small:

- `createEditor` and its types
- A handful of low-level `model/doc` helpers (for advanced consumers building on top of the model directly)
- The render-layer views (for advanced layout work — most apps use only `EditorView` from the handle)
- `VirtualDoc` and `HeightIndex` (for virtualization customisation)
- `isCoarsePointer` (mobile detection helper)
