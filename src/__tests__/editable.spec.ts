import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type EditorOptions } from "../createEditor";
import type { CommandDef, EditorPlugin } from "../plugin/types";

afterEach(() => {
  clearDom();
});

function mount(opts: EditorOptions = {}) {
  const container = makeContainer();
  const editor = createEditor({
    initial: {
      blocks: [
        { type: "p", runs: [{ text: "first" }] },
        { type: "p", runs: [{ text: "second" }] },
      ],
    },
    ...opts,
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const root = container.querySelector("[data-creo-edit]") as HTMLElement;
  return { container, root, editor };
}

function firstBlockText(editor: ReturnType<typeof createEditor>): string {
  const doc = editor.docStore.get();
  const b = doc.byId.get(doc.order[0]!)! as { runs: { text: string }[] };
  return b.runs.map((r) => r.text).join("");
}

function docText(editor: ReturnType<typeof createEditor>): string {
  const doc = editor.docStore.get();
  return doc.order
    .map((id) => {
      const b = doc.byId.get(id)! as { runs?: { text: string }[] };
      return (b.runs ?? []).map((r) => r.text).join("");
    })
    .join("\n");
}

describe("editable option", () => {
  it("defaults to editable", () => {
    const { root, editor } = mount();
    expect(editor.isEditable()).toBe(true);
    expect(root.getAttribute("contenteditable")).toBe("true");
  });

  it("editable: false renders contenteditable=false", () => {
    const { root, editor } = mount({ editable: false });
    expect(editor.isEditable()).toBe(false);
    expect(root.getAttribute("contenteditable")).toBe("false");
  });

  it("refuses mutating commands and returns false", () => {
    const { editor } = mount({ editable: false });
    expect(editor.dispatch({ t: "insertText", text: "X" })).toBe(false);
    expect(editor.dispatch({ t: "splitBlock" })).toBe(false);
    expect(editor.dispatch({ t: "toggleMark", mark: "b" })).toBe(false);
    expect(editor.dispatch({ t: "deleteBackward" })).toBe(false);
    expect(docText(editor)).toBe("first\nsecond");
    expect(editor.docStore.get().order.length).toBe(2);
  });

  it("still allows caret motion while read-only", () => {
    const { editor } = mount({ editable: false });
    const secondId = editor.docStore.get().order[1]!;
    const to = { blockId: secondId, path: [3], offset: 3 };
    expect(editor.dispatch({ t: "moveCursor", to })).toBe(true);
    const sel = editor.selStore.get();
    expect(sel.kind).toBe("caret");
    expect(sel.kind === "caret" && sel.at.blockId).toBe(secondId);
  });

  it("refuses undo/redo while read-only", () => {
    const { editor } = mount();
    // The default caret sits at end-of-doc, i.e. in the last block.
    editor.dispatch({ t: "insertText", text: "!" });
    expect(docText(editor)).toBe("first\nsecond!");
    editor.setEditable(false);
    editor.undo();
    expect(docText(editor)).toBe("first\nsecond!");
    editor.setEditable(true);
    editor.undo();
    expect(docText(editor)).toBe("first\nsecond");
  });

  it("setEditable flips the attribute and the gate", () => {
    const { root, editor } = mount();
    editor.setEditable(false);
    expect(editor.isEditable()).toBe(false);
    expect(root.getAttribute("contenteditable")).toBe("false");
    expect(editor.dispatch({ t: "insertText", text: "X" })).toBe(false);
    editor.setEditable(true);
    expect(root.getAttribute("contenteditable")).toBe("true");
    expect(editor.dispatch({ t: "insertText", text: "X" })).toBe(true);
  });

  it("accepts a thunk that the host flips without recreating the editor", () => {
    let live = true;
    const { root, editor } = mount({ editable: () => live });
    expect(editor.dispatch({ t: "insertText", text: "a" })).toBe(true);
    live = false;
    expect(editor.isEditable()).toBe(false);
    expect(editor.dispatch({ t: "insertText", text: "b" })).toBe(false);
    // The attribute is re-synced on the events that precede an edit.
    root.dispatchEvent(new window.Event("focusin", { bubbles: true }));
    expect(root.getAttribute("contenteditable")).toBe("false");
  });

  it("swallows beforeinput while read-only", () => {
    const { root, editor } = mount({ editable: false });
    const before = firstBlockText(editor);
    const ev = new window.InputEvent("beforeinput", {
      inputType: "insertText",
      data: "Z",
      bubbles: true,
      cancelable: true,
    });
    root.dispatchEvent(ev as unknown as Event);
    expect(ev.defaultPrevented).toBe(true);
    expect(firstBlockText(editor)).toBe(before);
  });

  it("gates plugin commands, but honours readOnlySafe", () => {
    let mutations = 0;
    let navigations = 0;
    const commands: CommandDef<unknown>[] = [
      { t: "test.mutate", run: () => { mutations++; } },
      { t: "test.navigate", readOnlySafe: true, run: () => { navigations++; } },
    ];
    const plugin: EditorPlugin = { name: "test", commands };
    const { editor } = mount({ editable: false, plugins: [plugin] });
    expect(editor.dispatch({ t: "test.mutate" })).toBe(false);
    expect(mutations).toBe(0);
    expect(editor.dispatch({ t: "test.navigate" })).toBe(true);
    expect(navigations).toBe(1);
    editor.setEditable(true);
    expect(editor.dispatch({ t: "test.mutate" })).toBe(true);
    expect(mutations).toBe(1);
  });

  it("does not gate host-level document APIs", () => {
    const { editor } = mount({ editable: false });
    editor.setDoc({ blocks: [{ type: "p", runs: [{ text: "loaded" }] }] });
    expect(firstBlockText(editor)).toBe("loaded");
    editor.appendBlocks([{ type: "p", runs: [{ text: "more" }] }]);
    expect(editor.docStore.get().order.length).toBe(2);
  });

  it("read-only dispatch does not push an undo step", () => {
    const { editor } = mount();
    editor.dispatch({ t: "insertText", text: "A" });
    editor.setEditable(false);
    // Refused before history.record — no snapshot is pushed.
    editor.dispatch({ t: "insertText", text: "B" });
    editor.dispatch({ t: "splitBlock" });
    editor.setEditable(true);
    editor.undo();
    // A single undo reaches back past the refused commands to the state
    // before "A"; if they had recorded, this would still show "second A".
    expect(docText(editor)).toBe("first\nsecond");
  });
});
