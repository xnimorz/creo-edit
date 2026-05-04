import { view, div, h1, p, _ } from "creo";
import { EditorDemo } from "./EditorDemo";

export const Demo = view(() => ({
  render() {
    div({ class: "demo-page" }, () => {
      div({ class: "demo-shell" }, () => {
        h1({ class: "demo-title" }, "Creo Editor — live demo");
        p(
          { class: "demo-tagline" },
          "Same editor, full-page layout. Everything you can do in the API is wired into the toolbar above and the keyboard underneath.",
        );
        EditorDemo({ class: "demo-editor" });
      });
      void _;
    });
  },
}));
