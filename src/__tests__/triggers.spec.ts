import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { slashCommandsPlugin } from "../plugins/slash";

afterEach(() => {
  clearDom();
});

function mountWithSlash() {
  const root = makeContainer();
  const editor = createEditor({
    plugins: [slashCommandsPlugin()],
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(root),
    SYNC_SCHEDULER,
  ).mount();
  const editorRoot = root.querySelector("[data-creo-edit]") as HTMLElement;
  return { root, editor, ta: editorRoot };
}

describe("slash trigger", () => {
  it("registers the trigger on the editor's registry", () => {
    const { editor } = mountWithSlash();
    expect(editor.registry.triggers.length).toBe(1);
    expect(editor.registry.triggers[0]!.match).toBe("/");
  });

  it("typing '/' opens the slash menu", () => {
    const { ta } = mountWithSlash();
    // Simulate '/' through the beforeinput pipeline.
    const ev = new (globalThis as { InputEvent: typeof InputEvent }).InputEvent(
      "beforeinput",
      { inputType: "insertText", data: "/", bubbles: true, cancelable: true },
    );
    ta.dispatchEvent(ev);
    const menu = document.querySelector(".creo-slash");
    expect(menu).toBeTruthy();
  });

  it("Escape closes the open menu", () => {
    const { ta } = mountWithSlash();
    ta.dispatchEvent(
      new (globalThis as { InputEvent: typeof InputEvent }).InputEvent(
        "beforeinput",
        { inputType: "insertText", data: "/", bubbles: true, cancelable: true },
      ),
    );
    expect(document.querySelector(".creo-slash")).toBeTruthy();
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.querySelector(".creo-slash")).toBeFalsy();
  });

  it("Enter dispatches the selected item's command", () => {
    const { editor, ta } = mountWithSlash();
    // Open the menu.
    ta.dispatchEvent(
      new (globalThis as { InputEvent: typeof InputEvent }).InputEvent(
        "beforeinput",
        { inputType: "insertText", data: "/", bubbles: true, cancelable: true },
      ),
    );
    // First item in the default list is Paragraph; press Enter.
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    // Caret block should still be a paragraph (was already), and the "/"
    // character should be removed.
    const sel = editor.selStore.get();
    if (sel.kind !== "caret") throw new Error("expected caret");
    const block = editor.docStore.get().byId.get(sel.at.blockId)!;
    expect(block.type).toBe("p");
    if ("runs" in block) {
      const total = block.runs.reduce((n, r) => n + r.text.length, 0);
      expect(total).toBe(0); // "/" was removed by the trigger before run()
    }
    expect(document.querySelector(".creo-slash")).toBeFalsy();
  });

  it("ArrowDown moves the active item highlight", () => {
    const { ta } = mountWithSlash();
    ta.dispatchEvent(
      new (globalThis as { InputEvent: typeof InputEvent }).InputEvent(
        "beforeinput",
        { inputType: "insertText", data: "/", bubbles: true, cancelable: true },
      ),
    );
    const before = document.querySelectorAll(".creo-slash-item.is-active");
    expect(before.length).toBe(1);
    const firstActive = before[0]!.getAttribute("data-id");
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    );
    const after = document.querySelectorAll(".creo-slash-item.is-active");
    expect(after.length).toBe(1);
    expect(after[0]!.getAttribute("data-id")).not.toBe(firstActive);
  });
});
