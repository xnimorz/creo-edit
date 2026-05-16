# Getting Started

## Install

```bash
bun add creo creo-edit
# or: npm install creo creo-edit
# or: pnpm add creo creo-edit
# or: yarn add creo creo-edit
```

`creo-edit` has a peer dependency on `creo` (≥ 0.2.6). No other runtime dependencies. Ships as ESM with TypeScript types.

## Minimal app

```ts
import { createApp, HtmlRender } from "creo";
import { createEditor } from "creo-edit";

const editor = createEditor();

createApp(
  () => editor.EditorView(),
  new HtmlRender(document.querySelector("#app")!),
).mount();
```

That gives you a single empty paragraph the user can type into. The editor manages its own input pipeline, selection, history, and rendering — you only need to mount it.

## Inside React, Vue, Svelte, Solid, …

The editor renders through Creo's `HtmlRender`, which mounts into any DOM element. To embed it inside a host framework, give Creo a container element managed by that framework and let it own the contents from there. The editor does not have a React (or Vue, Svelte, Solid) wrapper package — you write the ten-line bridge once.

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

**Svelte 5 / Solid / anything with a DOM ref**: same pattern — wait for the container to be mounted, call `createApp(...).mount()`, call `app.unmount()` on teardown.

The editor handle (`createEditor()` return value) is plain JS — exposing `editor.dispatch`, `editor.toJSON`, `editor.docStore`, etc. from inside a hook / composable is straightforward. Nothing about commands, history, or serialization is Creo-specific.

## Loading initial content

`createEditor` accepts an `initial` document in its serialized form:

```ts
const editor = createEditor({
  initial: {
    blocks: [
      { type: "h1", runs: [{ text: "Welcome" }] },
      {
        type: "p",
        runs: [
          { text: "Try editing " },
          { text: "this", marks: ["b"] },
          { text: "." },
        ],
      },
      {
        type: "li",
        ordered: false,
        depth: 0,
        runs: [{ text: "List item" }],
      },
    ],
  },
});
```

Block types are `p`, `h1` … `h6`, `li`, `img`, `table`, and `columns`. See [Editor API](#/editor-api) for the full `SerializedDoc` shape.

## A toolbar

The editor doesn't ship a toolbar — you build one with whatever component model you prefer. The pattern is: a button calls `editor.dispatch()`, then `editor.focus()` so the editor regains keyboard input.

```ts
import { view, button } from "creo";

const Toolbar = view(() => ({
  render() {
    button(
      {
        on: {
          click: (e) => {
            e.preventDefault();
            editor.dispatch({ t: "toggleMark", mark: "b" });
            editor.focus();
          },
        },
      },
      "B",
    );
    button(
      {
        on: {
          click: (e) => {
            e.preventDefault();
            editor.dispatch({ t: "setBlockType", payload: { type: "h2" } });
            editor.focus();
          },
        },
      },
      "H2",
    );
  },
}));
```

The `e.preventDefault()` keeps the button click from stealing focus from the editor. See [Commands](#/commands) for the full list of dispatchable actions.

## Reading content out

```ts
const json = editor.toJSON();          // SerializedDoc — JSON-safe
localStorage.setItem("draft", JSON.stringify(json));
```

To round-trip from arbitrary HTML (paste source, server-stored markup):

```ts
editor.setDocFromHTML("<h1>Hello</h1><p>World</p>");
```

See [HTML interop](#/html-interop) for what's supported on the way in and out.

## Undo, redo, focus

```ts
editor.undo();
editor.redo();
editor.focus();   // moves keyboard focus to the editor
editor.blur();    // releases it
```

Undo coalescing groups consecutive same-tag commands into a single step (so a string of typing is one undo, not one-per-character). See [Commands](#/commands#history-and-coalescing) for which commands coalesce.

## Styles

The editor produces a small set of class names (`.creo-edit`, `.ce-block`, `.ce-h1` …). It does not ship CSS — you style them yourself. The simplest starting point is to copy the `ed-demo` and `.ce-*` rules from this docs site's [`docs/src/styles.css`](https://github.com/xnimorz/creo-editor/blob/main/docs/src/styles.css) into your own stylesheet and adjust.

Two CSS rules are non-negotiable on the editor root, set automatically by the editor:

- `white-space: pre-wrap` — without this, trailing spaces collapse visually but not in the model, so typing space at end-of-line silently fails to render.
- `cursor: text` — standard text-editor UX.

## Next

- **[Editor API](#/editor-api)** — full `EditorOptions` and `Editor` handle.
- **[Commands](#/commands)** — every dispatchable action.
- **[Demo](#/demo)** — the editor with a full toolbar wired up.
