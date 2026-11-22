import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedBlock } from "../createEditor";
import { docToHtml } from "../clipboard/htmlSerializer";
import { docToMarkdown } from "../markdown/serialize";
import { horizontalRulePlugin } from "../plugins/horizontal-rule";
import { mdShortcutsPlugin } from "../plugins/md-shortcuts";
import { isAtomicBlockType } from "../plugin/atomic";
import type { Block } from "../model/types";

afterEach(() => {
  clearDom();
});

function mount(blocks: SerializedBlock[] = [], opts: { shortcut?: boolean } = {}) {
  const root = makeContainer();
  const editor = createEditor({
    plugins: [horizontalRulePlugin(opts), mdShortcutsPlugin()],
    ...(blocks.length ? { initial: { blocks } } : {}),
  });
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  const ta = root.querySelector("[data-creo-edit]") as HTMLElement;
  const shape = () =>
    editor.docStore.get().order.map((id) => {
      const b = editor.docStore.get().byId.get(id) as Block & { runs?: { text: string }[] };
      return b.runs ? `${b.type}:${b.runs.map((r) => r.text).join("")}` : b.type;
    });
  return { root, editor, ta, shape };
}

function type(ta: HTMLElement, s: string): void {
  for (const ch of s) {
    ta.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true }),
    );
  }
}

const p = (id: string, text: string): SerializedBlock => ({ id, type: "p", runs: text ? [{ text }] : [] });

describe("horizontalRulePlugin", () => {
  it("is an atomic block holding an <hr>, which the caret goes around", () => {
    const { root } = mount([p("a", "above"), { id: "r", type: "hr" }, p("b", "below")]);
    expect(isAtomicBlockType("hr")).toBe(true);
    const el = root.querySelector('[data-block-id="r"]')!;
    expect(el.getAttribute("data-block-kind")).toBe("hr");
    expect(el.getAttribute("contenteditable")).toBe("false");
    expect(el.querySelector("hr")).toBeTruthy();
  });

  it("writes markdown, HTML and JSON, and reads <hr> back", () => {
    const { editor } = mount([p("a", "above"), { id: "r", type: "hr" }, p("b", "below")]);
    expect(docToMarkdown(editor.toJSON())).toBe("above\n\n---\n\nbelow\n");
    expect(docToHtml(editor.docStore.get())).toContain("<hr>");
    expect(editor.toJSON().blocks[1]).toEqual({ id: "r", type: "hr" });

    editor.setDocFromHTML("<p>one</p><hr><p>two</p>");
    expect(editor.toJSON().blocks.map((b) => b.type)).toEqual(["p", "hr", "p"]);
  });

  it("`---` as the whole line becomes a rule, with the caret on the emptied line under it", () => {
    const { editor, ta, shape } = mount();
    type(ta, "---");
    expect(shape()).toEqual(["hr", "p:"]);
    type(ta, "next");
    expect(shape()).toEqual(["hr", "p:next"]);
    editor.undo();
    editor.undo();
    expect(shape()).toEqual(["p:---"]);
  });

  it("leaves dashes inside text, and does nothing when turned off", () => {
    const text = mount();
    type(text.ta, "a---");
    expect(text.shape()).toEqual(["p:a---"]);

    const off = mount([], { shortcut: false });
    type(off.ta, "---");
    expect(off.shape()).toEqual(["p:---"]);
  });

  it("hr.insert puts a rule at the caret", () => {
    const { editor, shape } = mount([p("a", "ab")]);
    editor.selStore.set({ kind: "caret", at: { blockId: "a", path: [2], offset: 2 } });
    editor.dispatch({ t: "hr.insert" });
    expect(shape()).toContain("hr");
  });
});
