import { _ } from "creo";
import { button, div, option, select, view } from "creo";
import type { InputEventData, PointerEventData } from "creo";
import {
  calendarPlugin,
  createEditor,
  defaultSlashItems,
  slashCommandsPlugin,
  type Mark,
  type SerializedDoc,
} from "creo-edit";
import { mermaidPlugin, mermaidSlashItem } from "creo-edit-mermaid-plugin";
import "../../../src/plugins/styles.css";
import "../../../packages/mermaid/src/styles.css";

// Editor config is URL-driven so the same example app can demonstrate every
// mode without separate routes — and so the E2E suite can pin a config:
//   /                → wysiwyg, non-virtualized
//   /?mode=md        → raw markdown source view
//   /?virtualized=1  → windowed rendering
const __params = (() =>
  typeof window === "undefined"
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search))();

const __urlMode = __params.get("mode") === "md" ? "md" : "wysiwyg";
// Off by default: virtualization only mounts the blocks intersecting the
// viewport, which makes "click at these coordinates" assertions depend on
// scroll position. Tests that want it opt in.
const __virtualized = __params.get("virtualized") === "1";
const __readOnly = __params.get("editable") === "false";

export const editor = createEditor({
  mode: __urlMode,
  virtualized: __virtualized,
  editable: !__readOnly,
  plugins: [
    calendarPlugin(),
    mermaidPlugin(),
    slashCommandsPlugin({ items: [...defaultSlashItems, mermaidSlashItem] }),
  ],
  // `?doc=diagram` opens on a document with a diagram in it, which is the
  // quickest way to try the mermaid block; the default document is unchanged
  // so the existing E2E coordinates still hold.
  initial: __params.get("doc") === "diagram" ? diagramDoc() : {
    blocks: [
      { type: "h1", runs: [{ text: "Welcome to Creo Editor" }] },
      {
        type: "p",
        runs: [
          { text: "This is a block-based rich text editor built on a " },
          { text: "controlled contentEditable", marks: ["code"] },
          {
            text:
              ", on top of the Creo UI framework.",
          },
        ],
      },
      { type: "h2", runs: [{ text: "Try these" }] },
      {
        type: "li",
        ordered: false,
        depth: 0,
        runs: [{ text: "Type something here" }],
      },
      {
        type: "li",
        ordered: false,
        depth: 0,
        runs: [{ text: "Select text and press Cmd+B / Cmd+I" }],
      },
      {
        type: "li",
        ordered: false,
        depth: 0,
        runs: [{ text: "Press Tab to indent, Shift+Tab to outdent" }],
      },
      {
        type: "li",
        ordered: false,
        depth: 0,
        runs: [{ text: "Paste rich content from the web" }],
      },
      {
        type: "p",
        runs: [
          { text: "Edit me. Or use the toolbar above to format." },
        ],
      },
    ],
  },
});

function diagramDoc(): SerializedDoc {
  return {
    blocks: [
      { type: "h1", runs: [{ text: "Diagrams" }] },
      {
        type: "p",
        runs: [
          {
            text:
              "Click a step to select it. Double-click to rename, press + to add a connected step, drag a dot to connect two.",
          },
        ],
      },
      {
        type: "mermaid",
        source:
          "flowchart TD\n  A[Start] --> B{Works?}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Fix it]\n  D --> B",
      },
      { type: "p", runs: [{ text: "Text after the diagram." }] },
    ],
  } as unknown as SerializedDoc;
}

const blockTypes = [
  { v: "p", label: "Paragraph" },
  { v: "h1", label: "Heading 1" },
  { v: "h2", label: "Heading 2" },
  { v: "h3", label: "Heading 3" },
  { v: "h4", label: "Heading 4" },
  { v: "h5", label: "Heading 5" },
  { v: "h6", label: "Heading 6" },
] as const;

const Toolbar = view(() => {
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
  const insertColumns = (e: PointerEventData) => {
    e.preventDefault();
    editor.dispatch({ t: "insertColumns", cols: 2 });
    editor.focus();
  };
  const insertDiagram = (e: PointerEventData) => {
    e.preventDefault();
    editor.dispatch({ t: "mermaid.insert", payload: {} });
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
      div({ class: "toolbar" }, () => {
        select({ on: { change: onTypeChange } }, () => {
          for (const t of blockTypes) {
            option({ value: t.v }, t.label);
          }
        });
        div({ class: "sep" });
        button({ on: { click: mark("b") } }, "B");
        button({ on: { click: mark("i") } }, "I");
        button({ on: { click: mark("u") } }, "U");
        button({ on: { click: mark("s") } }, "S");
        button({ on: { click: mark("code") } }, "</>");
        div({ class: "sep" });
        button({ on: { click: list(false) } }, "• List");
        button({ on: { click: list(true) } }, "1. List");
        div({ class: "sep" });
        button({ on: { click: insertImage } }, "Image");
        button({ on: { click: insertTable } }, "Table");
        button({ on: { click: insertColumns } }, "Columns");
        button({ on: { click: insertDiagram } }, "Diagram");
        div({ class: "sep" });
        button({ on: { click: undo } }, "Undo");
        button({ on: { click: redo } }, "Redo");
      });
    },
  };
});

export const App = view(() => ({
  render() {
    Toolbar();
    editor.EditorView();
    void _;
  },
}));
