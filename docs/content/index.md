# Creo Editor

A row-based, no-`contentEditable` rich-text editor built on top of the [Creo](https://github.com/xnimorz/creo) UI framework.

## What it is

Most browser-based rich-text editors lean on `contentEditable` — let the browser own a region of the DOM, then translate its mutations back into a model. That works, but the gap between "what the browser does" and "what your model says" is full of edge cases: selection drift, paste sanitization, IME composition, undo coalescing, mobile keyboards.

Creo Editor takes the other path. Every block is a row in a plain JavaScript model. Keystrokes, IME composition, and clipboard events come from a hidden `<textarea>`. The visible document is rendered output — `contentEditable` is never set anywhere.

The result is an editor where the model is always the source of truth, every keystroke is a deterministic dispatch, and per-block render cost is independent of document size.

## Highlights

- **No `contentEditable`.** A hidden `<textarea>` captures keystrokes, IME composition, mobile soft keyboards, and clipboard.
- **Cursor lives outside the document state.** Typing into a block doesn't dirty selection subscribers, and vice versa.
- **CRDT-friendly row ordering** via base-62 fractional indexing — insert-between is O(log n), no renumber.
- **Per-keystroke render cost is O(1) blocks** — block immutability + `shouldUpdate` identity checks make the keyed reconciler skip every untouched block.
- **Optional virtualization** — only blocks intersecting the viewport are mounted; documents with hundreds of thousands of blocks remain responsive.
- **First-class mobile UX** — caret-following hidden input, `visualViewport` tracking, custom selection handles, and a floating toolbar.

## A taste

```ts
import { createApp, HtmlRender } from "creo";
import { createEditor } from "creo-editor";

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

That's the minimum to put a working editor on the page. From there, you wire `editor.dispatch()` to your own toolbar, undo/redo to whatever buttons or chords you want, and `editor.toJSON()` to your save flow.

## Where to next

- **[Try it](#/demo)** — the live editor, full-page.
- **[Getting Started](#/getting-started)** — install, render, load content.
- **[Editor API](#/editor-api)** — the `Editor` handle and its options.
- **[Commands](#/commands)** — every action, in one place.
- **[Architecture](#/architecture)** — how the pieces fit together.
