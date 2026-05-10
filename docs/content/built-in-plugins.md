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
import { slashCommandsPlugin } from "creo-edit";

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
import { mdShortcutsPlugin } from "creo-edit";

createEditor({ plugins: [mdShortcutsPlugin()] });
```

### `dragHandlePlugin`

Notion-style drag handle (`⋮⋮`) in the left gutter. Drag a block to reorder via fractional-index mutation.

```ts
import { dragHandlePlugin } from "creo-edit";

createEditor({ plugins: [dragHandlePlugin()] });
// Or always-visible:
createEditor({ plugins: [dragHandlePlugin({ hoverOnly: false })] });
```

### `addBlockPlugin`

`+` button in the left gutter. Click inserts an empty paragraph above the hovered block.

```ts
import { addBlockPlugin, slashCommandsPlugin } from "creo-edit";

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

### `calendarPlugin`

Adds two non-editable atomic blocks: `calendar` (a multi-row card showing N days starting from a date) and `date-marker` (a single bold line, e.g. *“Wednesday, 8 May.”*). Both render `contenteditable="false"`, so the caret can only sit before or after them; Backspace deletes the whole block; arrow keys step around it.

The plugin is the example reference for building your own non-editable block — see [non-editable blocks](#/non-editable-blocks) for the live demo.

```ts
import {
  createEditor,
  calendarPlugin,
  calendarSlashItem,
  defaultSlashItems,
  slashCommandsPlugin,
} from "creo-edit";

createEditor({
  plugins: [
    calendarPlugin(),
    slashCommandsPlugin({ items: [...defaultSlashItems, calendarSlashItem] }),
  ],
});

// Insert programmatically:
editor.dispatch({ t: "calendar.insert", payload: { date: "2026-05-08", days: 7 } });
editor.dispatch({ t: "dateMarker.insert", payload: { date: "2026-05-08" } });
```

### `infiniteScrollPlugin`

Watches a scroll container and calls a host-supplied callback when the viewport gets near an edge. The plugin handles scroll-anchoring on prepend so the user's view doesn't jump as content grows above.

```ts
import {
  createEditor,
  calendarPlugin,
  infiniteScrollPlugin,
} from "creo-edit";

const editor = createEditor({
  plugins: [
    calendarPlugin(),
    infiniteScrollPlugin({
      // Element to watch. Function form is resolved lazily so the
      // wrapper div doesn't need to exist at editor-creation time.
      scrollContainer: () => document.querySelector(".my-wrap"),

      // Called when the user scrolls within `threshold` of the
      // bottom. Use editor.appendBlocks(...) to add at the end.
      loadAfter: (ed) => ed.appendBlocks(nextDayPair(ed)),

      // Called near the top. The plugin re-applies scrollTop after
      // your prepend so the viewport stays anchored to whatever the
      // user was reading.
      loadBefore: (ed) => ed.prependBlocks(prevDayPair(ed)),

      // Distance from edge that triggers a load. Default: 240px.
      threshold: 240,

      // Minimum gap between successive triggers in the same
      // direction. Default: 60ms.
      cooldownMs: 60,
    }),
  ],
});
```

#### Companion editor methods

`infiniteScrollPlugin` is generic — it doesn't know what blocks you want to load. The callbacks mutate the editor through two new methods on `Editor`:

- **`editor.appendBlocks(specs)`** — append at the end of the doc. Returns the assigned block ids.
- **`editor.prependBlocks(specs)`** — prepend at the start. The infinite-scroll plugin's prepend path captures `scrollHeight + scrollTop` *before* the call and re-applies the delta after the renderer commits, so the viewport stays anchored.

Both methods preserve the identity of every existing block (no `setDoc` rebuild), so blocks already on screen don't re-render and the caret stays put. `id` is optional on each spec — the editor generates one when missing.

```ts
const ids = editor.appendBlocks([
  { type: "date-marker", date: "2026-05-09" },
  { type: "p", runs: [] },
]);
```

#### Live showcase

A complete journal-style demo combining `calendarPlugin` + `infiniteScrollPlugin` lives at [non-editable blocks](#/non-editable-blocks). Open the page, scroll up or down, and watch the timeline grow without the viewport jumping.

### `searchPlugin`

In-page find. Mounts a small floating panel (top-right) and — when configured — claims `Cmd+F` / `Ctrl+F` so the browser's native find UI doesn't open. Matches are highlighted via the **CSS Custom Highlight API** (no DOM mutation) and the active match scrolls into view, including for blocks that virtualization has unmounted.

```ts
import { createEditor, searchPlugin } from "creo-edit";

createEditor({
  plugins: [
    searchPlugin({
      // Claim Mod+F. Default: false (keep the browser's find).
      interceptBrowserFind: true,

      // Pick which match-options the UI exposes, plus initial values.
      // Omitted toggles are off and hidden.
      toggles: {
        caseSensitive: { initial: false, show: true },
        wholeWord:     { initial: false, show: true },
        regex:         { initial: false, show: false },
      },

      // Debounce on input change. Default: 80.
      debounceMs: 80,
    }),
  ],
});
```

#### Works with virtualization

When `virtualized: true` is set on the editor, blocks outside the viewport are unmounted from the DOM. The plugin still searches them — the scan is over `docStore`, not the DOM — and uses the new `editor.scrollToBlock(id)` to jump to off-screen matches. The block re-mounts on scroll and gets highlighted on the next paint.

#### Works with infinite scroll

Out of the box, the plugin only searches blocks currently loaded in `docStore`. For backends where the host loads chunks lazily, supply a `source`:

```ts
searchPlugin({
  interceptBrowserFind: true,
  source: {
    async search(query, opts) {
      const rows = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json());
      // Return SearchMatch[] — start/end anchors with paths matching the
      // block kind (text-bearing: [charOffset]; table: [r,c,offset]; ...)
      return rows.map((r) => ({
        blockId: r.blockId,
        start: { blockId: r.blockId, path: [r.start], offset: r.start },
        end:   { blockId: r.blockId, path: [r.end],   offset: r.end },
        snippet: r.snippet,
      }));
    },
    // Called on jump-to-match for blocks not currently in docStore.
    // The host should load the chunk that contains the block and resolve
    // when the block lands in docStore.
    async ensureLoaded(blockId) {
      await myStore.loadChunkContaining(blockId);
    },
  },
});
```

#### Custom UI

Pass `renderUI` to replace the default panel. The callback gets a controller (subscribe / setQuery / next / prev / setToggle / close) and a host element to render into:

```ts
searchPlugin({
  interceptBrowserFind: true,
  renderUI(controller, host) {
    // ...your DOM here...
    const unsub = controller.subscribe(() => { /* re-render */ });
    return () => { unsub(); /* remove your DOM */ };
  },
});
```

The default panel ships with base CSS that respects `prefers-color-scheme`. Override the `--creo-search-bg`, `--creo-search-fg`, `--creo-search-border`, and `--creo-search-input-bg` custom properties to restyle without writing your own UI.

#### Companion editor method

`editor.scrollToBlock(blockId, { block?: "start" | "center" | "end" | "nearest" })` is exposed for any host code that wants to focus a specific block — permalinks, "jump to comment", etc. Works for both virtualized and non-virtualized editors.

## Composing plugins

Order matters in two places:

1. **HTML parser tag matching** (built-in HTML codecs first, then user plugins). If two plugins both register `parseHTML` for `<table>`, the first one wins.
2. **Plugin keymap precedence** (registration order, first match wins). If two plugins both register `Tab`, the first one's `when` predicate gets a shot first.

Otherwise plugins compose freely. Decorations from multiple plugins all attach to the same block; triggers from multiple plugins each get a chance at every text input.
