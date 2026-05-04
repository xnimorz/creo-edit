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

## Caveats

- **Find-in-page** (`Cmd+F` in the browser) only finds text in mounted blocks. There's no general fix — if browser find is essential, don't virtualize, or roll your own search UI on top of `docStore`.
- **Anchor links** to off-screen blocks need to scroll the container yourself, then the block will mount and the anchor target appears.
- **Heights of media** (images, iframes) are estimated until they load. Expect minor scroll-offset jitter the first time the user scrolls past one.

## Imperative access

If you want to read or change the height index directly (e.g. to seed measurements from server-stored data), `HeightIndex` is exported from the package:

```ts
import { HeightIndex } from "creo-editor";
```

It's a plain Fenwick tree with `insert(at, h)`, `remove(at)`, `set(at, h)`, `prefixSum(i)`, and `findIndex(offset)`. See `src/virtual/heightIndex.ts` for the full surface.
