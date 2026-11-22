// ---------------------------------------------------------------------------
// creo-edit-mermaid-plugin — Mermaid diagrams as a block.
//
//   import { mermaidPlugin, mermaidSlashItem } from "creo-edit-mermaid-plugin";
//   import "creo-edit-mermaid-plugin/styles.css";
//
//   createEditor({ plugins: [mermaidPlugin()] });
//   editor.dispatch({ t: "mermaid.insert", payload: {} });
//
// One plugin, one block, two modes:
//
//   Diagram — the picture, drawn by Pele. In an editable editor it is also
//             the visual editor: click to select, double-click to rename,
//             + to add a connected node, drag a dot to connect.
//   Code    — the mermaid source in a text field, the picture following it.
//
// A package of its own. `creo-edit` knows nothing about it and depends on
// neither engine: `pele` and `@visimer/core` are THIS package's dependencies,
// installed with it and still loaded on demand (`import()`), so a page with
// no diagram fetches neither. `creo-edit` and `creo` are peers — the host's
// one copy, which is what makes the block register into the registries the
// host's editor reads.
// ---------------------------------------------------------------------------

import type {
  BlockId,
  Editor,
  EditorPlugin,
  SlashItem,
} from "creo-edit";
import { adoptCodeBlocks, mermaidBlockDef } from "./block";
import { mermaidCommands } from "./commands";
import { createRuntime, runtimeOf } from "./runtime";
import type {
  MermaidAction,
  MermaidMode,
  MermaidPluginOptions,
} from "./types";

export function mermaidPlugin(options: MermaidPluginOptions = {}): EditorPlugin {
  const plugin: EditorPlugin = {
    name: "mermaid",
    blocks: [mermaidBlockDef],
    commands: mermaidCommands,
    onInit(editor) {
      const rt = createRuntime(editor, options);
      return () => rt.destroy();
    },
  };
  if (options.adoptCodeBlocks) plugin.deserializeDoc = adoptCodeBlocks;
  return plugin;
}

/**
 * The actions available on a diagram block right now — the mode switch, add,
 * copy, download, and whatever applies to the node or edge selected in it.
 * The block's own bar draws this same list; a host calls it to put the items
 * in its context menu.
 *
 * Empty when the block is not mounted (scrolled out of a virtualized window).
 */
export function mermaidActions(editor: Editor, blockId: BlockId): MermaidAction[] {
  return runtimeOf(editor)?.uis.get(blockId)?.actions() ?? [];
}

export type MermaidController = {
  /** Which mode a block is showing. */
  mode(blockId: BlockId): MermaidMode;
  /** Switch a block between Diagram and Code. Not a document change: nothing
   *  is emitted and nothing is added to undo. */
  setMode(blockId: BlockId, mode: MermaidMode): void;
  /** Load the engine now instead of waiting for the first diagram. */
  preload(): void;
};

/** The plugin's handle on one editor, or null if it is not installed there. */
export function mermaidController(editor: Editor): MermaidController | null {
  const rt = runtimeOf(editor);
  if (!rt) return null;
  return {
    mode: (id) => rt.mode(id),
    setMode: (id, mode) => rt.setMode(id, mode),
    preload: () => rt.preload(),
  };
}

/** Slash-menu / add-block item. Append it to the host's item list. */
export const mermaidSlashItem: SlashItem = {
  id: "mermaid",
  title: "Diagram",
  description: "Flowchart, sequence, and other Mermaid diagrams",
  keywords: ["diagram", "mermaid", "flowchart", "chart", "graph", "sequence", "uml"],
  run: (ctx) => ctx.dispatch({ t: "mermaid.insert", payload: {} }),
};

export { mermaidBlockDef, adoptCodeBlocks, isMermaidBlock, mermaidSpec } from "./block";
export { MermaidView } from "./view";
export { defaultMermaidTemplates } from "./templates";
export { createPeleEngine, loadPeleEngine } from "./engine";
export { EDITABLE_TYPES as MERMAID_VISUAL_TYPES } from "./kits";
export { MERMAID_TYPE } from "./types";
export type {
  EngineHooks,
  EngineMounted,
  MermaidAction,
  MermaidBlock,
  MermaidDiagnostic,
  MermaidEngine,
  MermaidLabels,
  MermaidMode,
  MermaidPluginOptions,
  MermaidTemplate,
} from "./types";
export type { MermaidInsertPayload } from "./commands";
