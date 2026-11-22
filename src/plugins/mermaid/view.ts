// ---------------------------------------------------------------------------
// MermaidView — the block's shell.
//
// creo renders exactly one element: the block container the editor's anchor
// map looks for (`data-block-id`, `data-block-kind`), non-editable so the
// browser puts the caret beside it rather than in it. Everything inside is
// built and kept by `MermaidBlockUI` — see the note at the top of `ui.ts`
// for why it is not creo's.
//
// The shell declares no children, so the renderer has none to reconcile and
// leaves the ones the UI appended alone.
// ---------------------------------------------------------------------------

import { div, view, type RefObject } from "creo";
import type { Block } from "../../index";
import { MERMAID_TYPE, type MermaidBlock } from "./types";
import { MermaidBlockUI } from "./ui";

export const MermaidView = view<{ block: Block }>(({ props }) => {
  const shell: RefObject<Element> = { current: null };
  let ui: MermaidBlockUI | null = null;
  const block = (): MermaidBlock => props().block as unknown as MermaidBlock;

  return {
    shouldUpdate(next) {
      return next.block !== props().block;
    },
    render() {
      div({
        "data-block-id": block().id,
        "data-block-kind": MERMAID_TYPE,
        // Atomic island: the native caret goes around it, never inside.
        contenteditable: "false",
        class: "ce-block ce-mermaid",
        ref: shell,
      });
    },
    onMount() {
      const el = shell.current as HTMLElement | null;
      if (el) ui = new MermaidBlockUI(el, block());
    },
    onUpdateAfter() {
      ui?.setBlock(block());
    },
    dispose() {
      ui?.destroy();
      ui = null;
    },
  };
});
