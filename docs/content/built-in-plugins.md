---
title: "Built-in plugins"
slug: "built-in-plugins"
---

# Built-in plugins

The editor ships with two layers of plugins:

- **Default plugins** (auto-installed) — provide the core block kinds.
- **Optional plugins** — opt-in via `plugins: [...]`.

## Default plugins (auto-installed)

| Name           | Provides                              |
| -------------- | ------------------------------------- |
| `paragraph`    | `p` blocks                            |
| `heading`      | `h1`–`h6` blocks                      |
| `list`         | `li` blocks (`<ul>`/`<ol>` grouping)  |
| `code-block`   | `code` blocks                         |
| `image`        | `img` blocks                          |
| `cells`        | `table` + `columns` blocks, namespaced commands (`table.insertRow`, `table.nextCell`, ...), Tab/arrow keymap |

Opting out — drop a default plugin by passing `plugins: defaultPlugins.filter(p => p.name !== "image")`. Useful when you want, say, a paragraph-only editor.

## Optional plugins

### `slashCommandsPlugin`

Slash menu (`/` trigger) with a default list of insert-block actions (paragraph, headings, list, code, table, columns). Pass your own items to extend or replace.

```ts
import { slashCommandsPlugin } from "creo-editor";

const editor = createEditor({
  plugins: [
    slashCommandsPlugin({
      // optional — replace the default item list
      items: [
        ...defaultSlashItems,
        {
          id: "callout",
          title: "Callout",
          run: (ctx) => ctx.dispatch({ t: "myPlugin.insertCallout" }),
        },
      ],
    }),
  ],
});
```

### `mdShortcutsPlugin`

Markdown typing shortcuts. See [editing-modes](#/editing-modes) for the full list of patterns.

```ts
import { mdShortcutsPlugin } from "creo-editor";

createEditor({ plugins: [mdShortcutsPlugin()] });
```

### `dragHandlePlugin`

Notion-style drag handle (`⋮⋮`) in the left gutter. Drag a block to reorder via fractional-index mutation.

```ts
import { dragHandlePlugin } from "creo-editor";

createEditor({ plugins: [dragHandlePlugin()] });
// Or always-visible:
createEditor({ plugins: [dragHandlePlugin({ hoverOnly: false })] });
```

### `addBlockPlugin`

`+` button in the left gutter. Click inserts an empty paragraph above the hovered block.

```ts
import { addBlockPlugin, slashCommandsPlugin } from "creo-editor";

createEditor({
  plugins: [
    addBlockPlugin({
      // Compose with the slash menu — clicking + opens the slash menu
      // instead of inserting an empty paragraph.
      onClick: (block, blockEl) => {
        // your custom hook here
      },
    }),
    slashCommandsPlugin(),
  ],
});
```

## Composing plugins

Order matters in two places:

1. **HTML parser tag matching** (built-in HTML codecs first, then user plugins). If two plugins both register `parseHTML` for `<table>`, the first one wins.
2. **Plugin keymap precedence** (registration order, first match wins). If two plugins both register `Tab`, the first one's `when` predicate gets a shot first.

Otherwise plugins compose freely. Decorations from multiple plugins all attach to the same block; triggers from multiple plugins each get a chance at every text input.
