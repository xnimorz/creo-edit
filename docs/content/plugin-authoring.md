---
title: "Authoring plugins"
slug: "plugin-authoring"
---

# Authoring plugins

A plugin is a bag of optional contributions:

```ts
type EditorPlugin = {
  name: string;
  blocks?: BlockDef[];
  commands?: CommandDef[];
  keymap?: KeymapDef[];
  triggers?: TriggerDef[];
  decorations?: DecorationDef[];
  rangeDecorations?: RangeDecorationDef[];
  inlineWidgets?: InlineWidgetDef[];
};
```

You install a plugin by passing it in `EditorOptions.plugins`:

```ts
import { createEditor, slashCommandsPlugin } from "creo-edit";

const editor = createEditor({
  plugins: [slashCommandsPlugin()],
});
```

User plugins are installed AFTER the built-ins (paragraph, heading, list, code, image, cells), so registration order is: built-ins → user plugins. For HTML tag matching, first registration wins.

## Tutorial: an `@mention` trigger

A trigger watches text input for a pattern and opens UI when matched. Mentions are the canonical example: type `@`, get a popover of users, pick one, dispatch a command.

```ts
import type { EditorPlugin, TriggerDef } from "creo-edit";

const users = ["alice", "bob", "carol"];

const mentionTrigger: TriggerDef = {
  match: "@",
  open(ctx) {
    const popover = document.createElement("div");
    popover.className = "my-mention-popover";
    document.body.appendChild(popover);
    const rect = ctx.caretRect();
    if (rect) {
      popover.style.position = "fixed";
      popover.style.left = `${rect.left}px`;
      popover.style.top = `${rect.bottom + 4}px`;
    }

    let query = "";
    const render = () => {
      popover.innerHTML = "";
      const matches = users.filter((u) => u.startsWith(query));
      for (const u of matches) {
        const item = document.createElement("div");
        item.textContent = `@${u}`;
        item.style.padding = "4px 8px";
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          ctx.dispatch({ t: "insertText", text: `${u} ` });
          close();
        });
        popover.appendChild(item);
      }
    };
    render();

    const close = () => popover.remove();

    return {
      onTextChange(q) {
        query = q;
        render();
      },
      onKey(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          const first = users.filter((u) => u.startsWith(query))[0];
          if (first) ctx.dispatch({ t: "insertText", text: `${first} ` });
          close();
          return true;
        }
        return false;
      },
      close,
    };
  },
};

export const mentionPlugin: EditorPlugin = {
  name: "mention",
  triggers: [mentionTrigger],
};
```

Then:

```ts
const editor = createEditor({ plugins: [mentionPlugin] });
```

Type `@al` and the popover filters to `alice`. Press Enter or click and the editor inserts `alice ` at the caret.

## Other contribution kinds

- **Block kinds** — see [block-format](#/block-format) for the wire shape, then provide a `BlockDef` with `view`, `runsAt` (only if the block holds nested runs), `anchorCodec`, `htmlCodec`, and `serializeCodec`. The built-in `cellsPlugin` ([source](https://github.com/...)) is the worked example.
- **Commands** — `{ t: "myPlugin.action", run: (ctx, payload) => { ... } }`. Dispatch via `editor.dispatch({ t: "myPlugin.action", payload })`.
- **Keymap** — `{ chord: "Mod+Shift+K", when?: ctx => ..., command: { t, payload? } }`. Plugin keymap entries are matched BEFORE the built-in keymap; the first matching entry whose `when` returns true (or which has no `when`) wins. If the dispatched command returns `false`, the matcher falls through to subsequent entries (so plugin commands can no-op without consuming the key).
- **Decorations** — overlay UI per block (or per line — see below). See the next page.

### Commands and read-only editors

Every plugin command is refused while `editor.isEditable()` is false. Commands that only move the caret or open UI opt back in:

```ts
{ t: "myPlugin.nextCell", readOnlySafe: true, run: (ctx) => { /* ... */ } }
```

Gated commands return `false` rather than throwing, so keymap fall-through keeps working and the browser still gets its default handling of the key.

## Sub-block decorations (per-line gutters)

`DecorationDef.targets` picks the elements *within* a block to anchor against. Omit it and you get one decoration per block, exactly as before. Return the block's line elements and you get a per-line gutter — line numbers, diff signs, diagnostics, fold arrows:

```ts
const lineNumbers: DecorationDef = {
  id: "line-numbers",
  layer: "left",
  slotWidth: 40,        // gutter width in px (default 24)
  uniformTargets: true, // every target is the same height — see below
  match: (b) => b.type === "code",
  targets: (_block, blockEl) =>
    Array.from(blockEl.querySelectorAll<HTMLElement>(".ce-code-line")),
  mount(block, target, host, handle, index) {
    host.textContent = String(index + 1);
  },
};
```

`mount` receives the anchored `target` (the block element when `targets` is omitted) and the `index` within `targets()`. Decorations are added and removed as targets come and go, so editing a code block keeps the gutter in step.

Repositioning runs on rAF against `getBoundingClientRect`. With ~500 visible lines that is 500 layout reads a frame. Set `uniformTargets: true` when every target has the same height and they stack contiguously — the manager then measures only `targets()[0]` and derives the rest arithmetically.

## Range decorations

Comment ranges, diagnostic squiggles, word-level diff and selection highlights all overlap each other *and* overlap whatever run structure the model already has. Expressing them as DOM would mean splitting spans and fighting the token model, so they're painted with the CSS Custom Highlight API instead — zero DOM mutation:

```ts
const diagnostics: EditorPlugin = {
  name: "diagnostics",
  rangeDecorations: [
    {
      id: "lsp-error",
      className: "my-lsp-error",   // styled via ::highlight(my-lsp-error)
      priority: 10,                // higher wins where ranges overlap
      ranges(doc, viewport) {
        // viewport is { firstBlock, lastBlock } of the mounted window, or
        // null when nothing is mounted. Return only what intersects it on
        // a large document.
        return currentDiagnostics.map((d) => ({ from: d.start, to: d.end }));
      },
    },
  ],
};
```

```css
::highlight(my-lsp-error) {
  text-decoration: underline wavy red;
}
```

Sources are re-run on document change, scroll / resize, and block mount / unmount (virtualization). Call `editor.refreshRangeDecorations()` when the state the source reads changed on its own — it is coalesced into the next animation frame, so calling it from a view lifecycle hook (the natural place, since that's where you learn your diagnostics moved) keeps the repaint off the keystroke's own task and N calls in a frame cost one repaint. `refreshRangeDecorationsSync()` is there for the rare caller that must observe the painted highlights before it returns.

Highlight names are document-global, so namespace `className` when more than one editor is on the page.

### Scoping a source to what's on screen

`ranges(doc, viewport)` is asked for "only what intersects `viewport`", and `viewport.firstBlock` / `lastBlock` express that fine for a normal document. They express nothing for a document that *is* one block — a whole file in one `code` block, where both are the same constant and a tokenizer would have to hand over every token range in the file to paint the fifty lines on screen.

`viewport.windowIn(blockId)` closes that gap. It returns the visible half-open character window `{ from, to }` inside a block that renders measurable sub-items (code-block lines today), or `null` when the block is fully mounted, isn't measurable, or the environment has no layout — `null` means "no window, return everything", not "return nothing".

```ts
ranges(doc, viewport) {
  const all = this.tokenRanges(doc);
  const win = viewport?.windowIn?.(doc.order[0]);
  if (!win) return all;
  return all.filter((r) => r.to.offset > win.from && r.from.offset < win.to);
}
```

The manager adds a viewport of slack either side, so scrolling doesn't expose unpainted text before the next repaint lands.

### Custom code-block views

The built-in `code` view publishes each line's model start offset as `data-line-start` (exported as `LINE_START_ATTR`). That is what lets the anchor codec binary-search for the line owning an offset instead of walking every line and summing lengths — the difference between a repaint that scales with the number of tokens and one that scales with tokens × lines.

A host rendering its own code-block view stays correct without it (the codec falls back to the walk), but should emit it on every line to keep the fast path.

**No fallback.** Where the API is unavailable, nothing is painted — a DOM fallback would have to split spans, which the character-offset walk would then see. Branch on `editor.supportsRangeDecorations()` and render your own affordance (a gutter marker via a sub-block decoration, say) rather than assuming a paint happened.

## Inline widgets

Custom blocks are block-level, and non-text ones must be `isAtomic` — two caret positions and `contenteditable="false"` around the whole thing. That's an island *between* blocks. Ghost-text completions and LSP inlay hints need content *inside* a line, which cannot be faked with a styled span: the span's text would enter the character-offset walk and shift every anchor after it on the line.

```ts
const inlayHints: EditorPlugin = {
  name: "inlay-hints",
  inlineWidgets: [
    {
      id: "inlay",
      affinity: "after",   // ordering when several widgets share an anchor
      interactive: false,  // inert, so clicks land on the text underneath
      at(doc, viewport) {
        return hints.map((h) => ({ anchor: h.anchor, data: h.label }));
      },
      mount(host, ctx) {
        host.textContent = String(ctx.data);
        return () => { /* optional cleanup */ };
      },
    },
  ],
};
```

The host span you're handed already carries `data-ce-inline-widget` and `contenteditable="false"`. **Do not remove either** — they are what makes the widget invisible to:

1. **The character-offset walk.** The default and code-block anchor codecs skip subtrees carrying the attribute. A custom `anchorCodec` must honour it too (`INLINE_WIDGET_ATTR` is exported), or widgets in that block will shift every anchor after them.
2. **IME composition diffing.** The composition diff reads the affected scope through `visibleTextOf`, which strips widget subtrees. Without it a multi-line ghost-text suggestion would read as a phantom insertion.
3. **Clipboard serialization.** Free: the serializer works from the model, and widgets are not in the model.

`contenteditable="false"` handles the browser side of caret navigation — arrow keys step over an atomic inline — but none of the three above, which are creo-edit's own logic.

Sources are re-run on document change, selection change (ghost text tracks the caret) and viewport change. Call `editor.refreshInlineWidgets()` when a completion arrives from elsewhere. Widgets whose block isn't mounted are retried on a later pass.

The renderer owns block DOM and rewrites a run's text wholesale when it changes, which discards any widget inside it; the manager re-places it on the same tick, reusing the existing host so widget-internal state survives an unrelated keystroke.

## Lifecycle

Plugins are stateless: their contributions are registered once at `createEditor` time and live for the editor's lifetime. State that needs to track per-instance data (an active popover, a hover store) lives inside the contribution itself — usually as a closure around the `open()` or `mount()` function.
