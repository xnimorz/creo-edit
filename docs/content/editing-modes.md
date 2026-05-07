---
title: "Editing modes"
slug: "editing-modes"
---

# Editing modes

The editor has two modes:

- **`"wysiwyg"`** (default) — rich-text editor with all blocks rendered visually.
- **`"md"`** — markdown-friendly mode: combine with `mdShortcutsPlugin` to enable typing shortcuts like `# `, `**foo**`, `- `.

Replaces the older `"regular" | "mono"` flag, which was purely a CSS class. Hosts that want a monospaced editor should add their own class via the `class` prop.

## Setting the mode

At construction:

```ts
const editor = createEditor({ mode: "md" });
```

Or at runtime:

```ts
editor.setMode("md");
editor.getMode(); // → "md"
```

## Markdown shortcuts

`mdShortcutsPlugin` is the recommended companion for `"md"` mode. It registers triggers that watch for markdown patterns at the start of a block (or in the middle of a run for inline marks) and rewrites them in place:

| Type      | Result                          |
| --------- | ------------------------------- |
| `# `      | Heading 1                       |
| `## `     | Heading 2                       |
| ... up to `###### ` | Heading 6              |
| `- ` / `* ` | Bulleted list item             |
| `1. `     | Numbered list item              |
| ` ``` `   | Code block                      |
| `**foo**` | Bold text                       |
| `*foo*` / `_foo_` | Italic text             |
| `~~foo~~` | Strikethrough                   |
| `` `foo` ``  | Inline code mark             |

```ts
import { createEditor, mdShortcutsPlugin } from "creo-edit";

const editor = createEditor({
  mode: "md",
  plugins: [mdShortcutsPlugin()],
});
```

The plugin works in `"wysiwyg"` mode too — the mode flag is only a hint. If you want shortcuts off in pure WYSIWYG, just don't include the plugin.

## Why a mode flag at all?

Some host integrations want to render their own UI affordances depending on whether the user is working in markdown style (e.g. show a preview pane, expose the raw markdown source). The mode flag gives them a single source of truth to switch on.

A future raw-markdown source view, where the editor renders the doc as a single editable `<pre>` of markdown text, will be activated via `mode: "md"` as well.
