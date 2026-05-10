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
} from "./createEditor";

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
  findBlockElementById,
} from "./dom/anchorMap";

// Virtualization
export { VirtualDoc } from "./virtual/VirtualDoc";
export { HeightIndex } from "./virtual/heightIndex";

// Model
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
  ListItemBlock,
  Mark,
  ParagraphBlock,
  TableBlock,
  Anchor,
  Selection,
} from "./model/types";

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
  AnchorCodec,
  HtmlBlockCodec,
  HtmlParseCtx,
  SerializeCodec,
  RunsCtx,
  CommandCtx,
  DomPoint,
} from "./plugin/types";

export { Registry } from "./plugin/registry";
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
export { mdShortcutsPlugin } from "./plugins/md-shortcuts";

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
