// ---------------------------------------------------------------------------
// slashCommandsPlugin — registers a "/" trigger that opens a popover menu
// of block-creation actions. Reuses the trigger system shipped in M3.
//
// Behavior:
//   - Typing "/" at the caret opens the menu, anchored to the caret rect
//   - Subsequent typed chars filter the item list (default: substring match
//     against title + keywords)
//   - ArrowUp / ArrowDown navigate; Enter picks; Escape / click-away closes
//   - Picking an item:
//       1. Deletes the typed "/<query>" string from the document
//       2. Calls the item's `run(ctx)` which dispatches the actual command
//
// Plugin authors extend by passing custom items via `slashCommandsPlugin({
// items: [...] })`. A trigger plugin for "@" mentions can ignore this whole
// module and register its own TriggerDef with a different match.
// ---------------------------------------------------------------------------

import type { CommandCtx, EditorPlugin, TriggerDef } from "../../plugin/types";
import type { DispatchableCommand } from "../../createEditor";
import {
  defaultFilter,
  defaultSlashItems,
  type SlashItem,
} from "./items";
import { mountSlashMenu } from "./menu";

export type SlashOptions = {
  /** Replace or extend the default item list. */
  items?: SlashItem[];
  /** Custom filter — defaults to case-insensitive substring on title+keywords. */
  filter?: (items: SlashItem[], query: string) => SlashItem[];
};

export function slashCommandsPlugin(opts: SlashOptions = {}): EditorPlugin {
  const items = opts.items ?? defaultSlashItems;
  const filter = opts.filter ?? defaultFilter;

  const trigger: TriggerDef = {
    match: "/",
    open(ctx) {
      const startAt = ctx.at;
      let query = "";

      const removeTriggerText = (): void => {
        // Walk back from the current caret to startAt and delete the
        // characters in between via repeated deleteBackward dispatches.
        // The trigger char itself ("/") was at startAt.offset, so we want
        // to delete from current offset back to startAt.offset.
        const sel = ctx.selStore.get();
        const at = sel.kind === "caret" ? sel.at : sel.anchor;
        if (at.blockId !== startAt.blockId) return;
        const pathSame = at.path.length === startAt.path.length &&
          at.path.every((v, i) => i === at.path.length - 1 ? true : v === startAt.path[i]);
        if (!pathSame) return;
        const startOff = startAt.path[startAt.path.length - 1] ?? 0;
        const curOff = at.path[at.path.length - 1] ?? 0;
        const delta = curOff - startOff + 1; // +1 for the "/" itself
        for (let i = 0; i < delta; i++) {
          ctx.dispatch("deleteBackward");
        }
      };

      const cmdCtx: CommandCtx & { dispatch: (cmd: DispatchableCommand) => void } = {
        docStore: ctx.docStore,
        selStore: ctx.selStore,
        // Pass the full command object through (don't extract `payload`) so
        // typed built-ins like `{ t: "insertTable", rows, cols }` keep their
        // flat fields instead of arriving as `{ t, payload: undefined }`.
        dispatch: (cmd) => ctx.dispatch(cmd as never),
      };

      const menu = mountSlashMenu({
        items,
        filter,
        caretRect: ctx.caretRect(),
        onPick: (it) => {
          removeTriggerText();
          it.run(cmdCtx);
          // Tell the trigger manager we're done so subsequent keys (e.g.
          // Enter to split the just-promoted h1) flow through normally.
          // ctx.close() invokes our own `close()` below, which destroys
          // the menu — no need to call menu.destroy() here as well.
          ctx.close();
        },
        onCancel: () => ctx.close(),
      });

      return {
        onTextChange(q) {
          query = q;
          menu.setQuery(query);
        },
        onKey(e) {
          return menu.handleKey(e);
        },
        close() {
          menu.destroy();
        },
      };
    },
  };

  return {
    name: "slash-commands",
    triggers: [trigger],
  };
}

export type { SlashItem } from "./items";
export { defaultSlashItems, defaultFilter } from "./items";
// Re-export the menu mount fn so consumers can attach a slash UI to
// non-editor surfaces (e.g. a markdown source textarea in the demo).
export { mountSlashMenu, type MenuHandle, type MenuOptions } from "./menu";
