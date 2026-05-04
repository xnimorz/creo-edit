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

// Default seed used when no `initial` prop is provided. Doubles as the
// landing-page first impression: it should explain the editor in itself.
const DEFAULT_INITIAL: SerializedDoc = {
  blocks: [
    { type: "h1", runs: [{ text: "Creo Editor" }] },
    {
      type: "p",
      runs: [
        { text: "A " },
        { text: "no-contentEditable", marks: ["code"] },
        {
          text:
            ", row-based rich-text editor for the Creo UI framework. Try it — every block you see is a row in the model, and every keystroke flows through a hidden textarea.",
        },
      ],
    },
    { type: "h2", runs: [{ text: "What you can do here" }] },
    {
      type: "li",
      ordered: false,
      depth: 0,
      runs: [{ text: "Type anywhere — the cursor follows" }],
    },
    {
      type: "li",
      ordered: false,
      depth: 0,
      runs: [
        { text: "Select text and press " },
        { text: "Cmd/Ctrl+B", marks: ["code"] },
        { text: " or " },
        { text: "Cmd/Ctrl+I", marks: ["code"] },
      ],
    },
    {
      type: "li",
      ordered: false,
      depth: 0,
      runs: [
        { text: "Press " },
        { text: "Tab", marks: ["code"] },
        { text: " inside a list to indent, " },
        { text: "Shift+Tab", marks: ["code"] },
        { text: " to outdent" },
      ],
    },
    {
      type: "li",
      ordered: false,
      depth: 0,
      runs: [{ text: "Paste rich text from any web page" }],
    },
    {
      type: "p",
      runs: [
        {
          text:
            "Use the toolbar above to change block types, toggle marks, insert a table or image. Cmd/Ctrl+Z / Shift+Cmd+Z for undo / redo.",
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
] as const;

export type EditorDemoProps = {
  /** Custom initial content. Defaults to the welcome doc. */
  initial?: SerializedDoc;
  /** Visual variant — "regular" sans-serif (default) or "mono". */
  mode?: "regular" | "mono";
  /** Extra class applied to the wrapper. */
  class?: string;
};

export const EditorDemo = view<EditorDemoProps>(({ props }) => {
  const initial = props().initial ?? DEFAULT_INITIAL;
  const mode = props().mode ?? "regular";

  // One editor per view instance — created eagerly so its EditorView() is
  // available on first render.
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
