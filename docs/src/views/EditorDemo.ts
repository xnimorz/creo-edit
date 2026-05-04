import {
  view,
  div,
  button,
  option,
  select,
  _,
} from "creo";
import type { InputEventData, PointerEventData } from "creo";
import { createEditor, type Mark, type SerializedDoc } from "creo-editor";

// Default initial — the actual createEditor() snippet from the README,
// rendered as a real `code` block so the user can edit it as a single
// multi-line region (Enter inserts \n, doesn't split). Editable: the
// landing-page editor IS the welcome doc, so people can type into it as
// the first thing they do on the site.
const DEFAULT_INITIAL: SerializedDoc = {
  blocks: [
    { type: "h2", runs: [{ text: "This editor is the editor" }] },
    {
      type: "p",
      runs: [
        {
          text:
            "Below is a real createEditor() instance. The block you're reading right now is a row in its model. Click in, type, format with the toolbar — every interaction goes through the public API.",
        },
      ],
    },
    {
      type: "p",
      runs: [{ text: "Mount one in three lines:" }],
    },
    {
      type: "code",
      lang: "ts",
      runs: [
        {
          text:
            'import { createApp, HtmlRender } from "creo";\n' +
            'import { createEditor } from "creo-editor";\n' +
            "\n" +
            "const editor = createEditor();\n" +
            "\n" +
            "createApp(\n" +
            "  () => editor.EditorView(),\n" +
            '  new HtmlRender(document.querySelector("#app")!),\n' +
            ").mount();",
        },
      ],
    },
    {
      type: "p",
      runs: [
        {
          text:
            "Want a toolbar? Wire buttons to editor.dispatch(). Want to save? editor.toJSON(). Want to load HTML? editor.setDocFromHTML(html). The full API is one click away on the right.",
        },
      ],
    },
  ],
};

const blockTypes = [
  { v: "p", label: "Paragraph" },
  { v: "h1", label: "Heading 1" },
  { v: "h2", label: "Heading 2" },
  { v: "h3", label: "Heading 3" },
  { v: "h4", label: "Heading 4" },
  { v: "code", label: "Code block" },
] as const;

export type EditorDemoProps = {
  initial?: SerializedDoc;
  mode?: "regular" | "mono";
  class?: string;
};

export const EditorDemo = view<EditorDemoProps>(({ props }) => {
  const initial = props().initial ?? DEFAULT_INITIAL;
  const mode = props().mode ?? "regular";

  const editor = createEditor({ initial, mode });

  const onTypeChange = (e: InputEventData) => {
    const v = e.value as (typeof blockTypes)[number]["v"];
    editor.dispatch({ t: "setBlockType", payload: { type: v } });
    editor.focus();
  };
  const mark = (m: Mark) => (e: PointerEventData) => {
    e.preventDefault();
    editor.dispatch({ t: "toggleMark", mark: m });
    editor.focus();
  };
  const list = (ordered: boolean) => (e: PointerEventData) => {
    e.preventDefault();
    editor.dispatch({ t: "toggleList", ordered });
    editor.focus();
  };
  const insertImage = (e: PointerEventData) => {
    e.preventDefault();
    const src = window.prompt("Image URL?");
    if (src) editor.dispatch({ t: "insertImage", src });
    editor.focus();
  };
  const insertTable = (e: PointerEventData) => {
    e.preventDefault();
    editor.dispatch({ t: "insertTable", rows: 3, cols: 3 });
    editor.focus();
  };
  const undo = (e: PointerEventData) => {
    e.preventDefault();
    editor.undo();
    editor.focus();
  };
  const redo = (e: PointerEventData) => {
    e.preventDefault();
    editor.redo();
    editor.focus();
  };

  return {
    render() {
      const wrapClass =
        "ed-demo" + (props().class ? " " + props().class : "");
      div({ class: wrapClass }, () => {
        div({ class: "ed-toolbar" }, () => {
          select({ class: "ed-select", onChange: onTypeChange }, () => {
            for (const t of blockTypes) {
              option({ value: t.v }, t.label);
            }
          });
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: mark("b") }, "B");
          button({ class: "ed-btn", onClick: mark("i") }, "I");
          button({ class: "ed-btn", onClick: mark("u") }, "U");
          button({ class: "ed-btn", onClick: mark("s") }, "S");
          button({ class: "ed-btn", onClick: mark("code") }, "</>");
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: list(false) }, "• List");
          button({ class: "ed-btn", onClick: list(true) }, "1. List");
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: insertImage }, "Image");
          button({ class: "ed-btn", onClick: insertTable }, "Table");
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: undo }, "Undo");
          button({ class: "ed-btn", onClick: redo }, "Redo");
        });
        editor.EditorView();
        void _;
      });
    },
  };
});
