# Changelog

All notable changes to `creo-edit` are documented here. This project follows
[semantic versioning](https://semver.org/); while the major version is `0`,
minor bumps carry new features and may include small, documented behaviour
changes.

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
