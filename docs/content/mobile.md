# Mobile

The editor is mobile-first by design. Most of what makes mobile rich-text painful — soft-keyboard occlusion, IME composition, iOS auto-zoom on focus, selection handles, the missing browser-native context menu — is handled inside the editor with no opt-in required.

## What's already wired

### Hidden textarea positioned at the caret

iOS's "scroll the focused input into view" behavior targets the textarea's bounding box, not the caret. If the textarea sat off-screen, the page would scroll to wherever the textarea was — useless. So the textarea is repositioned to track the caret on every selection change. The page scrolls to the right place, the keyboard opens, the user types where they expect.

### `font-size: 16px` on the textarea

iOS Safari auto-zooms when an input with `font-size < 16px` gains focus. The textarea is hidden, but it's still focusable, and the auto-zoom still fires. Sizing it at 16px suppresses the zoom. The DOCUMENT'S editor font is unaffected — `mode: "mono"` and your own CSS still take effect on the visible blocks.

### `visualViewport` tracking

When the soft keyboard opens, it shrinks the visual viewport without changing the layout viewport — meaning a caret that was visible can end up underneath the keyboard. The editor listens for `visualViewport` resize/scroll events and scrolls the editor container to keep the caret in view.

### Custom selection handles

Native selection handles only render on `contentEditable` content. Since the editor isn't `contentEditable`, the editor draws its own handles via `SelectionHandles` (mounted automatically by `EditorView`). Drag them to extend the selection — same UX as native, no native infrastructure.

### Mobile toolbar

The native iOS / Android selection callout (Copy / Paste / Look Up) only appears over `contentEditable` text. The editor replaces this with `MobileToolbar` — a floating bar that pops up over a non-empty range selection, with Copy / Cut / Paste / Bold / Italic / Select All. It's mounted by `EditorView` automatically; the labels and actions are hard-coded but the implementation is straightforward to fork (`src/render/MobileToolbar.ts`).

### Tap / scroll / long-press classifier

`pointerdown` on a touch surface is ambiguous — is it a tap to place the caret, or the start of a scroll? The input pipeline classifies based on movement threshold and time, so tapping places a caret, dragging scrolls, and long-press starts a selection drag.

## Detecting touch at runtime

The package exports a small helper:

```ts
import { isCoarsePointer } from "creo-editor";

if (isCoarsePointer()) {
  // mobile / touch-first UX — show your toolbar's mobile variant, etc.
}
```

It's a thin wrapper over `matchMedia("(pointer: coarse)")` — use it for branching your own UI, not anything inside the editor (the editor branches internally).

## Things you should still do

The editor handles input. Layout is on you:

- **Give the editor enough vertical room.** A short, scrollable container plus the soft keyboard can leave only a line or two visible. Either let the editor fill the screen, or wire your own viewport-aware sizing.
- **Don't put `position: fixed` toolbars in the natural visual-viewport zone the keyboard occupies** unless you're tracking `visualViewport.height` yourself — same trap as any web app.
- **`width=device-width, initial-scale=1, maximum-scale=1`** in your `<meta name="viewport">` if you want to fully suppress pinch-zoom around the editor. (Without `maximum-scale=1`, iOS users can still pinch-zoom the page, which interacts oddly with the editor's own caret tracking.)

## What's intentionally not handled

- **Custom on-screen keyboards** (e.g. an emoji picker mounted by your app). If they steal focus from the textarea, dispatching `editor.focus()` afterwards restores it.
- **Spellcheck / autocorrect.** The textarea is hidden so the OS-level spellcheck UI doesn't see it. If you want to mark suggestions in the editor, you'd build that on top of `docStore` and dispatch your own commands.
