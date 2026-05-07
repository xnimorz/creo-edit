# Mobile

The editor is mobile-first by design. Soft-keyboard tracking, IME, the OS context menu on long-press, and native selection handles all work without opt-in — they're delivered by the browser through the editor's `contentEditable` root.

## What's already wired

### Native selection + IME + OS context menu

The editor root is `contenteditable="true"`. Tapping places the caret, long-press summons the OS Copy / Paste / Look Up menu, the native selection handles work for free. IME composition (Gboard swipe-typing, iOS dictation, Pinyin, Kana) flows through the browser's compositionstart / compositionend events and reconciles into one undo step.

### `visualViewport` tracking

When the soft keyboard opens, it shrinks the *visual* viewport without changing the *layout* viewport — a caret that was visible can end up underneath the keyboard. The editor listens for `visualViewport` resize/scroll events, exposes `--creo-vv-height` and `--creo-vv-top` as CSS custom properties, and scrolls the editor container to keep the caret in view.

### Atomic image blocks

Image blocks render as `contenteditable="false"` islands so the native caret skips over them rather than landing inside the `<img>`. Backspace on an image block deletes it.

## Detecting touch at runtime

The package exports a small helper:

```ts
import { isCoarsePointer } from "creo-edit";

if (isCoarsePointer()) {
  // mobile / touch-first UX — show your toolbar's mobile variant, etc.
}
```

It's a thin wrapper over `matchMedia("(pointer: coarse)")` — use it for branching your own UI.

## Things you should still do

The editor handles input. Layout is on you:

- **Give the editor enough vertical room.** A short, scrollable container plus the soft keyboard can leave only a line or two visible. Either let the editor fill the screen, or wire your own viewport-aware sizing.
- **Don't put `position: fixed` toolbars in the natural visual-viewport zone the keyboard occupies** unless you're tracking `visualViewport.height` yourself — same trap as any web app. The editor exposes `--creo-vv-height` so your toolbar can sit above the keyboard with a single CSS rule.
- **`width=device-width, initial-scale=1, maximum-scale=1`** in your `<meta name="viewport">` if you want to fully suppress pinch-zoom around the editor.

## Spellcheck and autocorrect

`spellcheck` is set to `"false"` on the editor root by default. If you want native spellcheck and autocorrect — which most rich-text editors *do* on mobile — set it back to `"true"` after construction:

```ts
const editor = createEditor({ ... });
// after the editor mounts:
const root = document.querySelector("[data-creo-edit]");
root?.setAttribute("spellcheck", "true");
```

A future option will expose this directly. For now, the override above is the recommended path.
