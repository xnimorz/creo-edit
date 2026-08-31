// ---------------------------------------------------------------------------
// Editor handle on the DOM root.
//
// A decoration, a block view or a plugin's DOM chrome gets a `blockEl` and
// nothing else — no editor argument threads down to it, because the elements
// are created by the renderer, not by the plugin. So the editor publishes
// itself on its root element and those callers walk up to find it.
//
// This used to be an untyped `any` stashed as `root.__creoEdit` and re-declared
// with a hand-rolled structural type at each of the four call sites. The key
// is unchanged (so anything already reading it keeps working); what is new is
// that one module owns it, it is typed as the real `Editor`, and `closestEditor`
// does the ancestor walk instead of every caller repeating the selector.
// ---------------------------------------------------------------------------

import type { Editor } from "../createEditor";

/** Property name on the editor's root element. Stable public contract. */
export const EDITOR_REF_KEY = "__creoEdit";

/** The attribute `closestEditor` walks up to. */
export const EDITOR_ROOT_ATTR = "data-creo-edit";

type WithRef = { [EDITOR_REF_KEY]?: Editor };

export function setEditorRef(root: HTMLElement, editor: Editor): void {
  (root as unknown as WithRef)[EDITOR_REF_KEY] = editor;
}

export function clearEditorRef(root: HTMLElement): void {
  delete (root as unknown as WithRef)[EDITOR_REF_KEY];
}

/** The editor published on exactly this element, if any. */
export function getEditorRef(el: Element | null | undefined): Editor | null {
  if (!el) return null;
  return (el as unknown as WithRef)[EDITOR_REF_KEY] ?? null;
}

/**
 * The editor owning `node` — walks up to the nearest editor root. Accepts a
 * text node or an element, so a caller holding a selection endpoint can pass
 * it straight in.
 *
 * Returns null before mount (the root exists but the editor hasn't published
 * itself yet) and for nodes outside any editor.
 */
export function closestEditor(node: Node | null | undefined): Editor | null {
  if (!node) return null;
  const el =
    node.nodeType === 1
      ? (node as Element)
      : (node.parentElement as Element | null);
  const root = el?.closest(`[${EDITOR_ROOT_ATTR}]`) ?? null;
  return getEditorRef(root);
}
