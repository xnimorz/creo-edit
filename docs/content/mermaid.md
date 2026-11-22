# Mermaid diagrams

`creo-edit-mermaid-plugin` adds a diagram block. It is drawn from [Mermaid](https://mermaid.js.org) source, and it can be edited two ways: by pointing at the picture, or by writing the source.

Try it on the [live demo](#/mermaid-demo).

It is a package of its own. `creo-edit` does not depend on it, or on anything it uses: add the plugin when you want diagrams, and nothing changes for an app that does not.

## Install

```sh
npm install creo-edit-mermaid-plugin
```

It needs `creo-edit` 0.6 or later, which you already have installed, and brings its own two dependencies:

- [`pele`](https://github.com/obsidianmd/pele) draws the diagram.
- [`@visimer/core`](https://github.com/inkeep/visimer) turns a visual edit into an edit of the source. A display-only page never loads it.

Both are loaded with `import()` the first time they are needed, so a page with no diagram fetches neither.

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

## The block

```ts
{ type: "mermaid", source: "flowchart TD\n  A[Start] --> B[Done]" }
```

One attribute. The block is atomic: the caret sits before or after it, Backspace beside it removes it, arrow keys step over it.

| Format | What a diagram becomes |
|---|---|
| JSON (`toJSON`) | `{ id, type: "mermaid", source }` |
| Markdown (`docToMarkdown`) | A fenced block tagged `mermaid` |
| HTML (copy) | `<pre data-block-kind="mermaid"><code class="language-mermaid">…</code></pre>` |
| HTML (paste) | That shape, `<pre class="mermaid">`, and `<div class="mermaid">` become diagrams. Any other `<pre>` is still a code block. |

A host that does not install the plugin keeps the block: it shows the "unsupported block" placeholder and re-emits the JSON untouched.

## Two modes

Every block has a switch between **Diagram** and **Code**.

Which one is showing is view state. Switching changes no document, emits no change, and adds nothing to undo. It works in a read-only editor, where Code shows the source in a read-only field.

### Diagram: editing the picture

In an editable editor the picture is the editor.

| Do this | To |
|---|---|
| Click | Select a node, an edge or a group |
| Double-click it | Rename it where it is |
| Start typing with a node selected | Rename it, replacing the text |
| **+** beside a selected node, or `Tab` | Add a node connected to it, already selected for typing |
| `Tab` while typing a name | Commit, and add the next connected node |
| Drag a dot on a selected node to another node | Connect the two |
| Drag a dot to empty space | Add a connected node |
| Double-click empty space, or **Add** in the bar | Add an unconnected node |
| `Delete` / `Backspace` | Remove what is selected |
| Arrow keys | Move the selection to the nearest node that way |
| `Escape` | Clear the selection |

While a name is being typed the node itself grows: the picture is redrawn with the text so far, and the field stays exactly over the node. The document is still written once, when the name is committed.

With something selected, the block's bar shows what can be done to it: a node's shape, an edge's line style and direction, delete.

Every one of these is an edit to the source text. Each is one undo step, undone with the editor's own `Mod+Z`.

What you cannot do is drag a node to a position. Mermaid lays a diagram out itself, and the source has nowhere to store one.

Visual editing covers flowcharts, sequence, state, class and entity-relationship diagrams. Every other type Pele can draw is drawn, and edited in Code.

### Code: editing the source

The source in a text field, with the picture underneath following each keystroke.

- The field holds a draft. The document is written once, when you leave the field, switch back to Diagram, or press `Mod+Enter`. One edit session is one undo step.
- `Escape` throws the draft away.
- Source that cannot be drawn shows the error and where it is, over the last picture that could be.

## Options

```ts
mermaidPlugin({
  code: true,            // offer Code mode and the switch
  visualEditing: true,   // allow edits on the picture
  bar: true,             // draw the block's bar (false: draw mermaidActions() yourself)
  preload: "idle",       // "idle" | "eager" | false
  preloadTypes: ["flowchart", "sequence"],
  adoptCodeBlocks: false,
  links: false,          // working links inside diagrams
  images: false,         // external images inside diagrams
  nodeId,                // () => string: the id a node added in the picture takes
  templates,             // starters offered by an empty block
  labels,                // UI strings
  modes,                 // Store<ReadonlyMap<BlockId, "diagram" | "code">>
  engine,                // () => Promise<MermaidEngine>, to replace Pele
});
```

**`adoptCodeBlocks`** — a markdown parser turns a mermaid fence into a `code` block with `lang: "mermaid"`. With this on, such blocks become diagrams when a document is loaded. It is off by default because a document *about* mermaid wants its source to stay code.

**`links` / `images`** — off, so a diagram from someone else can neither navigate nor make a network request.

**`nodeId`** — a node added in the picture takes the next free id (`E` after `D`). That is the readable choice for one author; where several people edit one document at once, two nodes added at the same moment would both be `E`, and merge into one. Such a host passes ids no two devices would both pick. It applies to flowchart nodes and states; the other types name an item by its label.

**`modes`** — pass your own store to persist which mode each block shows, or to drive it from your own UI.

## Commands

| Command | Payload | |
|---|---|---|
| `mermaid.insert` | `{ source?, mode? }` | Inserts after the caret's block; an empty paragraph under the caret becomes the diagram. No source: the starter picker. |
| `mermaid.setSource` | `{ blockId, source }` | Records a `blockAttrs` change. Returns `false` for an unchanged source. |
| `mermaid.fromCode` | `{ blockId? }` | A `code` block → a diagram, same id. |
| `mermaid.toCode` | `{ blockId? }` | The reverse. |

Switching mode is not a command (it is not a document change):

```ts
import { mermaidController } from "creo-edit-mermaid-plugin";

mermaidController(editor)?.setMode(blockId, "code");
```

## Actions, for your own menu

The bar on the block is drawn from one list. `mermaidActions` hands you the same list, so a context menu or a phone's block sheet can offer exactly what the bar does:

```ts
import { mermaidActions } from "creo-edit-mermaid-plugin";

for (const action of mermaidActions(editor, blockId)) {
  // { key, scope: "block" | "entity", label, icon, on?, disabled?, choices?, run() }
}
```

`scope: "entity"` actions apply to whatever is selected in the diagram.

## A shell of your own

`MermaidView` draws the block in a bare element. A host whose blocks have a shell of their own (a grip, a menu) registers its own view for the `mermaid` type, draws its shell with an empty element of class `ce-mermaid` in it, and mounts the block's inside there:

```ts
import { mountMermaid } from "creo-edit-mermaid-plugin";

const mount = mountMermaid(el, block); // in the view's onMount
mount.update(nextBlock);               // in onUpdateAfter
mount.destroy();                       // in dispose
```

The element must be inside the editor's root, and the view must declare no children for it.

## Theming

The block's chrome reads a few custom properties on `.ce-mermaid` (`--ce-mmd-accent`, `--ce-mmd-surface`, `--ce-mmd-border`, …). The diagram itself is themed with Pele's variables, and follows a theme change without being redrawn:

```css
.ce-mermaid {
  --ce-mmd-accent: #205ea6;
  --pele-bg: #fffcf0;
  --pele-fg: #100f0f;
  --pele-surface: #f2f0e5;
}
```

The bar is sticky, so on a tall diagram the selection's actions stay in reach. Under a fixed header, set `--ce-mmd-sticky-top` to the header's height.

## Loading and offline

- The engine is fetched when the first diagram mounts, or a little earlier: with `preload: "idle"` the plugin warms it up when the browser is idle.
- Your bundler emits the engine (`pele`, `@visimer/core`) as hashed files of your own build. A service worker that precaches your build caches them, and diagrams work offline with nothing more to do.
- If the engine comes from a CDN instead, `creo-edit-mermaid-plugin/sw` has a cache-first handler for your own service worker:

```ts
import { cacheMermaidEngine } from "creo-edit-mermaid-plugin/sw";

const mermaid = cacheMermaidEngine();
self.addEventListener("fetch", (event) => {
  if (mermaid(event)) return;
  // …your own routing
});
```

## Fields inside your own blocks

The Code field lives inside a block, under the editor's root, where the editor listens for every keystroke. It keeps its typing with `isolateInput`, which is exported from `creo-edit` for any plugin that puts a form control in a block:

```ts
import { isolateInput } from "creo-edit";

field.addEventListener("keydown", onKey); // your listeners first
isolateInput(field);                      // then stop the events here
```

Use `addEventListener` on the field itself. A handler attached through creo props is delegated from the app root, above the editor, and would never see the event.
