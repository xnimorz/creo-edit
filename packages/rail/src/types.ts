import type { BlockId, DocState, Editor } from "creo-edit";

/** One tick on the rail: a block the reader may want to go back to. */
export type RailPoint = {
  blockId: BlockId;
  /** The tick's name: the first line of the hover card, and what a screen reader says. */
  label: string;
  /** Under the label in the card, in a quieter color: what follows the point, say. */
  detail?: string;
  /**
   * How far the tick reaches, from 0 (shortest) to 1 (longest). A heading's
   * level, a message's length. Default 0.5.
   */
  size?: number;
};

export type RailPluginOptions = {
  /**
   * The points, read from the document — which blocks they are is the host's
   * to say: a chat's user messages, a document's headings (`headingPoints()`).
   * Called again after the document changes, at most once a frame.
   */
  points: (doc: DocState, editor: Editor) => RailPoint[];
  /** Fewer points than this and the rail is hidden. Default 2. */
  minPoints?: number;
  /** Which edge of the scroller the rail runs down. Default "left". */
  side?: "left" | "right";
  /**
   * What the document scrolls in. Default: the nearest ancestor of the editor's
   * root that scrolls vertically, else the page.
   */
  scroller?: (root: HTMLElement) => HTMLElement | null;
  /**
   * Where the reader's eye is taken to be, as a share of the scroller's
   * height from its top: the point last above it is lit. Default 0.4. At the
   * end of the scroll the last point in view lights; at the start, the first.
   */
  readingLine?: number;
  /** Room left above a point gone to, in px. Default 16. */
  jumpOffset?: number;
  /** Flash the block gone to. Default true. */
  flash?: boolean;
  /** The rail's accessible name. Default "Jump to". */
  label?: string;
  /** After a jump, for the host's own bookkeeping (a "follow the end" mode to let go of, say). */
  onJump?: (point: RailPoint) => void;
};

export type RailController = {
  /** The points the rail shows now. */
  points(): RailPoint[];
  /** Into `points()`; -1 when the view is above the first. */
  active(): number;
  /** Scroll to a point's block, as a click on its tick does. */
  jump(blockId: BlockId): void;
  /** Read the points again now: for a host whose `points` reads more than the document. */
  refresh(): void;
};
