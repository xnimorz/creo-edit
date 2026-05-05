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

import { registerAnchorCodec } from "./anchorCodec";
import { registerHtmlBlockCodec } from "./htmlCodec";
import { registerRunsAt } from "./runsAt";
import { registerSerializeCodec } from "./serializeCodec";
import type {
  CommandCtx,
  CommandDef,
  DecorationDef,
  EditorPlugin,
  KeymapDef,
  TriggerDef,
} from "./types";

export class Registry {
  readonly commands = new Map<string, CommandDef<unknown>>();
  readonly keymap: KeymapDef[] = [];
  readonly triggers: TriggerDef[] = [];
  readonly decorations: DecorationDef[] = [];
  readonly coalescePrefixes = new Set<string>(["text:"]);
  /** Set of all known block type discriminators (for fast existence checks). */
  readonly knownBlockTypes = new Set<string>();

  install(plugin: EditorPlugin): void {
    if (plugin.blocks) {
      for (const def of plugin.blocks) {
        this.knownBlockTypes.add(def.type);
        if (def.runsAt) registerRunsAt(def.type, def.runsAt as never);
        if (def.anchorCodec) registerAnchorCodec(def.type, def.anchorCodec);
        if (def.htmlCodec) registerHtmlBlockCodec(def.type, def.htmlCodec);
        if (def.serializeCodec) registerSerializeCodec(def.type, def.serializeCodec);
        // Note: view registration lives in viewRegistry (./viewRegistry).
        // We import-and-call there too so the renderer can resolve by type.
        registerView(def.type, def.view as never);
      }
    }
    if (plugin.commands) {
      for (const c of plugin.commands) this.commands.set(c.t, c);
    }
    if (plugin.keymap) this.keymap.push(...plugin.keymap);
    if (plugin.triggers) this.triggers.push(...plugin.triggers);
    if (plugin.decorations) this.decorations.push(...plugin.decorations);
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

const viewByType = new Map<string, PublicView<{ block: Block; key?: string }, void>>();

export function registerView(
  type: string,
  v: PublicView<{ block: Block; key?: string }, void>,
): void {
  viewByType.set(type, v);
}

export function getView(
  type: string,
): PublicView<{ block: Block; key?: string }, void> | null {
  return viewByType.get(type) ?? null;
}
