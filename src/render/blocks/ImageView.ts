import { _ } from "creo";
import { div, img, view } from "creo";
import type { ImageBlock } from "../../model/types";

export const ImageView = view<{ block: ImageBlock; selected?: boolean }>(
  ({ props }) => ({
    shouldUpdate(next) {
      const cur = props();
      return next.block !== cur.block || next.selected !== cur.selected;
    },
    render() {
      const b = props().block;
      const sel = props().selected === true;
      div(
        {
          "data-block-id": b.id,
          "data-block-kind": "img",
          // Atomic to native caret — under contentEditable the browser must
          // skip OVER the img rather than placing the caret inside it.
          // contenteditable="false" inside an editable root creates exactly
          // that "non-editable island" behaviour. Harmless when the editor
          // is not contenteditable (textarea-driven path ignores the attr).
          contenteditable: "false",
          class: sel ? "ce-block ce-img ce-img-selected" : "ce-block ce-img",
          // Override the editor root's `cursor: text` so hovering an image
          // shows the default arrow, not the I-beam.
          style:
            (sel
              ? "outline:2px solid rgba(64,128,255,0.7);outline-offset:2px;"
              : "") + "cursor:default;",
        },
        () => {
          img({
            src: b.src,
            alt: b.alt ?? "",
            width: b.width,
            height: b.height,
            draggable: false,
          });
          void _;
        },
      );
    },
  }),
);
