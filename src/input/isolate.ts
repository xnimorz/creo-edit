// ---------------------------------------------------------------------------
// isolateInput — keep a form control's own events away from the editor.
//
// The editor listens on its whole root: `beforeinput` is cancelled and turned
// into a command, `keydown` runs the keymap, the clipboard handlers read the
// model. A text field rendered INSIDE a block (a card's title, a diagram's
// source) sits under that root, so its keystrokes would be taken for the
// document's — typing in it would do nothing, or edit the wrong thing.
//
// The fix is for the field to handle its events natively where they start and
// stop them there. cront.app has done exactly this for the fields in its cards
// since they were added; this is that helper, in the library that makes it
// necessary.
//
// Two consequences worth knowing:
//  - creo delegates its event handlers from the app root, ABOVE the editor, so
//    a handler attached through creo props never fires for an isolated node.
//    Use `addEventListener` on the node itself.
//  - `Mod+Z` inside the field is the browser's own undo of the field's text,
//    not the editor's. That is what a user editing a field expects.
// ---------------------------------------------------------------------------

/** Every event type the editor's input pipeline listens for on its root. */
export const ISOLATED_EVENTS = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "paste",
  "copy",
  "cut",
  "compositionstart",
  "compositionend",
] as const;

const stop = (e: Event): void => e.stopPropagation();

/**
 * Stop `node`'s input events from bubbling to the editor root. Returns a
 * function that removes the listeners again.
 *
 * Listeners added to `node` before this call still run (they are on the same
 * node, in registration order); the ones the editor has on its root do not.
 */
export function isolateInput(node: Element): () => void {
  for (const type of ISOLATED_EVENTS) node.addEventListener(type, stop);
  return () => {
    for (const type of ISOLATED_EVENTS) node.removeEventListener(type, stop);
  };
}
