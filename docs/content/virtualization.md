# Virtualization

The default renderer mounts every block in the document. For most editors that's fine — a typical document is tens to hundreds of blocks. Above that, you want only the visible blocks in the DOM.

## Enabling

```ts
const editor = createEditor({
  virtualized: true,
  virtualEstimatedHeight: 32,
  initial: { blocks: /* … */ },
});
```

`virtualEstimatedHeight` is the height (px) used for blocks that haven't been measured yet. Tune it to your typical block — 32 is a reasonable default for a 16px line-height paragraph; raise it if your blocks are mostly tables, images, or multi-line text.

## How it works

When `virtualized: true`, the editor mounts `VirtualDoc` instead of the regular `DocView`. `VirtualDoc`:

1. Treats the host page's scroll container as the viewport.
2. Maintains a `HeightIndex` — a Fenwick tree of measured per-block heights.
3. On every scroll, resolves `[scrollTop − overscan, scrollTop + viewport + overscan]` to a contiguous slice of blocks (O(log n)) and mounts only those.
4. As blocks unmount they're remembered with their last measured height, so the cumulative offset is exact for the parts of the document the user has scrolled through and approximate (using `virtualEstimatedHeight`) for the parts they haven't.

The result: rendering and reconciliation cost scale with viewport size, not document size. A 500,000-block document is the same to scroll through as a 500-block one.

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

## When it's worth it

Virtualization isn't free. Block heights vary, measurement happens on mount, and unmounted blocks lose any DOM-resident state (text-area carets, focus rings on non-editor children). Keep the default rendering for documents you can confidently bound to a few hundred blocks. Reach for virtualization when:

- Documents can grow into the thousands of blocks.
- Blocks are heterogeneous in height (mixed text, large images, big tables).
- You want predictable scroll performance regardless of document size.

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

- **Find-in-page** (`Cmd+F` in the browser) only finds text in mounted blocks. There's no general fix — if browser find is essential, don't virtualize, or roll your own search UI on top of `docStore`.
- **Anchor links** to off-screen blocks need to scroll the container yourself, then the block will mount and the anchor target appears.
- **Heights of media** (images, iframes) are estimated until they load. Expect minor scroll-offset jitter the first time the user scrolls past one.

## Imperative access

If you want to read or change the height index directly (e.g. to seed measurements from server-stored data), `HeightIndex` is exported from the package:

```ts
import { HeightIndex } from "creo-edit";
```

It's a plain Fenwick tree with `insert(at, h)`, `remove(at)`, `set(at, h)`, `prefixSum(i)`, and `findIndex(offset)`. See `src/virtual/heightIndex.ts` for the full surface.
