// ---------------------------------------------------------------------------
// The editor handle published on the DOM root, and the root-resolution the
// imperative APIs depend on.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import {
  clearDom,
  makeContainer,
  SYNC_SCHEDULER,
} from "../../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedDoc } from "../../createEditor";
import { closestEditor, getEditorRef } from "../editorRef";

afterEach(() => clearDom());

function mount(initial: SerializedDoc) {
  const container = makeContainer();
  const editor = createEditor({ initial });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  return { editor, container };
}

describe("editor reference on the root", () => {
  it("publishes the whole typed editor, reachable from any node inside it", () => {
    const { editor, container } = mount({
      blocks: [{ id: "a", type: "p", runs: [{ text: "hi" }] }],
    });
    expect(getEditorRef(container.querySelector("[data-creo-edit]"))).toBe(editor);
    expect(closestEditor(container.querySelector("[data-block-id]"))).toBe(editor);
  });

  it("resolves to null outside any editor, not to the first one on the page", () => {
    mount({ blocks: [{ id: "a", type: "p", runs: [{ text: "hi" }] }] });
    expect(closestEditor(document.body)).toBeNull();
  });

  it("two editors on one page each resolve to themselves", () => {
    const one = mount({ blocks: [{ id: "a", type: "p", runs: [{ text: "1" }] }] });
    const two = mount({ blocks: [{ id: "b", type: "p", runs: [{ text: "2" }] }] });
    expect(closestEditor(two.container.querySelector("[data-block-id]"))).toBe(
      two.editor,
    );
    expect(closestEditor(one.container.querySelector("[data-block-id]"))).toBe(
      one.editor,
    );
  });
});

describe("imperative APIs before mount", () => {
  it("focus / blur / scrollToBlock are safe no-ops", () => {
    const editor = createEditor();
    expect(() => editor.focus()).not.toThrow();
    expect(() => editor.blur()).not.toThrow();
    expect(() =>
      editor.scrollToBlock(editor.docStore.get().order[0]!),
    ).not.toThrow();
  });
});
