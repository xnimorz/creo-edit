// ---------------------------------------------------------------------------
// Plugin registry — per-editor state for command / keymap / trigger /
// decoration dispatch.
//
// Block-level codecs (runsAt, anchorCodec, htmlCodec, serializeCodec) live
// in module-global maps in their dedicated files (./runsAt, ./anchorCodec,
// ./htmlCodec, ./serializeCodec). Those are additive and consistent across
// editors — registering "table" once means every editor that mounts a table
// block can find the codec. The Registry instance below holds only the
// stateful per-editor pieces: a CommandRegistry the editor's dispatch calls
// into, a keymap the input pipeline scans, and trigger/decoration lists for
// the M3/M4 managers.
// ---------------------------------------------------------------------------

import { atomicCodec, registerAnchorCodec } from "./anchorCodec";
import { registerAtomic } from "./atomic";
import { registerHtmlBlockCodec } from "./htmlCodec";
import { registerRunsAt } from "./runsAt";
import { registerSerializeCodec } from "./serializeCodec";
import { registerSelfVirtualized } from "./selfVirtualized";
import { registerTextBearing } from "./textBearing";
import { registerMark } from "./markRegistry";
import { registerMarkdownCodec } from "../markdown/blockCodec";
import type {
  CommandCtx,
  CommandDef,
  DecorationDef,
  EditorPlugin,
  InlineWidgetDef,
  KeymapDef,
  RangeDecorationDef,
  TriggerDef,
} from "./types";

export class Registry {
  readonly commands = new Map<string, CommandDef<unknown>>();
  readonly keymap: KeymapDef[] = [];
  readonly triggers: TriggerDef[] = [];
  readonly decorations: DecorationDef[] = [];
  readonly rangeDecorations: RangeDecorationDef[] = [];
  readonly inlineWidgets: InlineWidgetDef[] = [];
  readonly coalescePrefixes = new Set<string>(["text:"]);
  /** Set of all known block type discriminators (for fast existence checks). */
  readonly knownBlockTypes = new Set<string>();
  /**
   * Read-only gate. `createEditor` points this at `editor.isEditable()`; a
   * bare Registry (tests, devtools) defaults to always-editable. Commands
   * that declare `readOnlySafe` bypass it.
   */
  isEditable: () => boolean = () => true;

  install(plugin: EditorPlugin): void {
    if (plugin.blocks) {
      for (const def of plugin.blocks) {
        this.knownBlockTypes.add(def.type);
        if (def.runsAt) registerRunsAt(def.type, def.runsAt as never);
        // Atomic blocks default to the generic atomicCodec when the plugin
        // doesn't ship its own — covers the common case where a plugin just
        // wants "non-editable rectangle".
        if (def.anchorCodec) {
          registerAnchorCodec(def.type, def.anchorCodec);
        } else if (def.isAtomic) {
          registerAnchorCodec(def.type, atomicCodec);
        }
        if (def.isAtomic) registerAtomic(def.type);
        // Mirror the text-bearing flag into the module-global set the text
        // commands gate on. Inference when omitted: atomic blocks never bear
        // text; a block shipping its own `runsAt` addresses nested slots
        // (table cells, columns) rather than a top-level `runs` field;
        // anything else is assumed to carry `runs`, which is the shape a
        // paragraph-like plugin block has.
        registerTextBearing(
          def.type,
          def.isTextBearing ?? (def.isAtomic ? false : !def.runsAt),
        );
        if (def.htmlCodec) registerHtmlBlockCodec(def.type, def.htmlCodec);
        if (def.serializeCodec) registerSerializeCodec(def.type, def.serializeCodec);
        if (def.markdownCodec) registerMarkdownCodec(def.type, def.markdownCodec);
        if (def.selfVirtualized) {
          registerSelfVirtualized(def.type, def.selfVirtualized as never);
        }
        // Note: view registration lives in viewRegistry (./viewRegistry).
        // We import-and-call there too so the renderer can resolve by type.
        registerView(def.type, def.view as never);
      }
    }
    if (plugin.marks) {
      for (const m of plugin.marks) registerMark(m);
    }
    if (plugin.commands) {
      for (const c of plugin.commands) this.commands.set(c.t, c);
    }
    if (plugin.keymap) this.keymap.push(...plugin.keymap);
    if (plugin.triggers) this.triggers.push(...plugin.triggers);
    if (plugin.decorations) this.decorations.push(...plugin.decorations);
    if (plugin.rangeDecorations) {
      this.rangeDecorations.push(...plugin.rangeDecorations);
    }
    if (plugin.inlineWidgets) this.inlineWidgets.push(...plugin.inlineWidgets);
    if (plugin.historyCoalescePrefixes) {
      for (const p of plugin.historyCoalescePrefixes) this.coalescePrefixes.add(p);
    }
  }

  /**
   * Look up a command by t and run it; returns false if the command is
   * unknown OR if the command itself returned false (signaling "did not
   * apply"). Used by both the editor dispatch path and the keymap matcher.
   */
  runCommand(t: string, payload: unknown, ctx: CommandCtx): boolean {
    const cmd = this.commands.get(t);
    if (!cmd) return false;
    // Read-only gate — returning false (rather than throwing) keeps keymap
    // fall-through working, so the browser still gets its default handling.
    if (cmd.readOnlySafe !== true && !this.isEditable()) return false;
    const r = cmd.run(ctx, payload);
    return r !== false;
  }

  /** Should the given history tag coalesce with prior matching tags? */
  shouldCoalesce(tag: string): boolean {
    for (const prefix of this.coalescePrefixes) {
      if (tag.startsWith(prefix)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// View registry — module-global. The DocView reconciler resolves a block's
// view by `block.type`. Multiple editors share this map (additive).
// ---------------------------------------------------------------------------

import type { PublicView } from "creo";
import type { Block } from "../model/types";
import type { BlockViewport } from "./selfVirtualized";

/**
 * Props every registered block view is called with. `viewport` is only
 * populated for blocks that declared `selfVirtualized` and only when the
 * editor is virtualized; every other view ignores the field.
 */
export type BlockViewProps = {
  block: Block;
  key?: string;
  viewport?: BlockViewport;
};

const viewByType = new Map<string, PublicView<BlockViewProps, void>>();

export function registerView(
  type: string,
  v: PublicView<BlockViewProps, void>,
): void {
  viewByType.set(type, v);
}

export function getView(
  type: string,
): PublicView<BlockViewProps, void> | null {
  return viewByType.get(type) ?? null;
}
