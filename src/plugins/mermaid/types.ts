// ---------------------------------------------------------------------------
// Mermaid plugin — public types.
//
// Everything here is plain data or a structural interface, so nothing about
// the rendering engine (Pele) or the source rewriter (visimer) leaks into the
// plugin's public surface: a host without either installed can still import
// these types.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { BlockId, FracIndex } from "../../index";

/** The diagram block as it lives in the document. One attribute. */
export type MermaidBlock = {
  id: BlockId;
  index: FracIndex;
  type: "mermaid";
  /** Mermaid source text — the single source of truth for the diagram. */
  source: string;
};

/** The block's type discriminator. */
export const MERMAID_TYPE = "mermaid";

/**
 * Which side of the block is showing. `diagram` is the picture (and, in an
 * editable editor, the visual editor); `code` is the source in a text field
 * with the picture underneath. View state — never written to the document.
 */
export type MermaidMode = "diagram" | "code";

/** Where an engine or a parse check says the source is wrong. */
export type MermaidDiagnostic = {
  message: string;
  /** 1-based, when the engine knows. */
  line?: number;
  column?: number;
};

// ---------------------------------------------------------------------------
// Engine — what draws the diagram.
// ---------------------------------------------------------------------------

export type EngineHooks = {
  /** A drawing is in the element (again, after a resize or a font load). */
  onRender(info: { type: string | null; width: number; height: number }): void;
  /** The source could not be drawn. The last good drawing, if any, stays. */
  onError(error: MermaidDiagnostic): void;
};

export type EngineMounted = {
  /** Draw other source in the same element. */
  update(source: string): void;
  /** Redraw if the element's width or fonts changed. */
  refresh(): void;
  destroy(): void;
};

/**
 * The seam between the block and whatever renders it. The default
 * implementation wraps Pele; a host can supply another (`options.engine`).
 *
 * `mount` must be synchronous when the diagram type's code is already
 * loaded: a block scrolled back into a virtualized window has to have its
 * real height the first time it is measured.
 */
export type MermaidEngine = {
  mount(el: HTMLElement, source: string, hooks: EngineHooks): EngineMounted;
  /**
   * Parse without drawing. `null` when the source is fine, or when the engine
   * cannot tell yet (the diagram type's code has not loaded). Used to refuse
   * a visual edit that would leave the diagram broken.
   */
  check(source: string): MermaidDiagnostic | null;
  /** Fetch ahead of time whatever drawing `types` will need. */
  preload?(types?: readonly string[]): Promise<void>;
};

// ---------------------------------------------------------------------------
// Actions — one list, drawn in the block's bar and offered to host menus.
// ---------------------------------------------------------------------------

export type MermaidAction = {
  /** Stable id: "mode", "add", "direction", "copy", "download", "edit",
   *  "shape", "line", "reverse", "delete". */
  key: string;
  /** `block` actions always apply; `entity` ones act on what is selected in
   *  the diagram. */
  scope: "block" | "entity";
  label: string;
  /** Inline SVG markup. */
  icon: string;
  /** Pressed (the mode switch while Code is showing). */
  on?: boolean;
  disabled?: boolean;
  /** Sub-choices (a node's shapes). Drawn as a second row in the default UI. */
  choices?: readonly { key: string; label: string; icon: string; on?: boolean; run(): void }[];
  run(): void;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MermaidTemplate = {
  id: string;
  title: string;
  source: string;
};

export type MermaidLabels = {
  diagram: string;
  code: string;
  copy: string;
  copied: string;
  download: string;
  direction: string;
  edit: string;
  shape: string;
  line: string;
  reverse: string;
  delete: string;
  emptyTitle: string;
  emptyHint: string;
  sourceLabel: string;
  hint: string;
  rejected: string;
};

export type MermaidPluginOptions = {
  /** Replace the renderer. Default: Pele, loaded with `import("pele/lazy")`. */
  engine?: () => Promise<MermaidEngine>;
  /**
   * Warm the engine up before the first diagram needs it. `"idle"` (default)
   * waits for the browser to be idle, `"eager"` starts at once, `false`
   * leaves it to first use.
   */
  preload?: "idle" | "eager" | false;
  /** Diagram types to warm up. Default `["flowchart", "sequence"]`. */
  preloadTypes?: readonly string[];
  /** Offer the Code mode and the switch. Default true. */
  code?: boolean;
  /** Allow edits on the diagram itself. Default true. */
  visualEditing?: boolean;
  /**
   * Which mode each block shows. Pass a store to own (and persist, or drive)
   * the choice; omitted, the plugin keeps one per editor and every block
   * starts in `diagram`.
   */
  modes?: Store<ReadonlyMap<BlockId, MermaidMode>>;
  /** Draw the default bar on the block. `false` = the host draws
   *  `mermaidActions()` itself. Default true. */
  bar?: boolean;
  /** Rewrite `code` blocks whose `lang` is "mermaid" into diagram blocks when
   *  a document is loaded. Default false. */
  adoptCodeBlocks?: boolean;
  /** Let diagrams contain working links / load external images.
   *  Default false for both. */
  links?: boolean;
  images?: boolean;
  /** Starter diagrams offered in an empty block. */
  templates?: readonly MermaidTemplate[];
  labels?: Partial<MermaidLabels>;
};
