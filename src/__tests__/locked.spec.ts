import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedBlock } from "../createEditor";
import { caretAt } from "../controller/selection";
import type { DocChange } from "../model/changes";

afterEach(() => clearDom());

const blocks = (): SerializedBlock[] => [
  { id: "a", type: "p", runs: [{ text: "mine" }] },
  { id: "l", type: "p", runs: [{ text: "agreed" }], locked: true },
  { id: "b", type: "p", runs: [{ text: "after" }] },
];

function setup() {
  const editor = createEditor({ initial: { blocks: blocks() } });
  const batches: DocChange[][] = [];
  editor.onChange((c) => batches.push(c));
  return { editor, batches };
}

describe("locked blocks", () => {
  it("refuses typing, splitting and formatting inside, with no undo step or change", () => {
    const { editor, batches } = setup();
    editor.selStore.set({ kind: "caret", at: caretAt("l", 2) });
    expect(editor.dispatch({ t: "insertText", text: "x" })).toBe(false);
    expect(editor.dispatch({ t: "splitBlock" })).toBe(false);
    editor.selStore.set({ kind: "range", anchor: caretAt("l", 0), focus: caretAt("l", 3) });
    expect(editor.dispatch({ t: "toggleMark", mark: "b" })).toBe(false);
    expect(editor.getText("l")).toBe("agreed");
    expect(batches).toEqual([]);
    editor.undo();
    expect(editor.getText()).toBe("mine\nagreed\nafter");
  });

  it("refuses a merge into it and a range delete that reaches it", () => {
    const { editor } = setup();
    editor.selStore.set({ kind: "caret", at: caretAt("b", 0) });
    expect(editor.dispatch({ t: "mergeBackward" })).toBe(false);
    editor.selStore.set({ kind: "range", anchor: caretAt("a", 2), focus: caretAt("b", 2) });
    editor.dispatch({ t: "deleteBackward" });
    expect(editor.getText()).toBe("mine\nagreed\nafter");
  });

  it("keeps the redo trail when an edit is refused", () => {
    const { editor } = setup();
    editor.selStore.set({ kind: "caret", at: caretAt("a", 4) });
    editor.dispatch({ t: "insertText", text: "!" });
    editor.undo();
    editor.selStore.set({ kind: "caret", at: caretAt("l", 0) });
    editor.dispatch({ t: "insertText", text: "x" });
    editor.redo();
    expect(editor.getText("a")).toBe("mine!");
  });

  it("can still be moved, and changed by the host", () => {
    const { editor } = setup();
    expect(editor.dispatch({ t: "moveBlock", payload: { blockId: "l", toIndex: 0 } })).toBe(true);
    expect(editor.docStore.get().order[0]).toBe("l");
    editor.applyBlocks({ replace: [{ id: "l", type: "p", runs: [{ text: "revised" }], locked: true }] });
    expect(editor.getText("l")).toBe("revised");
  });

  it("round-trips the flag and draws the block as not editable", () => {
    const { editor } = setup();
    expect(editor.toJSON().blocks[1]).toMatchObject({ id: "l", locked: true });
    expect("locked" in editor.toJSON().blocks[0]!).toBe(false);
    const root = makeContainer();
    createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
    const el = root.querySelector('[data-block-id="l"]')!;
    expect(el.getAttribute("contenteditable")).toBe("false");
    expect(el.getAttribute("data-locked")).toBe("true");
    expect(root.querySelector('[data-block-id="a"]')!.hasAttribute("contenteditable")).toBe(false);
  });

  it("lets editing elsewhere through", () => {
    const { editor } = setup();
    editor.selStore.set({ kind: "caret", at: caretAt("a", 4) });
    expect(editor.dispatch({ t: "insertText", text: "!" })).toBe(true);
    expect(editor.getText("a")).toBe("mine!");
  });
});
