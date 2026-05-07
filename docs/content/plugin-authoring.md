---
title: "Authoring plugins"
slug: "plugin-authoring"
---

# Authoring plugins

A plugin is a bag of optional contributions:

```ts
type EditorPlugin = {
  name: string;
  blocks?: BlockDef[];
  commands?: CommandDef[];
  keymap?: KeymapDef[];
  triggers?: TriggerDef[];
  decorations?: DecorationDef[];
};
```

You install a plugin by passing it in `EditorOptions.plugins`:

```ts
import { createEditor, slashCommandsPlugin } from "creo-edit";

const editor = createEditor({
  plugins: [slashCommandsPlugin()],
});
```

User plugins are installed AFTER the built-ins (paragraph, heading, list, code, image, cells), so registration order is: built-ins → user plugins. For HTML tag matching, first registration wins.

## Tutorial: an `@mention` trigger

A trigger watches text input for a pattern and opens UI when matched. Mentions are the canonical example: type `@`, get a popover of users, pick one, dispatch a command.

```ts
import type { EditorPlugin, TriggerDef } from "creo-edit";

const users = ["alice", "bob", "carol"];

const mentionTrigger: TriggerDef = {
  match: "@",
  open(ctx) {
    const popover = document.createElement("div");
    popover.className = "my-mention-popover";
    document.body.appendChild(popover);
    const rect = ctx.caretRect();
    if (rect) {
      popover.style.position = "fixed";
      popover.style.left = `${rect.left}px`;
      popover.style.top = `${rect.bottom + 4}px`;
    }

    let query = "";
    const render = () => {
      popover.innerHTML = "";
      const matches = users.filter((u) => u.startsWith(query));
      for (const u of matches) {
        const item = document.createElement("div");
        item.textContent = `@${u}`;
        item.style.padding = "4px 8px";
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          ctx.dispatch({ t: "insertText", text: `${u} ` });
          close();
        });
        popover.appendChild(item);
      }
    };
    render();

    const close = () => popover.remove();

    return {
      onTextChange(q) {
        query = q;
        render();
      },
      onKey(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          const first = users.filter((u) => u.startsWith(query))[0];
          if (first) ctx.dispatch({ t: "insertText", text: `${first} ` });
          close();
          return true;
        }
        return false;
      },
      close,
    };
  },
};

export const mentionPlugin: EditorPlugin = {
  name: "mention",
  triggers: [mentionTrigger],
};
```

Then:

```ts
const editor = createEditor({ plugins: [mentionPlugin] });
```

Type `@al` and the popover filters to `alice`. Press Enter or click and the editor inserts `alice ` at the caret.

## Other contribution kinds

- **Block kinds** — see [block-format](#/block-format) for the wire shape, then provide a `BlockDef` with `view`, `runsAt` (only if the block holds nested runs), `anchorCodec`, `htmlCodec`, and `serializeCodec`. The built-in `cellsPlugin` ([source](https://github.com/...)) is the worked example.
- **Commands** — `{ t: "myPlugin.action", run: (ctx, payload) => { ... } }`. Dispatch via `editor.dispatch({ t: "myPlugin.action", payload })`.
- **Keymap** — `{ chord: "Mod+Shift+K", when?: ctx => ..., command: { t, payload? } }`. Plugin keymap entries are matched BEFORE the built-in keymap; the first matching entry whose `when` returns true (or which has no `when`) wins. If the dispatched command returns `false`, the matcher falls through to subsequent entries (so plugin commands can no-op without consuming the key).
- **Decorations** — overlay UI per block. See the next page.

## Lifecycle

Plugins are stateless: their contributions are registered once at `createEditor` time and live for the editor's lifetime. State that needs to track per-instance data (an active popover, a hover store) lives inside the contribution itself — usually as a closure around the `open()` or `mount()` function.
