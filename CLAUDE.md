# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run build` — runs `build.ts` (Bun bundle to `dist/index.js` ESM, then `tsc -p tsconfig.build.json` to emit `.d.ts`).
- `bun test src/` — runs the suite. Tests live in `src/**/__tests__/*.spec.ts`. Each test file explicitly `import "./setup"` (or `../__tests__/setup`) to install happy-dom globals — there is no global preload, so a new test file must do the same.
- Single file: `bun test src/__tests__/caret.spec.ts`. Single test: `bun test --test-name-pattern "<name>"`.
- `bun run typecheck` — `tsc --noEmit -p tsconfig.json`.
- `src/__perf__/` holds perf-style specs that also run under `bun test`.

`creo` is declared as a peer-dep (`>=0.2.9`); the published package has no other runtime deps.

## Sub-projects

- **`docs/`** — Vite-built documentation site (markdown + hash router). Aliases `creo-edit` → `../src/index.ts` so it tracks editor source live, and aliases `creo` → its own `node_modules/creo/dist/index.js` so editor source's `import "creo"` resolves when Rollup walks into `../src/`. The landing page embeds a real `createEditor()` so users can try it without leaving the page; `/demo` is a full-bleed version. Deployed to GitHub Pages by `.github/workflows/deploy-docs.yml`. Run with `cd docs && bun run dev`.
- **`examples/editor/`** — Vite + Playwright example app, primarily used for E2E tests (`bun run test`). Same alias setup as docs (`creo-edit` → local source, `creo` → local node_modules). Dev server on port 5183.

## Architecture

**Two independent stores.** `docStore: Store<DocState>` holds the document; `selStore: Store<Selection>` holds the cursor/range. They are deliberately separate so caret motion does not dirty document subscribers and vice versa. Every command function takes `{ docStore, selStore }` and mutates whichever stores it needs.

**Controlled `contentEditable`.** The editor root is `contenteditable="true"` (or `"false"` — see read-only below). The browser owns selection rendering, IME composition, and the OS context menu (long-press / right-click). The model is held canonical by intercepting every `beforeinput` event in `input/nativeInput.ts`, calling `preventDefault()`, and dispatching the equivalent editor command. The browser is allowed to mutate the DOM in only one situation — during an active IME composition — and we reconcile on `compositionend` by diffing the affected scope's `textContent` against the pre-composition snapshot.

**Anchor ↔ DOM mapping.** `dom/anchorMap.ts` exposes `domToAnchor(node, offset, root)`, `anchorToDom(anchor, root)` and the batch `anchorsToDom(anchors, root)`. The mapper is pure DOM — it walks `data-block-kind` (only the outer block container has it; cells share their parent's `data-block-id`) and descends into `data-cell` / `data-col` for table / columns cells. Editor root is the only place these attributes are produced, by the views in `render/blocks/`.

The character walks in `plugin/anchorCodec.ts` (`visibleTextLength`, `visibleTextOf`, `offsetWithinScope`, `findTextPoint`, `findTextPoints`) are the hottest code in the library — anchor path, IME path, selection path — so they iterate `firstChild`/`nextSibling` and never allocate per node visited.

`anchorsToDom` exists because a range-decoration repaint resolves two anchors per range and thousands of ranges per frame: it looks the block element up once per block id and hands each block's whole batch to `AnchorCodec.anchorsToDom` (optional; falls back to per-anchor). `codeBlockCodec` implements it by sorting on offset and walking each line once for all the anchors on it.

**Code-block anchors are O(log lines).** `CodeBlockView` publishes each line's model start offset as `data-line-start` (`LINE_START_ATTR`), so `codeBlockCodec.anchorToDom` binary-searches `blockEl.children` and then walks only the found line, and `domToAnchor` reads the owning line's attribute instead of summing every line above it. Both were O(lines × nodes) before, which made a syntax-highlighting repaint quadratic in file size. The attribute is additive — a host rendering its own code view without it still resolves, through the linear fallback still present in both functions.

**Selection sync.** `nativeInput.ts` keeps Anchor and native `Range` aligned with two coordination devices: a `programmaticSeq`/`lastObservedSeq` echo guard (skips the `selectionchange` event the browser fires after our own programmatic write), and a `renderPending` window cleared on the next animation frame after a docStore mutation (the renderer replaces text nodes for the changed block, native selection collapses onto detached nodes, and the second `selectionchange` would corrupt selStore without this).

**Block model** (`model/types.ts`). `DocState = { byId: Map<BlockId, Block>; order: BlockId[] }` where `order` is sorted by each block's `index: FracIndex` — a base-62 fractional key so insert-between is O(log n) with no renumbering (`model/fractional.ts`). `attachAutoRebalance` runs a microtask check after each mutation and rebalances only when a key has outgrown the soft threshold. Block kinds: `p`, `h1..h6`, `li` (with `ordered`/`depth`), `code` (multi-line monospaced; Enter inserts `\n` instead of splitting), `img`, `table`, `columns`. `isTextBearing()` (`model/blockText.ts`) is the canonical predicate for "block has a top-level `runs: InlineRun[]` field" — `p`/`h*`/`li`/`code`. Use it for command logic that should apply to any text-bearing block.

**Anchors** are `{ blockId, path: number[], offset }`. Path encoding by block type:
- text-bearing (`p`/`h*`/`li`/`code`): `[charOffset]`
- `table`: `[row, col, charOffset]`
- `columns`: `[colIndex, charOffset]`
- `img`: `[side]` where `side` is 0 (before) or 1 (after)

`runsAt(block, anchor)` (`model/cellAccess.ts`) is the canonical way to walk into the right runs slot regardless of block kind — prefer it over hand-rolled path indexing.

**Inline runs** carry `text`, optional `marks`, and optional `attrs: { class? }`. `attrs` is view-only derived styling (syntax tokens, spell-check) rendered onto the run's span: it does not serialize, is orthogonal to mark toggling, and blocks run merging so token boundaries survive `normalizeRuns`. Any code re-slicing a run must go through `withRunText(run, text)` (`model/blockText.ts`) so marks *and* attrs ride along.

**Commands and history.** `createEditor.dispatch(cmd)` is the single mutation entry point and returns `boolean` ("did it apply"). It calls `history.record(tag)` *before* applying the command; matching tags coalesce into one undo step (`textCommands` insert/deleteBackward/deleteForward use `text:insert`, `text:deleteBack`, `text:deleteFwd` so consecutive typing collapses, and IME composition reuses `text:insert` so a multi-char composition is one undo). New commands live under `src/commands/<group>Commands.ts` and are wired into the `Command` union and `dispatch` switch in `createEditor.ts` — and into `BUILTIN_COMMANDS` there, which the read-only gate reads.

**Read-only.** `EditorOptions.editable` (`boolean | (() => boolean)`, default true) is honoured in *two* places, because `dispatch()` is public and the attribute alone would not stop a plugin: the root's `contenteditable`, and the dispatcher. Mutating commands return `false` before `history.record`, so no empty undo steps accumulate. Plugin commands are gated inside `Registry.runCommand` and opt back in with `CommandDef.readOnlySafe` (the cells plugin's navigation commands do). Host-level document APIs (`setDoc`, `appendBlocks`, …) are deliberately NOT gated — that's how a read-only viewer loads content.

**Change stream and position mapping** (`model/changes.ts`). Commands emit `DocChange`s into an ambient collector (`recordChange` / `recordTextChange`); `dispatch` opens the collector with `collectChanges` and hands the batch to `editor.onChange` subscribers. Nested dispatches fold into one flat batch and only the outermost emits. `mapAnchor(anchor, changes, bias)` moves an externally-held anchor (review comment, diagnostic, bookmark) through an edit, returning `null` when the position no longer exists. Variants: `text` (with a `container` path so table cells are addressed separately), `split`, `merge`, `insertBlock`, `removeBlock`, `resetBlock` (unmappable internal reshape — table row/col ops), `replaceDoc` (setDoc / undo / redo). A new mutating command must emit, or anchors silently drift.

**Render layer.** `render/DocView.ts` is the keyed reconciler over `doc.order`. Block immutability + identity-based `shouldUpdate` makes per-keystroke render cost O(1) blocks — only the touched block re-renders. `CodeBlockView` extends the same trick *inside* a block: it memoizes its per-line run split against the previous one and hands back the previous line's array reference wherever the line is unchanged, so `InlineRunsView`/`RunView`'s identity guards skip it. Line keys ride along with that memo (unchanged prefix and suffix keep theirs) rather than being array indices, so inserting a line at the top doesn't renumber everything below it. `render/blocks/` contains one view per block type. Each block element emits `data-block-id` and `data-block-kind` for the anchor map; cells inside `table`/`columns` emit `data-cell="r:c"` / `data-col="c"`. Image blocks emit `contenteditable="false"` so the native caret skips over them.

**Input pipeline** (`input/nativeInput.ts`). `attachNativeInput(root, stores, options)` wires:
- `selectionchange` (document-level) → Anchor → `selStore`
- `selStore` change → native Range, synced post-render via rAF
- `beforeinput` → `preventDefault` + dispatch command (most `inputType`s map directly; `deleteContentBackward`/`deleteContentForward` route through `handleBackspace`/`handleDelete` which choose between within-block delete, block merge, or `deleteSelectedImage`)
- `compositionstart`/`end` → snapshot model length, diff DOM textContent on end, dispatch one `text:insert`
- `keydown` → `matchKeymap` chord → command (Tab routes to `tableNextCell` inside tables, `indentList` outside)
- `copy`/`cut`/`paste` on root → existing `clipboard/` modules (parser, serializer, image-file path)

**Virtualization** (`virtual/`). When `virtualized: true`, `VirtualDoc` mounts only blocks intersecting `[scrollTop − overscan, scrollTop + viewport + overscan]`; `HeightIndex` is a Fenwick tree of measured per-block heights for O(log n) viewport resolution. The host page must provide a scroll container. `editorId` must be passed (createEditor does) — without it the root resolves to "the first editor in the document", which is the wrong one as soon as a page holds two.

**Anything running per edit must be O(mounted), not O(document).** This is the invariant that makes "one block per source line" viable, and it is easy to break because iterating `doc.order` looks harmless. Known instances, all fixed and gated in `src/__perf__/lineBlocks.spec.ts`: `DecorationManager.sync` and `.position` take one `querySelectorAll` and iterate the mounted set (walking `doc.order` with a `querySelector` per block cost ~1.2s per sync at 50 000 blocks, on every keystroke); `attachAutoRebalance` skips its O(n) key scan unless `order` identity changed, which only an insert can do. Two costs remain O(document) by construction: `updateBlock` clones `byId` (0.42 ms at 50 000), and history pins one `DocState` per undo step — bounded by `HISTORY_MAX_BLOCK_SLOTS` rather than fixed, because 250 unbounded steps at 50 000 blocks grew the heap by 926MB. Both dissolve if `byId` becomes a persistent map or history entries become inverse patches.

**Sub-block virtualization** (`plugin/selfVirtualized.ts`). A `BlockDef` may declare `selfVirtualized: { measureHeight }`, meaning the block windows its own internal rows (a 5,000-line code block is one block, so block-level windowing does nothing for it). `VirtualDoc` then excludes it from `ResizeObserver` — matched by `data-block-kind`, tracked in `selfElByBlock` — trusts `measureHeight` even while the block is off-screen so scrollbar geometry is right from frame one, and passes a `BlockViewport { top, bottom }` in the block's own coordinate space down through the view props. The block owns its anchor codec's correctness across its own spacers, which is why the built-in code block does *not* opt in (`codeBlockCodec` walks every mounted `.ce-code-line`).

**Decorations** (`plugin/decorations.ts`). Per-block overlay UI in a sibling layer. `DecorationDef.targets(block, blockEl)` narrows the anchor to sub-elements (code lines → a per-line gutter); omitted, it defaults to `[blockEl]`, i.e. the original behaviour. `slotWidth` sizes the gutter slot; `uniformTargets` promises equal-height contiguous targets so `position()` takes one layout read per (def, block) instead of one per line. `targets()` is memoised per frame.

**Range decorations** (`plugin/rangeDecorations.ts`, `dom/highlights.ts`). `EditorPlugin.rangeDecorations` paints arbitrary, overlapping `AnchorRange`s through the CSS Custom Highlight API — zero DOM mutation, so nothing new for the character walk to account for. There is deliberately **no** DOM fallback; `editor.supportsRangeDecorations()` is the capability flag. `dom/highlights.ts` is the single place that touches `CSS.highlights` (the search plugin goes through it too).

One repaint asks *every* source for its ranges first, then resolves *all* their endpoints in a single `anchorsToDom` batch. Resolving per decoration made the cost scale with how many highlight names a host registers (a tokenizer bucketing into 64 of them hands each a thin scatter over the whole file, so nothing groups by line); pooled, the same endpoints arrive dense and each line is walked once. `editor.refreshRangeDecorations()` schedules on the next frame — `refreshRangeDecorationsSync()` is the escape hatch for callers that must see the paint before returning.

`DecorationViewport.windowIn(blockId)` gives a source the visible half-open character window inside one block, computed from `data-line-start` plus one rect read against the scroll container. `firstBlock`/`lastBlock` say nothing about a document that *is* one block, which is exactly the shape that needs scoping. `null` means "not measurable — return everything".

**Repaint triggers.** Doc store, the scroll container (`dom/scroll.ts` resolves the nearest scrollable ancestor — `scroll` doesn't bubble, so `window` is both deaf to the editor's own pane and noisy about the page's), `resize`, and `dom/mountSignal.ts`. That last one replaced a `MutationObserver` with `subtree: true`, which caught block mount/unmount under virtualization but also fired for every text node the renderer touched while typing. `VirtualDoc` now announces mount-set changes explicitly; a host doing its own windowing calls `notifyMountedBlocksChanged(root)`.

**Inline widgets** (`plugin/inlineWidgets.ts`). `EditorPlugin.inlineWidgets` places non-text content *within* a line (ghost text, inlay hints). A widget must be invisible to three things, each handled in exactly one place: the character-offset walk (`plugin/anchorCodec.ts` skips subtrees carrying `INLINE_WIDGET_ATTR` — a custom codec must too), the IME composition diff (`nativeInput.ts` reads the scope via `visibleTextOf`), and clipboard serialization (free — the serializer works from the model). The manager re-places widgets after each render because the renderer owns block DOM; it listens to doc/sel stores rather than a MutationObserver so it never observes its own writes.

**Clipboard / HTML** (`clipboard/`). `htmlParser.ts` → blocks for paste and `setDocFromHTML`; `htmlSerializer.ts` ← selection for copy/cut. `drop.ts` handles drag-and-drop including image upload via `opts.uploadImage`. The clipboard handlers themselves live in `nativeInput.ts` — the `clipboard/` modules are pure parse/serialize.

**Mobile.** `input/mobile.ts` — coarse-pointer detection (`isCoarsePointer()`) and `visualViewport` tracking. The latter exposes `--creo-vv-height` / `--creo-vv-top` as CSS custom properties so host pages can position floating UI above the soft keyboard, and scrolls the caret into the upper third of visible space when the keyboard opens. Native selection handles, the OS long-press menu, IME, and autocorrect are all delivered by the browser through the `contentEditable` root — no editor-side replacement needed.

**Reading text out.** `editor.toJSON()` is memoized on `docStore` identity (one serialization per document version, however many callers ask). `editor.getText(blockId?)` reads `runs` straight off the model via `blockTextOf` (`model/blockText.ts`) — cells joined by `\t` across and `\n` down, atomic blocks contributing nothing — and counts characters exactly the way anchors do. Hosts that hash the buffer or rebuild line starts every keystroke should use it rather than serializing.

**Perf gates** live in `src/__perf__/codeBlock.spec.ts`: a 2 000-line code block with 64 token decorations at ~6 ranges/line, timed on mount, repaint, keystroke, single-anchor resolution, and a viewport-scoped repaint. They stub `Range` as well as `CSS.highlights` — happy-dom's `setStart` walks the document to validate its boundary point, so one call is O(nodes) and an unstubbed repaint measures happy-dom rather than the editor. Budgets are ~5-10× measured so noise doesn't flake them while a structural regression overshoots by orders of magnitude.

**Public API surface** is `src/index.ts` — anything exported there is part of the package contract; internal helpers should not be re-exported casually.
