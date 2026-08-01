# Changelog

All notable changes to `creo-edit` are documented here. This project follows
[semantic versioning](https://semver.org/); while the major version is `0`,
minor bumps carry new features and may include small, documented behaviour
changes.

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
