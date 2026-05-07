import { view, div, _ } from "creo";
import { createEditor, type Editor } from "creo-edit";
import type { CompiledDoc } from "../markdown/types";

let hostUidCounter = 0;

// Singleton editor reused across every doc-page route. Created lazily on
// the first DocPage mount; subsequent route navigations call `setDoc()` to
// swap content in place. This avoids reattaching window listeners
// (pointermove, etc.) on every nav and keeps the input pipeline alive.
let docEditor: Editor | null = null;

function ensureEditor(initial: CompiledDoc) {
  if (!docEditor) docEditor = createEditor({ initial: initial.doc });
  return docEditor;
}

// Renders a doc page through a real editor instance — every paragraph,
// heading, list item, and code block is editable.
//
// Heading anchors: after each editor re-render we walk the rendered <h*>
// tags and assign DOM ids from the source's heading slug list. This is
// what makes `#anchor` links from the right-hand TOC resolve. Wiring runs
// in onUpdateAfter, which fires after every re-render of this view —
// including those triggered by docStore changes from `setDoc()`, because
// we subscribe to docStore via `use()` below.
export const EditorPage = view<{ doc: CompiledDoc }>(({ props, use }) => {
  const hostId = `ed-page-host-${++hostUidCounter}`;

  const editor = ensureEditor(props().doc);
  // Subscribe to the editor's docStore so this view re-renders whenever
  // content changes. Without this, our onUpdateAfter only fires when our
  // own props change — and `setDoc()` doesn't change our props.
  const docState = use(editor.docStore);

  let lastDocSig: string | null = null;

  const swapDocIfNeeded = () => {
    const compiled = props().doc;
    const sig = compiled.meta.slug;
    if (sig !== lastDocSig) {
      editor.setDoc(compiled.doc);
      lastDocSig = sig;
    }
  };

  const wireHeadingIds = () => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const headings = host.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, h5, h6",
    );
    const expected = props().doc.headings;
    let i = 0;
    headings.forEach((h) => {
      const exp = expected[i++];
      if (exp && h.id !== exp.slug) h.id = exp.slug;
    });
  };

  return {
    onMount() {
      swapDocIfNeeded();
      wireHeadingIds();
    },
    onUpdateAfter() {
      // Fires after every re-render. Renders are triggered by either:
      //   (1) our own props changing (route nav → new `doc` prop) — handled
      //       by swapDocIfNeeded() which calls setDoc().
      //   (2) the editor's docStore changing (typing, formatting, OR our
      //       own setDoc above) — re-fires this hook through the use()
      //       subscription, giving us a chance to re-wire heading ids.
      swapDocIfNeeded();
      wireHeadingIds();
    },
    render() {
      // Reactive read so `use(editor.docStore)` actually subscribes.
      docState.get();
      div({ id: hostId, class: "editor-page-host" }, () => {
        editor.EditorView();
      });
      void _;
    },
  };
});
