import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER, win } from "./setup";
import { createApp, HtmlRender } from "creo";
import { createEditor } from "../createEditor";
import { isolateInput, ISOLATED_EVENTS } from "../input/isolate";
import { getHtmlParserForTag, registerHtmlBlockCodec } from "../plugin/htmlCodec";
import type { BlockSpec } from "../model/types";

afterEach(() => clearDom());

function mount() {
  const container = makeContainer();
  const editor = createEditor({
    initial: { blocks: [{ id: "a", type: "p", runs: [{ text: "hello" }] }] },
  });
  createApp(() => editor.EditorView(), new HtmlRender(container), SYNC_SCHEDULER).mount();
  const root = container.querySelector("[data-creo-edit]") as HTMLElement;
  return { editor, root };
}

describe("isolateInput — a field inside a block", () => {
  it("without it, the editor swallows the field's typing", () => {
    const { root } = mount();
    const field = document.createElement("textarea");
    root.appendChild(field);
    const ev = new win.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
    field.dispatchEvent(ev as unknown as Event);
    // This is the problem being solved: the root cancels what it sees.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("with it, none of the editor's input events reach the root", () => {
    const { root, editor } = mount();
    const field = document.createElement("textarea");
    root.appendChild(field);
    const seen: string[] = [];
    for (const t of ISOLATED_EVENTS) root.addEventListener(t, () => seen.push(t));
    const restore = isolateInput(field);

    const ev = new win.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
    field.dispatchEvent(ev as unknown as Event);
    field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    expect(ev.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
    expect(editor.getText()).toBe("hello");

    // A listener on the field itself still runs: isolation stops the bubble,
    // not the event.
    let own = 0;
    field.addEventListener("keydown", () => own++);
    field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", bubbles: true }) as unknown as Event);
    expect(own).toBe(1);

    restore();
    field.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", bubbles: true }) as unknown as Event);
    expect(seen).toEqual(["keydown"]);
  });
});

describe("selection sync — a control inside a block keeps the focus", () => {
  it("does not write the page's selection while a field in a block is focused", () => {
    const { root, editor } = mount();
    const field = document.createElement("input");
    root.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    const native = document.getSelection()!;
    native.removeAllRanges();
    // A command dispatched from the field changes the model selection. The
    // editor must not answer by moving the page's selection into its text —
    // the browser would move the focus with it, out of the field.
    editor.selStore.set({ kind: "caret", at: { blockId: "a", path: [3], offset: 3 } });
    expect(native.rangeCount).toBe(0);
    expect(document.activeElement).toBe(field);
  });

  it("still writes it when the editor itself has the focus", () => {
    const { root, editor } = mount();
    root.focus();
    editor.selStore.set({ kind: "caret", at: { blockId: "a", path: [3], offset: 3 } });
    const native = document.getSelection()!;
    expect(native.rangeCount).toBe(1);
    expect(native.anchorOffset).toBe(3);
  });
});

describe("HTML block parsers — newest registration is asked first", () => {
  it("lets a later parser claim an element an earlier one never declines", () => {
    const spec = (type: string): BlockSpec => ({ id: "x", type, runs: [] }) as unknown as BlockSpec;
    // Stands in for the built-in <pre> parser: it takes everything.
    registerHtmlBlockCodec("t-greedy", { matchHTML: ["x-el"], parseHTML: () => spec("t-greedy") });
    // Stands in for a plugin: it takes only what is marked as its own.
    registerHtmlBlockCodec("t-picky", {
      matchHTML: ["x-el"],
      parseHTML: (el) => (el.hasAttribute("data-mine") ? spec("t-picky") : null),
    });
    const parse = getHtmlParserForTag("x-el")!;
    const mine = document.createElement("x-el");
    mine.setAttribute("data-mine", "");
    expect(parse(mine, { marks: new Map() })!.type as string).toBe("t-picky");
    expect(parse(document.createElement("x-el"), { marks: new Map() })!.type as string).toBe("t-greedy");
  });
});
