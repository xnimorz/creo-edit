// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Editor factory
export { createEditor } from "./createEditor";
export type {
  Editor,
  EditorOptions,
  EditorViewProps,
  Command,
  DispatchableCommand,
  BlockInsertInput,
  SerializedBlock,
  SerializedDoc,
  SerializedRun,
  EditorMode,
  SetDocOptions,
  UnknownBlockPolicy,
  // The sanctioned wire shape for a plugin-introduced block type. Cast
  // through it when building `SerializedDoc.blocks` for a type outside the
  // built-in union — the runtime codec registry dispatches on `type` and
  // carries the extra fields through untouched.
  ExternalSerializedBlock,
} from "./createEditor";

// ---------------------------------------------------------------------------
// Selection & navigation
//
// Anchor construction, comparison and clamping. `clampSelection` is what a
// host applies after writing into the document from outside (a remote patch,
// an agent) so the caret lands somewhere that still exists.
// ---------------------------------------------------------------------------

export {
  caret,
  caretAt,
  range as selectionRange,
  anchorOffset,
  withCharOffset,
  isCaret,
  selectionStart,
  selectionEnd,
  compareAnchors,
  orderedRange,
  clampAnchor,
  clampSelection,
  endOfDoc,
} from "./controller/selection";

export {
  nextAnchor,
  prevAnchor,
  homeOfBlock,
  endOfBlock,
  homeOfDoc,
  endOfDocAnchor,
  blockAbove,
  blockBelow,
  nextWord,
  prevWord,
} from "./controller/navigation";

// Render layer (advanced consumers)
export { DocView } from "./render/DocView";
export { ParagraphView } from "./render/blocks/ParagraphView";
export { HeadingView } from "./render/blocks/HeadingView";
export { ListItemView } from "./render/blocks/ListItemView";
export { CodeBlockView } from "./render/blocks/CodeBlockView";
export { TableViewPlugin as TableView } from "./plugins/cells/views";
export { ColumnsViewPlugin as ColumnsView } from "./plugins/cells/views";
export { ImageView } from "./render/blocks/ImageView";
export { InlineRunsView } from "./render/InlineRunsView";

// Mobile / input helpers
export { isCoarsePointer } from "./input/mobile";

// DOM ↔ Anchor mapping (advanced consumers)
export {
  domToAnchor,
  anchorToDom,
  // Batch form — resolves many anchors in one pass, grouping by block and
  // (for code blocks) by line. What the range-decoration repaint uses; worth
  // reaching for in any host that resolves anchors by the thousand.
  anchorsToDom,
  findBlockElementById,
} from "./dom/anchorMap";

// A host rendering its own code-block view should publish each line's model
// start offset under this attribute — that is what turns anchor resolution
// from "walk every line" into a binary search. Omitting it stays correct.
export { LINE_START_ATTR } from "./plugin/anchorCodec";

// Overlay managers repaint when the mounted block set changes. A host that
// does its own windowing (instead of `virtualized: true`) should say so.
export {
  onMountedBlocksChanged,
  notifyMountedBlocksChanged,
} from "./dom/mountSignal";

// Virtualization
export { VirtualDoc } from "./virtual/VirtualDoc";
export { HeightIndex } from "./virtual/heightIndex";

// Model
// Mark helpers — marks are a `ReadonlyMap<MarkName, MarkAttrs>`, so reach for
// these rather than treating the map as a set of strings.
export {
  NO_MARKS,
  marksOf,
  hasMark,
  markAttrs,
  linkHref,
  withMark,
  withoutMark,
  marksEqual,
} from "./model/marks";
export { serializeRun, deserializeRun } from "./model/runSerialize";

// Mark registry — rendering / HTML / markdown for a mark name. The six
// built-ins (b, i, u, s, code, link) are pre-registered.
export {
  registerMark,
  getMarkDef,
  orderedMarkDefs,
  markDefForTag,
  safeHref,
} from "./plugin/markRegistry";

// Text-bearing registry — mirrors `BlockDef.isTextBearing`. `isTextBearing`
// is what `splitBlock` / `mergeBackward` / `setBlockType` / `toggleMark` gate
// on, so a plugin block that wants Enter to work must be registered here
// (declaring the flag on its `BlockDef` does it).
export { isTextBearing, blockTextOf, runsText, runsLength } from "./model/blockText";
export { isTextBearingType, registerTextBearing } from "./plugin/textBearing";

export type {
  Block,
  BlockId,
  BlockSpec,
  BlockType,
  CodeBlock,
  ColumnsBlock,
  DistOmit,
  DocState,
  FracIndex,
  HeadingBlock,
  HeadingLevel,
  ImageBlock,
  InlineRun,
  LinkAttrs,
  ListItemBlock,
  Mark,
  MarkAttrs,
  MarkName,
  MarkSet,
  ParagraphBlock,
  RunAttrs,
  TableBlock,
  Anchor,
  AnchorRange,
  Selection,
} from "./model/types";

// Position mapping — move an externally-held Anchor (review comment, LSP
// diagnostic, bookmark) through an edit. Subscribe via `editor.onChange`.
export { mapAnchor } from "./model/changes";
export type {
  DocChange,
  TextChange,
  SplitChange,
  MergeChange,
  InsertBlockChange,
  RemoveBlockChange,
  ResetBlockChange,
  MoveBlockChange,
  FormatChange,
  BlockAttrsChange,
  ReplaceDocChange,
  MapBias,
} from "./model/changes";

export {
  emptyDoc,
  docFromBlocks,
  insertAt,
  insertAfter,
  insertWithIndex,
  insertManyAt,
  updateBlock,
  removeBlock,
  findInsertionPos,
  findPos,
  blockAt,
  getBlock,
  iterBlocks,
  newBlockId,
  maybeRebalance,
} from "./model/doc";

export {
  generateBetween,
  generateN,
  needsRebalance,
  rebalance,
  REBALANCE_THRESHOLD,
} from "./model/fractional";

// ---------------------------------------------------------------------------
// Plugin system
// ---------------------------------------------------------------------------

export type {
  EditorPlugin,
  BlockDef,
  CommandDef,
  KeymapDef,
  TriggerDef,
  TriggerCtx,
  TriggerController,
  DecorationDef,
  DecorationHandle,
  DecorationViewport,
  RangeDecorationDef,
  InlineWidgetDef,
  InlineWidgetPlacement,
  BlockViewport,
  SelfVirtualizedDef,
  SelfVirtualizedProps,
  AnchorCodec,
  HtmlBlockCodec,
  HtmlParseCtx,
  SerializeCodec,
  RunsCtx,
  CommandCtx,
  DomPoint,
} from "./plugin/types";

// NOTE: block, codec, view and mark registries are module-GLOBAL, keyed by
// type/mark name. Registration is additive and last-write-wins, so two
// editors on one page share them — which is what makes "register the table
// codec once" work, and what means two differing implementations registered
// for the SAME type collide. Namespace plugin block types and mark names.
export { Registry } from "./plugin/registry";
export {
  registerUnknownBlockType,
  isOpaqueBlock,
  OPAQUE_PAYLOAD,
} from "./plugin/unknownBlock";
export { registerMarkdownCodec, getMarkdownCodec } from "./markdown/blockCodec";
export type { MarkdownBlockCodec } from "./markdown/blockCodec";
export type { MarkDef } from "./plugin/markRegistry";
export type { PasteCtx, SerializedDocLike } from "./plugin/types";

// The editor handle published on the DOM root. A decoration or block view
// receives an element and no editor argument — this is how it reaches one.
export {
  closestEditor,
  getEditorRef,
  setEditorRef,
  EDITOR_REF_KEY,
  EDITOR_ROOT_ATTR,
} from "./dom/editorRef";
export {
  defaultPlugins,
  paragraphPlugin,
  headingPlugin,
  listPlugin,
  codeBlockPlugin,
  imagePlugin,
  cellsPlugin,
} from "./plugin/builtin";
export { runsAt, runsLengthAt } from "./plugin/runsAt";
export {
  atomicCodec,
  defaultTextCodec,
  codeBlockCodec,
  imageCodec,
} from "./plugin/anchorCodec";
export { isAtomicBlockType, registerAtomic } from "./plugin/atomic";
export { TriggerManager } from "./plugin/triggers";
export { DecorationManager } from "./plugin/decorations";
export { RangeDecorationManager } from "./plugin/rangeDecorations";
export {
  InlineWidgetManager,
} from "./plugin/inlineWidgets";
// The attribute an inline widget's root carries. Custom anchor codecs MUST
// skip subtrees marked with it, or widgets shift every anchor after them.
export { INLINE_WIDGET_ATTR, visibleTextOf } from "./plugin/anchorCodec";
export {
  registerSelfVirtualized,
  getSelfVirtualized,
  isSelfVirtualized,
} from "./plugin/selfVirtualized";
// Range decorations are painted with the CSS Custom Highlight API; there is
// no DOM fallback (see `editor.supportsRangeDecorations`).
export { isHighlightApiSupported } from "./dom/highlights";

// Slash commands plugin
export {
  slashCommandsPlugin,
  defaultSlashItems,
  defaultFilter as defaultSlashFilter,
  mountSlashMenu,
  type SlashItem,
  type MenuHandle as SlashMenuHandle,
  type MenuOptions as SlashMenuOptions,
} from "./plugins/slash";

// Decoration plugins
export { dragHandlePlugin, type DragHandleOptions } from "./plugins/drag-handle";
export { addBlockPlugin, type AddBlockOptions } from "./plugins/add-block";

// Markdown shortcut input rules — typing `# `, `**foo**`, `- `, etc.
// auto-applies the matching block type or mark.
export {
  mdShortcutsPlugin,
  defaultBlockRules as mdDefaultBlockRules,
  defaultInlineRules as mdDefaultInlineRules,
  type MdShortcutsOptions,
  type BlockRule as MdBlockRule,
  type InlineRule as MdInlineRule,
} from "./plugins/md-shortcuts";

// Calendar plugin — example non-editable atomic block.
export {
  calendarPlugin,
  calendarSlashItem,
  CalendarView,
  DateMarkerView,
  calendarHelpers,
} from "./plugins/calendar";

// Infinite-scroll plugin — append/prepend blocks as the user scrolls.
export {
  infiniteScrollPlugin,
  type InfiniteScrollEditor,
  type InfiniteScrollOptions,
} from "./plugins/infinite-scroll";

// Search plugin — in-page find with optional Mod+F intercept; supports
// virtualization and infinite-scroll backends.
export {
  searchPlugin,
  type SearchOptions,
  type SearchController,
  type SearchSource,
  type SearchState,
  type SearchToggle,
  type SearchMatch,
  type SearchOpts,
} from "./plugins/search";

// Markdown serializer — turn a SerializedDoc into a markdown string.
// Used by the docs site's MD-mode raw-source view; useful in apps that
// want a "save as .md" button.
export { docToMarkdown } from "./markdown/serialize";
