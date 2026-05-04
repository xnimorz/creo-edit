# HTML interop

Creo Editor isn't an HTML editor — its model is structured blocks with inline runs. But it ships an HTML parser and serializer for the two flows where HTML is unavoidable: pasting from the web, and bootstrapping from server-stored markup.

## Loading HTML

```ts
editor.setDocFromHTML(`
  <h1>Hello</h1>
  <p>This is a <strong>paragraph</strong>.</p>
  <ul>
    <li>One</li>
    <li>Two</li>
  </ul>
`);
```

Replaces the entire document, resets the selection to the end, and clears the undo stack. Use this to bootstrap an editor from server-rendered content, NOT for incremental edits — for incremental edits, dispatch commands instead.

## Pasting

Pasting is wired automatically. The clipboard handler tries `text/html` first; if absent, it falls back to `text/plain`. Both go through the same parser as `setDocFromHTML`, then the result is inserted at the caret (replacing any selected range) — this path goes through the regular dispatch flow, so paste IS undoable.

Images on the clipboard or dropped onto the editor go through `EditorOptions.uploadImage` if you provide one; otherwise, `URL.createObjectURL(file)` is used so the image renders immediately but the URL is local-only.

## What survives the round-trip

The parser maps a small, opinionated subset of HTML onto the block model:

| HTML | Block / inline |
|---|---|
| `<h1>`…`<h6>` | `h1`…`h6` |
| `<p>` | `p` |
| `<ul><li>`, `<ol><li>` | `li` (with `ordered` and `depth` from nesting) |
| `<img src=… alt=… width=… height=…>` | `img` |
| `<table><tr><td>` | `table` |
| `<strong>`, `<b>` | `b` mark |
| `<em>`, `<i>` | `i` mark |
| `<u>` | `u` mark |
| `<s>`, `<strike>`, `<del>` | `s` mark |
| `<code>` | `code` mark |
| `<br>` | newline character within the current block |

Anything else (divs, spans with classes, custom elements, `<a>`, `<blockquote>`, `<pre>`, scripts, styles) is either flattened into its text content or dropped. This is intentional — the editor's block taxonomy is fixed; the parser doesn't try to invent new block types.

## Saving

Going the other way — to JSON, not HTML:

```ts
const doc = editor.toJSON();   // SerializedDoc — JSON-safe
fetch("/save", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(doc),
});
```

JSON round-trips losslessly through `createEditor({ initial: doc })`. We don't ship a "to HTML" serializer for the document — most consumers either store JSON (cheap, lossless, easy to migrate) or render to HTML themselves from the JSON via whatever templating they prefer.

The internal HTML serializer (`htmlSerializer.ts`) IS used for clipboard copy/cut, so dragging selected text out of the editor produces a sensible `text/html` payload for other apps.

## Sanitization

The HTML parser strips scripts, event handlers, and styles by construction — it walks the tag set above and ignores everything else. That said, if you store user-pasted content and re-render it elsewhere, sanitize at the rendering boundary too. The parser is not a substitute for output-side sanitization.
