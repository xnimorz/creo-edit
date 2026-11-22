# Changelog

All notable changes to `creo-edit` are documented here. This project follows
[semantic versioning](https://semver.org/); while the major version is `0`,
minor bumps carry new features and may include small, documented behaviour
changes.

## 0.7.0

Markdown's tables, quotes and rules, for a host drawing what a model wrote.
No breaking API changes; one small behaviour change (key bindings during an
IME composition), described under Editor.

### Tables

- **Column alignment.** `TableBlock.align?: TableAlign[]` — `"left"`,
  `"center"`, `"right"` or `null` per column. Written to markdown's
  delimiter row (`:---`, `:---:`, `---:`) and to HTML as `text-align`, read
  back from `<td align>` / `text-align`, drawn as `text-align` and
  `data-align` on the cells, and carried through `table.insertCol` /
  `table.removeCol`. `table.setAlign` sets it (`{ align, blockId?, col? }`;
  the caret's column by default). A table with no aligned column has no
  `align` key, so existing documents serialize unchanged.
- `tableAlignAt(block, col)` reads one column's alignment.

### Search

- **`textSlotsOf(block)`** (new export): every run of text in a block with
  the anchor path that addresses it — `[]` for a text block, `[row, col]`
  for a table cell, `[col]` for a column. `searchPlugin` already looked in
  cells; this is the same walk, public, for hosts that run their own find.
  `blockTextOf` joins a table's cells into one string whose offsets no
  anchor can use; a slot's offsets are the anchor model's.

### Opt-in block plugins

- **`blockquotePlugin()`** — `{ type: "blockquote", runs }`, a text-bearing
  quoted line. Enter continues the quote and ends it on an empty line;
  Backspace at a line's start unquotes it; `> ` at the start of a paragraph
  quotes it. Markdown `> text`, HTML `<blockquote>`. Commands
  `blockquote.toggle`, `blockquote.enter`, `blockquote.unquote`; slash item
  `blockquoteSlashItem`.
- **`horizontalRulePlugin()`** — `{ type: "hr" }`, an atomic thematic
  break. `---` typed as the whole of a line becomes one. Markdown `---`,
  HTML `<hr>`. Commands `hr.insert`, `hr.fromParagraph`; slash item
  `horizontalRuleSlashItem`.
- Neither is in `defaultPlugins`: an editor gets them by installing them.
  `plugins/styles.css` has their default look.

### Editor

- **Behaviour change: no key binding runs while an IME composition holds
  the key.** The Enter that confirms a composition, or the arrows that pick
  a candidate, were matched as chords — a plugin's Enter binding (a host's
  "Enter sends") fired mid-word. `keydown` now returns early when
  `isComposing` is set or the key reports 229.
- **`setBlockType` accepts a plugin's text-bearing type.** It refused
  anything outside the built-in union, so a plugin text block could be
  turned into but never reached from a paragraph.

## 0.6.0

Three changes that let a plugin put its own controls inside a block. No
breaking API changes; two small behaviour changes, both described below.

They were made for [`creo-edit-mermaid-plugin`](https://github.com/xnimorz/creo-editor/tree/main/packages/mermaid), a
diagram block that lives in this repository as **a package of its own**:
`creo-edit` does not depend on it, or on anything it uses.

### Editor

- **`isolateInput(node)`** (new export). A form control rendered inside a
  block sits under the editor's root, which cancels every `beforeinput` it
  sees — so the control's typing was swallowed unless it stopped its own
  events first. This is that helper. cront.app has carried its own copy for
  the fields in its cards.
- **Behaviour change: plugin HTML parsers are asked before built-in ones.**
  Parsers claiming the same tag were tried in registration order, and the
  built-in `<pre>` parser never declines — so a plugin could not claim one
  kind of `<pre>`. They are now tried newest first, the same last-write-wins
  rule the view and command registries follow. A plugin parser that returns
  `null` for elements it does not own (as the documented contract says) is
  unaffected.
- **Behaviour change: the editor no longer writes the page's selection while
  the focus is on a control inside one of its blocks.** Doing so moved the
  focus to the editing host, out of the control — after a command dispatched
  *from* such a control, the next keystroke went to the document. The model
  selection is unchanged, and the browser reports a fresh one as soon as the
  user clicks or tabs back into the text.

## 0.5.0

Virtualization rebuilt for a real host, the root's attributes stop
restyling the whole document, and the `spellcheck` option works. No breaking
API changes. The one behaviour change: `spellcheck: true` now does what it
says (see below).

### Virtualization, made fit for a host with real documents

`VirtualDoc` was correct for a page of bare paragraphs at the top of its
scroller. In a host (cront.app: 2 300 blocks with margins, cards holding
editors of their own, folded sections, numbered lists) it windowed the wrong
blocks, dropped the caret, and could not be turned on.

- **Heights are advances, kept by block id.** A block's height is the
  distance to the top of whatever is laid out after it — its margins and the
  gaps between blocks counted — read in one pass over the mounted blocks. The
  index is rebuilt from the heights kept by id when blocks are added, removed
  or reordered (`HeightIndex.from`, O(n)), so no measurement is ever attached
  to a neighbour. Before, a block's own box was summed and the index drifted
  from the page by the margins of every block above.
- **The window is placed from where the editor is** in its scroller, not from
  the scroller's `scrollTop`: an editor under a header, or nested in a block
  of another editor, windows correctly. Only the editor's own blocks are
  measured — an editor nested in one of them has its own.
- **Pins.** While the editor has the focus, the blocks of the selection's
  end points (with the focus block's neighbours), the block holding the
  focused element, and a block `scrollToBlock` is going to stay mounted
  wherever the page is scrolled. Unmounting the caret's block dropped the
  browser's selection; the next key acted somewhere else.
- **`virtualHidden`** — a store of block ids not drawn and taking no height
  (a host's folded sections). Hidden with CSS, a run of 2 000 zero-height
  blocks was mounted whole the moment the window reached it.
- **Lists are grouped** in `<ul>` / `<ol class="ce-list">` as `DocView`
  groups them, keyed by the run's first block in the document, so the list
  stays one element while the window moves along it.
- **`virtualSpacerStyle(doc, nextIndex)`** — extra style for a spacer, for
  CSS a host carries from block to block (list counters).
- **`virtualEstimateHeight(block)`**, **`virtualOverscan`**, and
  **`virtualized` as a thunk** (read at every render of the root: window only
  the documents long enough to need it).
- **Scroll anchoring is its own.** The first visible block is put back where
  it was when something above it changes size; the browser's anchoring is off
  inside the window (`overflow-anchor: none`), so the two never both correct,
  and browsers without it behave the same.
- A scroll inside the mounted slack renders nothing; `scrollToBlock` to a
  block not mounted lands on it exactly once it is; the scroll and resize
  listeners are removed on dispose (they leaked).
- The page's selection is put on a block the virtualizer mounts later (a
  selection set from outside onto a block not mounted yet).
- For hosts mounting `VirtualDoc` themselves: the same options are its
  `estimateHeight`, `hidden` and `spacerStyle` props. `HeightIndex` gains
  `from(heights, estimatedHeight)` and `heightAt(i)`.

### The root's `contenteditable`

Rendered on the root before its blocks exist, written again only when it
changes, and not removed from a root that leaves the page with its editor.
`contenteditable` is inherited: each write restyled every node under the
root — about 200 ms on mount and 135 ms on teardown for a document of 46 000
nodes — and `focusin` / `pointerdown` re-wrote it every time.

### `spellcheck` is honoured

`EditorOptions.spellcheck: true` now turns the browser's spellcheck on. It
never did: the option was written to the root and then forced back to
`"false"` a line later. Off by default, as documented. **A host that passed
`true` gets spellcheck now.**

## 0.4.2

### Fixed

**Mobile: the editor no longer scrolls the page unprompted.** Keeping the
caret above the soft keyboard now happens only for the focused, editable
editor, only when the visual viewport shrinks, and only if the caret was
visible before. It used to also run on mount, on every `visualViewport`
scroll, and for unfocused and read-only editors. It now measures the caret
instead of its block, scrolls the minimum distance, and only scrolls an
ancestor that overflows vertically, stopping at `overflow: hidden` clips.
`--creo-vv-*` are written only when they change.

**iOS autocorrect and QuickType suggestions.** `insertReplacementText` now
reads its text from `dataTransfer` when `data` is null, as it is in a
contenteditable. Previously the edit was cancelled and nothing was inserted.

### Added

`EditorOptions.keepCaretVisible` (default `true`). Set to `false` to leave
keyboard scrolling to the browser.

## 0.4.1

### Fixed

**Pasted and dropped images now insert through `dispatch`.** After the upload
resolved, the image was written straight into `docStore`, so the insert:

- had no undo step;
- emitted no `DocChange`, so anything persisting off `editor.onChange` lost
  the image;
- skipped the read-only check (on paste there was none at all);
- could write into an editor destroyed during the upload.

It now dispatches `insertImage` when the upload finishes, so history, the
change stream and the read-only gate apply as they stand at that moment. A
handler torn down mid-upload inserts nothing. A rejected `uploadImage` is
logged (`creo-edit: image upload failed for "<name>"`) instead of surfacing as
an unhandled rejection, and the remaining files in the batch still insert.

## 0.4.0

Plugin blocks become first-class, marks learn to carry data, and the change
stream becomes a complete op log. One breaking change, on the wire format for
marks — with a read-compatibility path, so existing documents load unchanged.

### Breaking

**`InlineRun.marks` is a `ReadonlyMap<MarkName, MarkAttrs>`**, not a
`ReadonlySet<Mark>`. A mark is now a name plus optional attrs, because a set of
strings has nowhere to put a link's href and encoding one into the key makes
every lookup a scan.

```ts
// before
{ text: "docs", marks: new Set(["b"]) }
// after
{ text: "docs", marks: new Map([["b", null], ["link", { href: "https://x.dev" }]]) }
```

`SerializedRun.marks` follows: `{ b: null, link: { href } }` on write. **The
legacy `string[]` form is still accepted on read**, so documents saved by
0.3.x load without migration; `toJSON()` re-emits them in the object form.

Reach for the helpers in `model/marks` (`hasMark`, `markAttrs`, `withMark`,
`marksOf`, `marksEqual`, `linkHref`) rather than treating the map as a set.
`Mark` remains exported as an alias of `MarkName`.

### Added

**A `link` mark.** `dispatch({ t: "toggleMark", mark: "link", attrs: { href } })`
applies it; re-applying with a *different* href retargets rather than clearing
(what a link dialog's "apply" wants), and `{ t: "removeMark", mark: "link" }` is
the unconditional unlink. It renders as `<a href>`, survives HTML copy/paste,
and serializes to `[text](href)` in markdown. `javascript:` and other unsafe
schemes are neutralised at the DOM boundary only — the model hands your href
back to you untouched.

**A mark registry.** `EditorPlugin.marks: MarkDef[]` defines a mark's wrapping
tag, its DOM attrs, the HTML tags that parse into it, its markdown syntax and
its nesting order. The six built-ins are pre-registered. Rendering, the HTML
parser, the HTML serializer and the markdown serializer all walk this registry
now — they used to carry three separate hard-coded copies of a five-mark table.

**`BlockDef.isTextBearing` is finally read.** It was collected and ignored, so
`isTextBearing()` consulted a hard-coded list of the nine built-ins and
`splitBlock` / `mergeBackward` / `setBlockType` / `toggleMark` all refused
plugin text blocks — Enter inside a plugin `task` block did nothing. The flag
now mirrors into a registry (`plugin/textBearing`), inferred when omitted:
atomic blocks are never text-bearing, a block shipping its own `runsAt`
addresses nested slots, everything else is assumed to carry `runs`.

**Targeted document updates.** `moveBlock`, `insertBlocks`, `removeBlocks` and
`replaceBlocks` are dispatchable commands. They preserve every untouched
block's identity, keep the caret and the undo stack, and emit per-block
`DocChange`s — none of which `setDoc` can do. This is the path for changes
arriving from outside on the same document (a sync engine, an agent, a
collaborator).

**`setDoc(doc, { preserveSelection, preserveHistory })`.** Both default to the
previous behaviour (reset to end-of-doc, clear history).

**Unknown block types are preserved.** A block whose type has no registered
codec used to be dropped silently — a document saved with a plugin and opened
without it lost those blocks, permanently on the next save. It is now kept as
an opaque, non-editable block that round-trips its original JSON exactly.
`EditorOptions.unknownBlocks` selects `"preserve"` (default), `"drop"` (the old
behaviour) or `"throw"`.

**Plugin lifecycle and hooks.** `EditorPlugin.onInit(editor)` (runs after every
plugin is installed, may return a teardown), `onDestroy(editor)`,
`onPaste(ctx)` (first hook returning `true` claims the event, with the HTML,
plain-text and file flavours already read), and `serializeDoc` / `deserializeDoc`
for document-level metadata. `editor.destroy()` tears the whole thing down.

**`CommandCtx` carries `dispatch`, `change` and `editor`**, not just the two
stores. A plugin command can compose with built-ins instead of reimplementing
them, and `ctx.change()` is how a command that mutates the stores directly gets
onto the change stream. `editor.commandCtx` exposes the same object to toolbar
buttons and menu items.

**A typed editor handle.** `dom/editorRef` — `closestEditor(node)`,
`getEditorRef(el)`, `setEditorRef` — replaces the untyped `any` stashed on
`root.__creoEdit` and re-declared with a hand-rolled structural type at each of
the four call sites. The property name is unchanged.

**`mdShortcutsPlugin(options)`.** `blockRules`, `inlineRules` and `disable`,
with `mdDefaultBlockRules` / `mdDefaultInlineRules` exported to extend or
filter. Extending it no longer means shipping a second plugin beside it.

**`BlockDef.markdownCodec`.** `docToMarkdown`'s switch is exhaustive over the
closed built-in union, so a plugin block serialized to nothing; a registered
codec now runs first.

**`EditorOptions.spellcheck`.** Off by default (the browser's squiggles fight
with range decorations on a code view); prose editors want it on.

**Selection and navigation helpers are exported**: `caret`, `caretAt`,
`clampAnchor`, `clampSelection`, `endOfDoc`, `compareAnchors`, `orderedRange`,
`anchorOffset`, `withCharOffset`, `isCaret`, `selectionStart`, `selectionEnd`,
plus all of `controller/navigation`. `clampSelection` is what repairs the caret
after a write from outside. `ExternalSerializedBlock` is exported too.

### Fixed

**`onChange` missed the shipped plugins' edits.** `dragHandlePlugin`'s reorder
and side-drop and `addBlockPlugin`'s insert-above wrote to `docStore` directly:
no `DocChange`, so any consumer persisting off the change stream silently
dropped them, and no history entry, so a drag was not undoable. All three now
go through `dispatch`.

**`onChange` is now a complete op log.** New change kinds: `moveBlock`,
`format` (mark toggles) and `blockAttrs` (`setBlockType`, list indent/outdent).
None of them move a character, so `mapAnchor` passes anchors straight through —
they exist for consumers that persist rather than map. `replaceDoc` carries a
`reason` (`"setDoc" | "setDocFromHTML" | "undo" | "redo"`) instead of
collapsing the four callers into one indistinguishable event.

**`historyCoalescePrefixes` was dead code.** It was collected into
`Registry.coalescePrefixes`, `Registry.shouldCoalesce()` existed, and nothing
called it — `createHistory` hard-coded `tag.startsWith("text:")` and never
received the registry. It does now, so a plugin declaring its own prefix gets
the same typing-collapse the built-in text commands get.

**`focus()` / `blur()` / `scrollToBlock()` resolved the root with
`document.querySelector`**, which returns null before mount (so they were
silent no-ops) and cannot cross a shadow boundary at all. The root is captured
at mount instead.

## 0.3.0 — large-file editing performance

Backfilled: this release shipped without a changelog entry. Two related
passes — making a syntax-highlighted code block cheap to repaint, and making a
document of many blocks cheap to edit.

### Code block / range decorations

- `codeBlockCodec` resolves an anchor in O(log lines): `CodeBlockView` publishes
  each line's model start as `data-line-start` and the codec binary-searches it
  instead of walking every line summing lengths. Additive — a host's own code
  view without the attribute still resolves, through the old walk.
- One repaint asks every source for its ranges first, then resolves all
  endpoints in a single batch (`anchorsToDom`, optional
  `AnchorCodec.anchorsToDom`). Per-decoration resolution made cost scale with
  how many highlight names a host registers, not how much text they cover.
- `DecorationViewport.windowIn(blockId)` gives a source the visible character
  window inside one block — `firstBlock` / `lastBlock` say nothing about a
  document that IS one block.
- `refreshRangeDecorations()` coalesces into the next frame;
  `refreshRangeDecorationsSync()` is the escape hatch.
- Character walks no longer allocate an array per node visited.
- `CodeBlockView` memoizes its line split and carries stable per-line keys, so
  a one-character edit re-renders one line rather than the file.

### Per-edit work is now O(mounted), not O(document)

- `DecorationManager.sync` / `.position` iterate the mounted set from one
  `querySelectorAll`. Walking `doc.order` with a `querySelector` per block cost
  ~1.2s per sync at 50 000 blocks, on every keystroke.
- `attachAutoRebalance` skips its O(n) key scan unless `order` identity
  changed, which only an insert can do.
- History depth is bounded by retained block slots as well as entry count: 250
  unbounded steps at 50 000 blocks grew the heap by 926MB.

### Fixed

- Overlay managers listen on the editor's own scroll container. `scroll`
  doesn't bubble, so `window` was deaf to the editor's pane and noisy about the
  page.
- Block mount/unmount arrives as an explicit signal from the renderer
  (`dom/mountSignal.ts`) instead of a subtree `MutationObserver` that fired on
  every keystroke.
- `VirtualDoc` takes `editorId`; it resolved its root as "the first editor in
  the document", so a second editor on a page measured the first one's blocks.

### Added

`getText`, `refreshRangeDecorationsSync`, `anchorsToDom`, `LINE_START_ATTR`,
`onMountedBlocksChanged` / `notifyMountedBlocksChanged`,
`DecorationViewport.windowIn`, `AnchorCodec.anchorsToDom`,
`VirtualDocProps.editorId`. `toJSON` is memoized on document identity.

Perf gates live in `src/__perf__/codeBlock.spec.ts` and `lineBlocks.spec.ts`.
At 50 000 one-line blocks: open 1141ms → 34ms, keystroke 1.56ms. At a
2 000-line code block: mount 8.9s → 53ms, repaint 19.8s → 8ms.

## 0.2.0

Seven additions aimed at hosting a code editor on top of `creo-edit` —
read-only surfaces, per-line gutters, overlapping range highlights, syntax
tokens, position mapping, sub-block virtualization, and inline widgets. All of
them are additive; a `0.1.x` document and plugin set keeps working unchanged.

### Added

**Read-only editors.** `EditorOptions.editable` accepts a boolean or a thunk,
alongside `editor.isEditable()` / `editor.setEditable()`. It is honoured in two
places, not one: the root's `contenteditable` attribute *and* the command
dispatcher — because `dispatch()` is public, so the attribute alone wouldn't
stop a plugin or the host. Plugin commands opt back in with
`CommandDef.readOnlySafe` (the built-in table / columns navigation commands
do). Host-level document APIs (`setDoc`, `appendBlocks`, …) are deliberately
not gated — that's how a read-only viewer loads its content.

**Sub-block decoration targets.** `DecorationDef.targets(block, blockEl)`
anchors decorations to elements *within* a block, so a code block can carry one
decoration per line — line numbers, diff signs, diagnostics, fold arrows.
Omitting `targets` keeps the existing per-block behaviour exactly. Adds
`slotWidth` for gutter sizing and `uniformTargets`, which lets the manager take
one layout read per block instead of one per line.

**Range decorations.** `EditorPlugin.rangeDecorations` paints arbitrary,
overlapping `AnchorRange`s through the CSS Custom Highlight API — zero DOM
mutation, so comment ranges, diagnostic squiggles and word-level diff can
overlap each other and the run structure without splitting spans. Capability is
explicit via `editor.supportsRangeDecorations()`; there is deliberately no
DOM-span fallback, because faking it would be visible to the character-offset
walk.

**Run-level styling.** `InlineRun.attrs.class` renders on the run's span.
View-only by design: it doesn't round-trip through JSON / HTML / markdown, is
orthogonal to mark toggling, and blocks run merging so a syntax-token boundary
survives normalization.

**Position mapping.** `editor.onChange()` emits a `DocChange[]` per dispatch and
`mapAnchor(anchor, changes, bias)` moves an externally-held anchor — a review
comment, an LSP diagnostic, a bookmark — through an edit. Covers text edits
(scoped to a container, so a table cell is addressed separately), splits,
merges, block insert / remove, an explicit `resetBlock` for unmappable internal
reshapes, and `replaceDoc`. The same batches are what LSP incremental sync wants
for `didChange`.

**Sub-block virtualization.** `BlockDef.selfVirtualized` lets a block manage its
own internal windowing — a 5,000-line code block is one block, so block-level
windowing does nothing for it. `VirtualDoc` excludes such blocks from the
`ResizeObserver`, trusts `measureHeight` even while they're off-screen (so
scrollbar geometry is right from the first frame), and passes a `BlockViewport`
down through the view's props.

**Inline widgets.** `EditorPlugin.inlineWidgets` places non-text content
*within* a line — ghost-text completions, LSP inlay hints. A widget is invisible
to the three things that would otherwise break: the character-offset walk (the
anchor codecs skip `data-ce-inline-widget` subtrees), IME composition diffing,
and clipboard serialization.

### Changed

- `editor.dispatch()` now returns `boolean` — whether the command applied.
  Previously `void`; existing call sites are unaffected.
- `editor.undo()` / `redo()` are refused while the editor is read-only.
- Runs that differ only by `attrs` are no longer merged by `normalizeRuns`.

### Fixed

- `endOfDoc()` assumed any unrecognised block type was a table and threw on a
  plugin-registered text-bearing block. It now handles plugin blocks that carry
  top-level `runs`, and falls back to the start of the block otherwise.
- The docs site's stylesheet still targeted the old `.creo-edit-regular` /
  `.creo-edit-mono` mode classes, which stopped matching when the mode flag
  became `"wysiwyg" | "md"`. Both rules had been silently dead.

### Docs

- New live demo — **IDE affordances** — exercising six of the new APIs on one
  document at once.
- `Editor API`, `Block format`, `Authoring plugins` and `Virtualization` pages
  cover the new surface, including the range-mapping subtlety that deleting the
  text *between* two anchors collapses them rather than nulling either.

### Internal

- The example app's Playwright suite was rewritten for the controlled
  `contentEditable` architecture; it had been asserting against a hidden
  `<textarea>`, caret / selection overlays and mobile handles that no longer
  exist. 124 tests now pass across Chromium, WebKit and two mobile profiles.

---

Releases before `0.2.0` predate this changelog.
