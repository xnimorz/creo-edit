# creo-edit-rail-plugin

A rail of ticks down the edge of a [creo-edit](https://github.com/xnimorz/creo-editor) document, one per point you choose: see where you are, hover a tick to read what is there, click to go there.

What a point is belongs to your app: a document's headings, a chat's user messages, a review's comments. The plugin draws, tracks and scrolls; you say which blocks count.

```sh
npm install creo-edit-rail-plugin
```

```ts
import { createEditor } from "creo-edit";
import { headingPoints, railPlugin } from "creo-edit-rail-plugin";
import "creo-edit-rail-plugin/styles.css";

const editor = createEditor({
  plugins: [railPlugin({ points: headingPoints() })],
});
```

## Points

`points(doc, editor)` returns the ticks, read from the document. It runs again after the document changes, at most once a frame.

```ts
type RailPoint = {
  blockId: BlockId;
  label: string;   // the tick's name, and the first line of its hover card
  detail?: string; // under the label, quieter
  size?: number;   // 0–1: how far the tick reaches. Default 0.5
};
```

A chat's user messages, with the agent's last reply under each:

```ts
railPlugin({
  label: "Your messages",
  points: (doc) => {
    const out: RailPoint[] = [];
    for (const id of doc.order) {
      const block = doc.byId.get(id)!;
      if (block.type === "chat-prompt") {
        const label = blockTextOf(block);
        out.push({ blockId: id, label, size: Math.min(1, label.length / 400) });
      } else if (out.length > 0 && block.type === "p") {
        out[out.length - 1]!.detail = blockTextOf(block);
      }
    }
    return out;
  },
});
```

`headingPoints({ levels, detail })` is the one for documents: a tick per heading of the given levels (default 1–3), longer the higher the heading, with the first text under it as the detail.

Points whose block is not in the document are left out, and the rest are put in document order.

## Options

| Option | Default | |
|---|---|---|
| `points` | — | Required. See above. |
| `minPoints` | `2` | Fewer and the rail is hidden. |
| `side` | `"left"` | Which edge of the scroller. |
| `scroller` | nearest scrolling ancestor, else the page | `(root) => HTMLElement \| null`. |
| `readingLine` | `0.4` | Where the reader's eye is taken to be, as a share of the view from its top. The point last above it is lit; at the end of the scroll the last point in view, at the start the first. |
| `jumpOffset` | `16` | px left above a block gone to. |
| `flash` | `true` | Flash the block gone to. |
| `label` | `"Jump to"` | The rail's accessible name. |
| `onJump` | — | `(point) => void`, after a jump. |

## Controller

```ts
const rail = railController(editor); // null if the plugin is not installed there
rail.points();    // the points shown now
rail.active();    // index into points(), -1 above the first
rail.jump(id);    // as a click on that tick
rail.refresh();   // read the points again now, for a `points` that reads more than the document
```

## Keyboard

The rail is one stop in the tab order. Arrow keys, Home and End move between ticks (each shows its card), Enter or Space goes there, Escape puts the card away. A pointer press on a tick does not take the caret out of the document.

## Styling

Set these custom properties anywhere above the editor:

| Property | Default | |
|---|---|---|
| `--creo-rail-mark` | `currentColor`, faded | A tick. |
| `--creo-rail-active` | `currentColor` | The tick being read. |
| `--creo-rail-hover` | `Highlight` | The tick under the pointer or focus. |
| `--creo-rail-flash` | `currentColor` | The ring a jump flashes. |
| `--creo-rail-card-bg`, `-card-fg`, `-card-muted`, `-card-border` | system colors | The hover card. |
| `--creo-rail-inset` | `4px` | The rail's distance from the edge. |

## How it is put on the page

The rail is a sibling of the editor's root, as the editor's own decoration layer is, positioned `fixed` over the box of the element the document scrolls in. That box does not move when its content scrolls, so the rail stays put without following every scroll frame, and it is moved only when the layout moves the box. Being inside your page's tree, it is hidden with the editor and sits under your dialogs.

It works with windowed (`virtualized`) documents: a point far off screen is gone to through `editor.scrollToBlock`, and placed once it has been drawn.

## What it depends on

| | |
|---|---|
| `creo-edit` ≥ 0.8 | Peer dependency: your app's one copy. It needs `EditorPlugin.onMount`, new in 0.8. (Marked optional so package managers do not fetch it for you; the plugin does need it.) |
