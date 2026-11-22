# creo-edit-mermaid-plugin

[Mermaid](https://mermaid.js.org) diagrams for [creo-edit](https://github.com/xnimorz/creo-editor): a block you can edit by pointing at the picture, or by writing the source.

A package of its own. `creo-edit` does not depend on it, or on anything it uses.

```sh
npm install creo-edit-mermaid-plugin
```

```ts
import { createEditor, slashCommandsPlugin, defaultSlashItems } from "creo-edit";
import { mermaidPlugin, mermaidSlashItem } from "creo-edit-mermaid-plugin";
import "creo-edit-mermaid-plugin/styles.css";

const editor = createEditor({
  plugins: [
    mermaidPlugin(),
    slashCommandsPlugin({ items: [...defaultSlashItems, mermaidSlashItem] }),
  ],
});

editor.dispatch({ t: "mermaid.insert", payload: {} });
```

## What it depends on

| | |
|---|---|
| `creo-edit` ≥ 0.6, `creo` ≥ 0.2.9 | Peer dependencies: your app's one copy. (`creo-edit` is marked optional so package managers do not try to fetch it for you; the plugin does need it.) |
| [`pele`](https://github.com/obsidianmd/pele) | Dependency. Draws the diagram. |
| [`@visimer/core`](https://github.com/inkeep/visimer) | Dependency. Turns a visual edit into an edit of the source. |

Both dependencies are loaded with `import()` the first time a diagram needs them, so a page with no diagram fetches neither.

## What you get

- **A block**, `{ type: "mermaid", source }`. Atomic: the caret sits before or after it. It leaves as a fenced block tagged `mermaid` in markdown and HTML, and comes back from both.
- **Two modes**, switched on the block. *Diagram* is the picture; *Code* is the source in a text field, with the picture following each keystroke.
- **Editing the picture.** Click to select, double-click or just type to rename, **+** or `Tab` to add a connected node, drag a dot to connect two, `Delete` to remove. Shape, line style and direction are in the block's bar. Every edit is a change to the source text and one undo step.
- **Flowchart, sequence, state, class and entity-relationship** diagrams are editable by hand. Every other type Pele draws is drawn, and edited in Code.

Options, commands, theming, the action list for your own menus and the service-worker helper are in the [documentation](https://github.com/xnimorz/creo-editor/blob/main/docs/content/mermaid.md).

## Working on it

This package lives in the creo-edit repository and is developed against the editor's sources, one directory up.

```sh
bun install            # in the repository root, then here
bun test src/
bun run typecheck
bun run build          # builds creo-edit first if it has not been
```
