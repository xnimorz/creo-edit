import { view, div, h1, h2, p, button, span, pre, code, _ } from "creo";
import {
  createEditor,
  defaultSlashItems,
  docToMarkdown,
  slashCommandsPlugin,
  type Editor,
  type SerializedDoc,
} from "creo-edit";
import {
  mermaidController,
  mermaidPlugin,
  mermaidSlashItem,
  type MermaidMode,
} from "creo-edit-mermaid-plugin";
import "../../../packages/mermaid/src/styles.css";

// ---------------------------------------------------------------------------
// "Mermaid diagrams" demo — `creo-edit-mermaid-plugin` on a real document.
//
// A diagram is one block holding one string, its Mermaid source. Every edit
// made by pointing at the picture is compiled to an edit of that string, which
// the panel under the editor shows as it changes: the document is markdown
// with fenced `mermaid` blocks in it, and nothing else.
//
// The toolbar drives the plugin's public API rather than its own UI:
//   mermaid.insert       → a new block, opening on the starter picker
//   mermaidController    → every block's Diagram / Code mode (view state —
//                          switching adds nothing to undo)
//   options.nodeId       → the id a node added in the picture takes
//   editor.setEditable   → a read-only viewer, where the picture is a picture
// ---------------------------------------------------------------------------

const SEED: SerializedDoc = {
  blocks: [
    {
      type: "p",
      runs: [
        {
          text: "Click a step to select it. Double-click it, or just start typing, to rename it. Press + (or Tab) to add a connected step, drag one of its dots onto another step to connect the two, Delete to remove it. Every one of those is one undo step.",
        },
      ],
    },
    {
      type: "mermaid",
      source:
        "flowchart TD\n  A[Write it] --> B{Reviewed?}\n  B -->|Yes| C[Ship it]\n  B -->|No| D[Fix it]\n  D --> B",
    },
    {
      type: "p",
      runs: [
        {
          text: "Sequence diagrams, state diagrams, class and ER diagrams are edited the same way. Switch a block to Code from its bar to write the source by hand.",
        },
      ],
    },
    {
      type: "mermaid",
      source:
        "sequenceDiagram\n  participant Editor\n  participant Plugin\n  Editor->>Plugin: a gesture\n  Plugin-->>Editor: an edit of the source",
    },
    {
      type: "mermaid",
      source:
        "stateDiagram-v2\n  [*] --> Draft\n  Draft --> Review : submit\n  Review --> Draft : changes\n  Review --> Published : approve\n  Published --> [*]",
    },
    {
      type: "p",
      runs: [
        {
          text: "The other types Mermaid knows are drawn and edited as source:",
        },
      ],
    },
    {
      type: "mermaid",
      source: 'pie title Where the time goes\n  "Writing" : 45\n  "Reviewing" : 35\n  "Drawing boxes" : 20',
    },
    {
      type: "p",
      runs: [{ text: "Type / on an empty line for the slash menu — “Diagram” is in it." }],
    },
  ],
} as unknown as SerializedDoc;

/** An id two people adding a node at the same moment would not both pick. */
const randomNodeId = (): string => "n" + Math.random().toString(36).slice(2, 7);

export const MermaidDemo = view(({ use }) => {
  // `use(initial)` is view-bound state: setting it re-renders this view.
  const readOnly = use(false);
  const uniqueIds = use(false);

  const editor: Editor = createEditor({
    plugins: [
      mermaidPlugin({
        // Read on every add, so the toggle takes effect at once. An empty
        // string means "no id of mine": the plugin picks the next free one.
        nodeId: () => (uniqueIds.get() ? randomNodeId() : ""),
      }),
      slashCommandsPlugin({ items: [...defaultSlashItems, mermaidSlashItem] }),
    ],
    initial: SEED,
  });

  const markdown = use(docToMarkdown(editor.toJSON()));
  const offDoc = editor.docStore.subscribe(() => {
    markdown.set(docToMarkdown(editor.toJSON()));
  });

  const diagramIds = (): string[] => {
    const doc = editor.docStore.get();
    return doc.order.filter((id) => (doc.byId.get(id) as { type: string } | undefined)?.type === "mermaid");
  };

  const showAll = (mode: MermaidMode) => () => {
    const ctl = mermaidController(editor);
    if (!ctl) return;
    for (const id of diagramIds()) ctl.setMode(id, mode);
  };

  const insert = (): void => {
    editor.focus();
    editor.dispatch({ t: "mermaid.insert", payload: {} });
  };

  const Toggle = (label: string, on: boolean, onClick: () => void): void => {
    button({ class: on ? "ide-toggle is-on" : "ide-toggle", on: { click: onClick } }, label);
  };

  return {
    dispose() {
      offDoc();
      editor.destroy();
    },
    render() {
      const ro = readOnly.get();
      const ids = uniqueIds.get();
      const md = markdown.get();
      div({ class: "ide-demo mermaid-demo" }, () => {
        div({ class: "ide-shell" }, () => {
          h1({ class: "demo-title" }, "Mermaid diagrams");
          p(
            { class: "demo-tagline" },
            "creo-edit-mermaid-plugin: a diagram block you edit by pointing at the picture, or by writing its source. The source is all the document stores.",
          );

          div({ class: "ide-toolbar" }, () => {
            Toggle(ro ? "Read-only" : "Editable", ro, () => {
              readOnly.set(!ro);
              editor.setEditable(ro);
            });
            Toggle("Unique node ids", ids, () => uniqueIds.set(!ids));
            span({ class: "ide-sep" });
            button({ class: "ide-btn", on: { click: insert } }, "Insert diagram");
            button({ class: "ide-btn", on: { click: showAll("diagram") } }, "All as diagrams");
            button({ class: "ide-btn", on: { click: showAll("code") } }, "All as code");
            span({ class: "ide-sep" });
            button({ class: "ide-btn", on: { click: () => editor.undo() } }, "Undo");
            button({ class: "ide-btn", on: { click: () => editor.redo() } }, "Redo");
          });

          div({ class: "mermaid-demo-editor-wrap" }, () => {
            editor.EditorView({ class: "mermaid-demo-editor" });
          });

          div({ class: "ide-panel mermaid-demo-panel" }, () => {
            h2({ class: "ide-panel-title" }, "The document, as markdown");
            pre({ class: "mermaid-demo-md" }, () => {
              code({}, md);
            });
            p(
              { class: "ide-panel-note" },
              ids
                ? "Unique node ids is on: a node added in a flowchart or a state diagram is named by options.nodeId — what a document edited by several people at once needs, so that two nodes added at the same moment stay two."
                : "A node added in the picture takes the next free id (E after D). Turn on “Unique node ids” to see options.nodeId name it instead.",
            );
          });
        });
        void _;
      });
    },
  };
});
