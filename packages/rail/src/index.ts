// ---------------------------------------------------------------------------
// creo-edit-rail-plugin — a rail of ticks beside the document, one per point
// the host picks, to see where you are and jump.
//
//   import { railPlugin, headingPoints } from "creo-edit-rail-plugin";
//   import "creo-edit-rail-plugin/styles.css";
//
//   createEditor({ plugins: [railPlugin({ points: headingPoints() })] });
//
// What a point is belongs to the host: a document's headings, a chat's user
// messages, a review's comments. `points(doc, editor)` returns them, each a
// block id with a label, an optional detail for the hover card, and a size
// for how far its tick reaches.
// ---------------------------------------------------------------------------

import type { Editor, EditorPlugin } from "creo-edit";
import { createRuntime, runtimeOf } from "./rail";
import type { RailController, RailPluginOptions } from "./types";

export function railPlugin(options: RailPluginOptions): EditorPlugin {
  return {
    name: "rail",
    // Kept by editor, not here: one plugin object may be given to several.
    onInit(editor) {
      const runtime = createRuntime(editor, options);
      return () => runtime.destroy();
    },
    onMount(root, editor) {
      return runtimeOf(editor)?.mount(root);
    },
  };
}

/** The plugin's handle on one editor, or null if it is not installed there. */
export function railController(editor: Editor): RailController | null {
  return runtimeOf(editor)?.controller ?? null;
}

export { headingPoints, type HeadingPointsOptions } from "./points";
export type { RailController, RailPluginOptions, RailPoint } from "./types";
