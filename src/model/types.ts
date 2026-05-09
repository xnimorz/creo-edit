export type BlockId = string;
export type FracIndex = string;

export type Mark = "b" | "i" | "u" | "s" | "code";

export type InlineRun = {
  text: string;
  marks?: ReadonlySet<Mark>;
};

export type ParagraphBlock = {
  id: BlockId;
  index: FracIndex;
  type: "p";
  runs: InlineRun[];
};

/**
 * Code-block — like a paragraph, but rendered monospaced inside a <pre>.
 * Enter inside the block inserts a newline character (it does NOT split
 * the block) — the editor treats the whole code block as a single
 * multi-line region. `lang` is an optional language hint preserved across
 * markdown / HTML round-trips; the editor itself doesn't syntax-highlight.
 */
export type CodeBlock = {
  id: BlockId;
  index: FracIndex;
  type: "code";
  runs: InlineRun[];
  lang?: string;
};

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type HeadingBlock = {
  id: BlockId;
  index: FracIndex;
  type: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  runs: InlineRun[];
};

export type ListItemBlock = {
  id: BlockId;
  index: FracIndex;
  type: "li";
  ordered: boolean;
  depth: 0 | 1 | 2 | 3;
  runs: InlineRun[];
};

export type ImageBlock = {
  id: BlockId;
  index: FracIndex;
  type: "img";
  src: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type TableBlock = {
  id: BlockId;
  index: FracIndex;
  type: "table";
  rows: number;
  cols: number;
  // cells[r][c] is an inline-runs sequence.
  cells: InlineRun[][][];
};

/**
 * Multi-column layout — N side-by-side columns of inline runs. Internal
 * cursor path = [colIndex, charOffset]. Same model shape as a 1-row
 * table but rendered as flex columns instead of an HTML <table>.
 */
export type ColumnsBlock = {
  id: BlockId;
  index: FracIndex;
  type: "columns";
  cols: number;
  /** cells[c] is the inline-runs sequence for column c. */
  cells: InlineRun[][];
};

/**
 * Calendar — non-editable atomic block. Renders one row per day starting
 * at `date` for `days` consecutive days. Path encoding: `[side]` (0
 * = before, 1 = after) like image. Built as a first-party demo of the
 * `isAtomic` plugin contract — third-party plugins follow the same shape.
 */
export type CalendarBlock = {
  id: BlockId;
  index: FracIndex;
  type: "calendar";
  /** Anchor date in ISO YYYY-MM-DD form. */
  date: string;
  /** Number of consecutive days to render starting at `date`. */
  days: number;
};

/**
 * DateMarker — slim non-editable atomic block. One line, e.g.
 * "Wednesday, 2 Sep." Used to break up a journal-style document into
 * day sections that the user can write between.
 */
export type DateMarkerBlock = {
  id: BlockId;
  index: FracIndex;
  type: "date-marker";
  /** Anchor date in ISO YYYY-MM-DD form. */
  date: string;
};

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | ListItemBlock
  | CodeBlock
  | ImageBlock
  | TableBlock
  | ColumnsBlock
  | CalendarBlock
  | DateMarkerBlock;

export type BlockType = Block["type"];

/**
 * Distributive `Omit` — applies Omit to each member of a union.
 * Plain `Omit<Union, K>` collapses the union into its intersection of fields,
 * which loses the discriminated-union shape.
 */
export type DistOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

/** A block missing its fractional `index` — used by callers that hand the doc
 *  layer un-indexed blocks for insertion. */
export type BlockSpec = DistOmit<Block, "index">;

export type DocState = {
  byId: Map<BlockId, Block>;
  order: BlockId[]; // sorted by Block.index ascending
};

// ---------------------------------------------------------------------------
// Selection / anchor types (used by controller)
// ---------------------------------------------------------------------------

/**
 * Anchor — points to a position inside a block.
 *  - For text-bearing blocks (p / h1..h6 / li): path = [charOffset]
 *  - For tables:                           path = [row, col, charOffset]
 *  - For images:                           path = [side]   side: 0 = before, 1 = after
 */
export type Anchor = {
  blockId: BlockId;
  path: number[];
  offset: number;
};

export type Selection =
  | { kind: "caret"; at: Anchor }
  | { kind: "range"; anchor: Anchor; focus: Anchor };
