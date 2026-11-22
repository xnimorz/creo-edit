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

Pasting is wired automatically. The clipboard handler tries `text/html` first; if absent, it falls back to `text/plain`. Both go through the same parser as `setDocFromHTML`, then the result is inserted at the caret (replacing any selected range). The paste is dispatched as the built-in `{ t: "pasteBlocks", blocks }`, so it is one undo step, it reaches `onChange` subscribers, and a read-only editor refuses it.

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
| `<pre>` | `code` (the language from a `language-…` class) |
| `<blockquote>` | `blockquote` (with `blockquotePlugin`) |
| `<hr>` | `hr` (with `horizontalRulePlugin`) |
| `<a href>` | `link` mark |
| `<strong>`, `<b>` | `b` mark |
| `<em>`, `<i>` | `i` mark |
| `<u>` | `u` mark |
| `<s>`, `<strike>`, `<del>` | `s` mark |
| `<code>` | `code` mark |
| `<br>` | newline character within the current block |

Plugin blocks claim their own tags through `BlockDef.htmlCodec`. Anything else (divs, spans with classes, custom elements, scripts, styles) is either flattened into its text content or dropped.

## Keeping elements the parser does not know

`setDocFromHTML(html, { claimElement })` (and `parseHTML`) asks `claimElement(el)` about every element it reaches at block level, before its own handling. Return a block in wire form to keep the element whole as that block, or `null` to let the parser go on:

```ts
editor.setDocFromHTML(html, {
  claimElement: (el) =>
    el.hasAttribute("data-island") ? { type: "island", key: el.id, html: el.outerHTML } : null,
});
```

That is how a host keeps a chart, a card grid or a widget as one block (an `embedPlugin` type, say) instead of having it flattened into paragraphs. The element has already been sanitized, so its scripts and handlers are gone; a host that needs the original markup byte for byte splits the source itself.

## Saving

To JSON for storage:

```ts
const doc = editor.toJSON();   // SerializedDoc — JSON-safe, lossless through createEditor({ initial: doc })
```

To HTML, when another tool needs markup:

```ts
import { docToHtml } from "creo-edit";

const html = docToHtml(editor.toJSON());   // or docToHtml(editor.docStore.get())
```

`docToHtml` writes the same markup a copy puts on the clipboard: one element per block, lists grouped, each plugin block through its `htmlCodec.serializeHTML`. A block with no HTML codec writes nothing.

## Sanitization

The HTML parser strips scripts, event handlers, and styles by construction — it walks the tag set above and ignores everything else. That said, if you store user-pasted content and re-render it elsewhere, sanitize at the rendering boundary too. The parser is not a substitute for output-side sanitization.
