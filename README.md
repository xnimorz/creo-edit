# creo-edit

A text editor framework, based on [Creo](https://github.com/xnim/creo). Row-based rich-text editing on a controlled `contentEditable`. Mountable inside any framework that gives you a DOM ref (React, Vue, Svelte, Solid) — see [Hosting inside other frameworks](#hosting-inside-other-frameworks).

## Highlights

- **Cursor lives outside the document state** — typing into a block doesn't dirty selection subscribers, and vice versa.
- **CRDT-friendly row ordering** via base-62 fractional indexing — insert-between is O(log n), no renumber.
- **Controlled `contentEditable`** — native browser selection and IME, with every `beforeinput` intercepted and translated into a command. The model is the source of truth.
- **Per-keystroke render cost is O(1) blocks** — block immutability + `shouldUpdate` identity checks make the keyed reconciler skip every untouched block.
- **Optional virtualization** — only blocks intersecting the viewport are mounted; documents with hundreds of thousands of blocks remain responsive.
- **First-class mobile support** — native long-press OS menu, native selection handles, IME composition reconciled into a single undo step, `visualViewport`-aware caret-keeping.

## Install

```bash
bun add creo creo-edit
```

## Quick start

```ts
import { createApp, HtmlRender } from "creo";
import { createEditor } from "creo-edit";

const editor = createEditor({
  initial: {
    blocks: [
      { type: "h1", runs: [{ text: "Hello" }] },
      { type: "p", runs: [{ text: "Type here." }] },
    ],
  },
});

createApp(
  () => editor.EditorView(),
  new HtmlRender(document.querySelector("#app")!),
).mount();
```

## Hosting inside other frameworks

The editor renders through Creo's `HtmlRender`, which mounts into any DOM element. Embed it inside a host framework by giving Creo a container element managed by that framework. There is no React/Vue/Svelte wrapper package — you write the ten-line bridge once.

**React**

```tsx
import { useEffect, useRef } from "react";
import { createApp, HtmlRender } from "creo";
import { createEditor } from "creo-edit";

export function CreoEdit() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const editor = createEditor();
    const app = createApp(
      () => editor.EditorView(),
      new HtmlRender(ref.current),
    ).mount();
    return () => app.unmount?.();
  }, []);
  return <div ref={ref} />;
}
```

**Vue 3**

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { createApp as creoApp, HtmlRender } from "creo";
import { createEditor } from "creo-edit";

const host = ref<HTMLElement | null>(null);
let app: ReturnType<typeof creoApp> | null = null;
onMounted(() => {
  const editor = createEditor();
  app = creoApp(() => editor.EditorView(), new HtmlRender(host.value!)).mount();
});
onBeforeUnmount(() => app?.unmount?.());
</script>

<template>
  <div ref="host" />
</template>
```

**Svelte 5 / Solid / anything with a DOM ref**: same pattern — wait for the container to be mounted, call `createApp(...).mount()`, call `app.unmount()` on teardown. The `editor` handle (`createEditor()` return value) is plain JS; exposing `editor.dispatch`, `editor.toJSON`, `editor.docStore`, etc. from inside a hook / composable is straightforward.

## Editor API

```ts
type Editor = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  dispatch(cmd: Command): void;
  undo(): void;
  redo(): void;
  EditorView: PublicView<EditorViewProps, void>;
  setDocFromHTML(html: string): void;
  toJSON(): SerializedDoc;
  focus(): void;
  blur(): void;
};
```

### Commands

- `insertText`, `deleteBackward`, `deleteForward` — text editing
- `splitBlock`, `mergeBackward`, `mergeForward` — structural
- `setBlockType` — promote/demote between paragraph, headings, list items
- `toggleMark` — bold, italic, underline, strikethrough, code
- `toggleList`, `indentList`, `outdentList`
- `insertImage`, `insertTable`
- `tableInsertRow/Col`, `tableRemoveRow/Col`
- `moveCursor`

### Default keybindings

| Chord | Action |
|---|---|
| `Cmd/Ctrl+B` / `+I` / `+U` | Toggle bold / italic / underline |
| `Cmd/Ctrl+Shift+S` | Strikethrough |
| `Cmd/Ctrl+Z` / `+Shift+Z` | Undo / redo |
| `Cmd/Ctrl+Alt+1..6` | Heading levels |
| `Cmd/Ctrl+Alt+0` | Paragraph |
| `Tab` / `Shift+Tab` | List indent / outdent (or table cell nav) |
| `Enter` / `Backspace` / `Delete` | Split / merge blocks |
| Arrows / `Home` / `End` | Caret navigation (extend with `Shift`) |

### Virtualization (large documents)

```ts
const editor = createEditor({
  initial: { blocks: [...] },
  virtualized: true,
  virtualEstimatedHeight: 32,
});
```

Only blocks intersecting `[scrollTop − overscan, scrollTop + viewport + overscan]` are mounted, with measured per-block heights stored in a Fenwick tree for O(log n) viewport resolution.

### Image upload

```ts
const editor = createEditor({
  uploadImage: async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/upload", { method: "POST", body: fd });
    return (await res.json()).url;
  },
});
```

Without `uploadImage`, dropped/pasted images use `URL.createObjectURL`.

### Mobile

`creo-edit` ships first-class mobile support. The editor root is a `contentEditable`, so the OS long-press menu, native selection handles, IME composition, and autocorrect work out of the box. `visualViewport` tracking exposes `--creo-vv-height` and `--creo-vv-top` as CSS custom properties so host pages can position floating UI above the soft keyboard, and scrolls the caret into the upper third of visible space when the keyboard opens.

## Architecture

See `AGENTS.md` in the repo root for engine-level notes. The editor is a pure consumer of Creo's public API — `view`, `use`, `store`, primitive functions — and uses raw DOM listeners only for events Creo's event map doesn't expose (composition, drag/drop, clipboard, visualViewport).

## License

MIT
