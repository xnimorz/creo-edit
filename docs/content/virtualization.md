# Virtualization

The default renderer mounts every block in the document. For most editors that's fine — a typical document is tens to hundreds of blocks. Above that, you want only the visible blocks in the DOM.

## Enabling

```ts
const editor = createEditor({
  virtualized: true,
  initial: { blocks: /* … */ },
});
```

| Option | Type | Default | What it does |
|---|---|---|---|
| `virtualized` | `boolean \| (() => boolean)` | `false` | Window the document. A thunk is read at every render of the root, so a host can window only the documents long enough to need it (`() => doc.order.length > 200`) and leave short ones with the plain renderer and its DOM. |
| `virtualEstimatedHeight` | `number` | `32` | Height (px) assumed for a block that has not been measured yet. |
| `virtualEstimateHeight` | `(block) => number` | — | A per-block estimate (from its text length, its kind). Blocks are measured as they are drawn; until then the scrollbar's length is the sum of these, so the closer they are the less it moves. Called once per block object. |
| `virtualOverscan` | `number` | `1.5` | How much is mounted above and below what is visible, in viewport heights. |
| `virtualHidden` | `Store<ReadonlySet<BlockId>>` | — | Blocks not drawn at all, taking no height — a host's folded sections. Set a **new** set for every change. |
| `virtualSpacerStyle` | `(doc, nextIndex) => string` | — | Extra inline style for a spacer, given the index of the block drawn right after it. For CSS a host carries from block to block through the document (list counters). |

## How it works

![The window: only the blocks in the viewport and the overscan around it are mounted; a top and a bottom spacer stand for the rest.](illustrations/virtual-window.svg)

When virtualized, the editor mounts `VirtualDoc` instead of the regular `DocView`. `VirtualDoc`:

1. Finds the nearest scrolling ancestor (else the window) and where the editor's blocks start inside it — an editor under a header, or nested in a block of another editor, is windowed from its own top, not from the scroller's `scrollTop`.
2. Maintains a `HeightIndex` — a Fenwick tree of per-block heights — and resolves `[top − overscan, top + viewport + overscan]` to a slice of blocks in O(log n).
3. Mounts that slice between two spacer divs as tall as what is left out.
4. Re-renders only when the viewport, with half a screen to spare, leaves what is mounted. A scroll inside that slack costs nothing.

Rendering and reconciliation scale with the viewport, not the document. What still scales with the document is the model: `updateBlock` clones the id map, and the index is rebuilt (O(n), plain arithmetic) when blocks are added, removed or reordered.

### Heights are advances

![A block's own box leaves out the margin between blocks; the advance, from its top to the next top, counts it.](illustrations/virtual-advance.svg)

A block's height in the index is its **advance**: the distance from its top to the top of whatever is laid out after it — the next block, a spacer, the end of the blocks. Margins and gaps are part of it. Summing each block's own box instead leaves them out, and the index drifts from the page by that much per block; a few thousand blocks in, the window is screens away from the viewport and the page shows a spacer.

Advances are read in one pass over the mounted blocks after each render and whenever a `ResizeObserver` reports a change, and are kept **by block id**: a block inserted or moved never inherits its neighbour's height, and a block that leaves the window keeps its measurement for when it comes back.

### Pins

![The caret's block and its neighbours stay mounted, with a gap spacer between them and the window, while the page is scrolled far from the caret.](illustrations/virtual-pins.svg)

Some blocks are mounted wherever the page is scrolled:

- while the editor has the focus, the blocks holding the selection's end points — and the caret block's two neighbours, so an arrow key pressed with the caret out of sight lands in a real block;
- the block holding the focused element, when that is a control inside a block (a form field in a card);
- a block `editor.scrollToBlock()` is on its way to.

Unmounting any of them would drop the browser's own selection or focus, and the next key would act somewhere else. Between pinned blocks and the window sits a **gap spacer**; spacers are `contenteditable="false"`, so the caret neither rests in one nor crosses one into a block that is not the next.

The page's selection follows a selection set from outside onto a block that is not mounted (a command, an undo, a host's "go to"): the block is mounted, then the native selection is put on it.

### Hidden blocks, lists, and CSS that runs through the document

![Hidden blocks take no height and are not drawn; a run of list items is one list, and the spacer before it carries the count the items above reached.](illustrations/virtual-hidden-lists.svg)

**`virtualHidden`.** Hiding blocks with CSS (`display: none` on a folded section) does not work under windowing: zero-height blocks all fit in the window, so a folded run of 2 000 is mounted whole the moment the window reaches it. Blocks in `virtualHidden` are skipped — not drawn, no height, never pinned.

```ts
import { store } from "creo";

const hidden = store.new<ReadonlySet<BlockId>>(new Set());
const editor = createEditor({ virtualized: true, virtualHidden: hidden });

// Fold: a NEW set each time.
hidden.set(new Set(idsUnderTheFoldedHeading));
```

**Lists.** Consecutive list items are grouped in one `<ul>` / `<ol class="ce-list">`, exactly as the plain renderer groups them, so list CSS and layout are the same either way. The list is keyed by the run's first block *in the document*, so it — and every item in it — stays the same element while the window moves along it.

**`virtualSpacerStyle`.** Anything CSS carries from block to block stops at the window's edge, because the blocks before it are not there. The usual case is a numbered list counted with CSS counters: its first mounted item would say "1.". The spacer standing for the missing blocks can set what they would have left:

```ts
createEditor({
  virtualized: true,
  // `next`: the index of the block drawn right after this spacer.
  virtualSpacerStyle: (doc, next) => `counter-set: item ${itemsCountedBefore(doc, next)};`,
});
```

### Scroll anchoring

When something above the viewport changes size — a block mounted with a wrong estimate while scrolling up, an image loading, an edit arriving from elsewhere — `VirtualDoc` puts the first visible block back where it was. It does this itself, on every render and every measurement, and switches the browser's scroll anchoring off inside the window (`overflow-anchor: none` on `.creo-vroot`) so the two never both correct; browsers without native anchoring behave the same. A scroll position someone else moved (the host's own `scrollTop` write) is adopted, never "corrected".

## Host-page requirements

Virtualization needs a scrolling ancestor — the editor doesn't make itself scroll. Wrap the `EditorView()` in a container with a fixed height and `overflow-y: auto`:

```ts
import { div } from "creo";

const App = view(() => ({
  render() {
    div(
      {
        class: "editor-host",
        style: "height: 100vh; overflow-y: auto;",
      },
      () => {
        editor.EditorView();
      },
    );
  },
}));
```

If the editor is in a regularly-scrolling document body (no fixed-height ancestor), virtualization will still work — the window itself is the viewport — but most apps want the editor to scroll independently of any chrome.

The blocks sit in a wrapper, `.creo-vroot`, inside the editor root — not directly under it. A host whose root lays its blocks out with flex or grid gives the wrapper the same layout (`.my-editor > .creo-vroot { display: flex; flex-direction: column; }`), and selectors written as `root > block` need the wrapper in between.

## What a host has to take over

Windowing takes blocks off the page. Whatever a host did by looking at them has to come from the document instead:

- **State written onto block elements from outside the render** (an attribute marking the caret's block, a selection tint) is lost when a block is drawn again. Subscribe to `onMountedBlocksChanged(root => …)` and put it back.
- **"Go to this block"** — a search result, a permalink — must go through `editor.scrollToBlock(id)`, which scrolls to where the index says the block is, mounts it, then puts it exactly in place. `element.scrollIntoView()` has no element to work on.
- **The document's start and end.** The browser's own ⌘↑ / ⌘↓ (Ctrl+Home / Ctrl+End) stop at the first and last block *mounted*. Bind them: set the selection in the model and call `scrollToBlock`.
- **Anything that walks blocks in the DOM** — a find-in-page of your own, drag-and-drop targets, "the next card" — sees only the window. Walk `docStore` instead, and ask for the element only where one is needed.
- **State held by a block's view** (a card's scroll position, an open menu) starts again when the block is drawn again. Keep what must survive in a store.

## When it's worth it

Keep the default renderer for documents you can bound to a few hundred blocks: nothing is ever taken off the page, and every block's state stays where it is. Reach for virtualization — or the thunk, for both — when:

- Documents can grow into the thousands of blocks.
- Opening a document, a keystroke or a caret move must cost the same whatever the document's size.

Measured in a host with real content (cront.app, a document of 2 300 blocks — 46 000 DOM nodes drawn whole): opening it went from 565 ms to 18 ms, a held arrow key from 10.6 ms to 2.7 ms per key, a typed character from 22 ms to 3 ms.

## Sub-block virtualization

`VirtualDoc` windows over *blocks*. A 5,000-line file is one `code` block, so block-level windowing does nothing for it: all 5,000 lines mount, and a 32px estimate is wrong by two orders of magnitude — which also corrupts the scrollbar geometry for everything below it.

Rather than turn `HeightIndex` into a two-level tree — making every block pay for a case only a few block kinds have — a block kind can declare that it manages its own internal windowing:

```ts
const longLogDef: BlockDef<LogBlock> = {
  type: "log",
  view: LogView,
  selfVirtualized: {
    // Called when the block changes, not per frame. Uniform rows make this
    // arithmetic rather than measurement.
    measureHeight: (block, { lineHeight }) => block.lines.length * lineHeight,
  },
};
```

When present, `VirtualDoc`:

- stops observing that block with the `ResizeObserver` (its self-chosen height would otherwise fight the index it is already authoritative for — the exclusion is a plain `data-block-kind` test, since that attribute is already on the element);
- trusts `measureHeight` for the outer index, **including while the block is off-screen**, so the scrollbar is right from the first frame;
- passes the visible region down to the view as `viewport`, in the block's own coordinate space:

```ts
type BlockViewport = { top: number; bottom: number };  // px from the block's top

const LogView = view<SelfVirtualizedProps<LogBlock>>(({ props }) => ({
  render() {
    const { block, viewport } = props();
    const first = viewport ? Math.floor(viewport.top / LINE_H) : 0;
    const last  = viewport ? Math.ceil(viewport.bottom / LINE_H) : block.lines.length - 1;
    // …render lines [first, last] between two spacer divs of the
    // appropriate height. The outer index sees one tall entry.
  },
}));
```

`viewport` is absent when the editor isn't virtualized, in which case render everything.

Only opt in when the block is internally long **and** uniform enough for `measureHeight` to be cheap. A block that isn't simply doesn't declare `selfVirtualized` and behaves exactly as before.

**A block that opts in owns its anchor codec's correctness.** A codec that walks mounted sub-elements — as the built-in `codeBlockCodec` walks `.ce-code-line` — will compute wrong offsets once some of those elements stop mounting. Ship a codec that accounts for your own spacers. This is why the built-in code block does *not* opt in.

## Caveats

- **The browser's find-in-page** only finds text in mounted blocks. There's no general fix — if browser find is essential, don't virtualize, or build search on `docStore` (the search plugin does) and bring each match with `scrollToBlock`.
- **Heights of what has not been drawn** are estimates. The scrollbar's thumb moves a little as blocks are measured; the content under the pointer does not (see scroll anchoring). A good `virtualEstimateHeight` makes it barely noticeable.
- **Tab order** covers the mounted blocks.

## Imperative access

`HeightIndex` is exported for hosts that want the arithmetic on its own:

```ts
import { HeightIndex } from "creo-edit";

const index = HeightIndex.from(Float64Array.from(heights), 32); // O(n)
index.setHeight(i, h);     // O(log n)
index.heightAt(i);
index.prefix(i);           // sum of heights before i
index.total();
index.findIndexAtY(y);     // the block at offset y
```
