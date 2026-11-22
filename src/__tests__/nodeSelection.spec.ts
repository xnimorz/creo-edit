import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, div, HtmlRender, view } from "creo";

import { createEditor, type EditorOptions } from "../createEditor";
import { caretAt } from "../controller/selection";
import { horizontalRulePlugin } from "../plugins/horizontal-rule";
import type { Block } from "../model/types";

afterEach(() => clearDom());

function mount(extra: Partial<EditorOptions> = {}) {
  const editor = createEditor({
    plugins: [horizontalRulePlugin()],
    initial: {
      blocks: [
        { id: "a", type: "p", runs: [{ text: "above" }] },
        { id: "r", type: "hr" },
        { id: "b", type: "p", runs: [{ text: "below" }] },
      ],
    },
    ...extra,
  });
  const root = makeContainer();
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  editor.focus();
  const surface = root.querySelector("[data-creo-edit]") as HTMLElement;
  const press = (inputType: string): void => {
    const ev = new Event("beforeinput", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "inputType", { value: inputType });
    Object.defineProperty(ev, "data", { value: null });
    surface.dispatchEvent(ev);
  };
  return { editor, press };
}

describe("selecting an atomic block before deleting it", () => {
  it("Backspace at the start of the block after selects it; the second deletes it, undoably", () => {
    const { editor, press } = mount();
    editor.selStore.set({ kind: "caret", at: caretAt("b", 0) });
    press("deleteContentBackward");
    expect(editor.docStore.get().byId.has("r")).toBe(true);
    const sel = editor.selStore.get();
    expect(sel.kind === "range" && sel.anchor.blockId === "r" && sel.focus.blockId === "r").toBe(true);
    press("deleteContentBackward");
    expect(editor.docStore.get().order).toEqual(["a", "b"]);
    editor.undo();
    expect(editor.docStore.get().order).toEqual(["a", "r", "b"]);
  });

  it("Delete at the end of the block before selects it", () => {
    const { editor, press } = mount();
    editor.selStore.set({ kind: "caret", at: caretAt("a", 5) });
    press("deleteContentForward");
    const sel = editor.selStore.get();
    expect(sel.kind === "range" && sel.anchor.blockId === "r").toBe(true);
    expect(editor.getText("a")).toBe("above");
  });

  it("confirmDelete can keep it", () => {
    const asked: Block[] = [];
    const { editor, press } = mount({ confirmDelete: (block) => (asked.push(block), false) });
    editor.selStore.set({ kind: "caret", at: caretAt("b", 0) });
    press("deleteContentBackward");
    press("deleteContentBackward");
    expect(asked.map((b) => b.id)).toEqual(["r"]);
    expect(editor.docStore.get().byId.has("r")).toBe(true);
  });

  it("tells the block's view it is selected, and deleteAtomic removes it", () => {
    const Probe = view<{ block: Block; selected?: boolean }>(({ props }) => ({
      shouldUpdate: (next) => next.block !== props().block || next.selected !== props().selected,
      render() {
        div({
          "data-block-id": props().block.id,
          "data-block-kind": "probe",
          contenteditable: "false",
          "data-selected": props().selected ? "yes" : "no",
        });
      },
    }));
    const editor = createEditor({
      plugins: [{ name: "probe", blocks: [{ type: "probe" as Block["type"], isAtomic: true, view: Probe as never }] }],
      initial: {
        blocks: [
          { id: "a", type: "p", runs: [{ text: "x" }] },
          { id: "z", type: "probe" } as never,
        ],
      },
    });
    const root = makeContainer();
    createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
    const flag = () => root.querySelector('[data-block-id="z"]')!.getAttribute("data-selected");
    expect(flag()).toBe("no");
    editor.selStore.set({
      kind: "range",
      anchor: { blockId: "z", path: [0], offset: 0 },
      focus: { blockId: "z", path: [1], offset: 1 },
    });
    expect(flag()).toBe("yes");
    editor.selStore.set({ kind: "caret", at: caretAt("a", 0) });
    expect(flag()).toBe("no");
    expect(editor.dispatch({ t: "deleteAtomic", blockId: "z" })).toBe(true);
    expect(editor.docStore.get().order).toEqual(["a"]);
  });
});
