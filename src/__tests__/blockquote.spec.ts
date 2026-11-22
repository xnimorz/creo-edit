import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedBlock } from "../createEditor";
import { docToHtml } from "../clipboard/htmlSerializer";
import { docToMarkdown } from "../markdown/serialize";
import { blockquotePlugin } from "../plugins/blockquote";
import { mdShortcutsPlugin } from "../plugins/md-shortcuts";
import { isTextBearingType } from "../plugin/textBearing";
import type { Block } from "../model/types";

afterEach(() => {
  clearDom();
});

function mount(blocks: SerializedBlock[] = [], opts: { shortcut?: boolean } = {}) {
  const root = makeContainer();
  const editor = createEditor({
    plugins: [blockquotePlugin(opts), mdShortcutsPlugin()],
    ...(blocks.length ? { initial: { blocks } } : {}),
  });
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  const ta = root.querySelector("[data-creo-edit]") as HTMLElement;
  const shape = () =>
    editor.docStore.get().order.map((id) => {
      const b = editor.docStore.get().byId.get(id) as Block & { runs?: { text: string }[] };
      return `${b.type}:${(b.runs ?? []).map((r) => r.text).join("")}`;
    });
  const caretAt = (id: string, offset: number) =>
    editor.selStore.set({ kind: "caret", at: { blockId: id, path: [offset], offset } });
  return { root, editor, ta, shape, caretAt };
}

function type(ta: HTMLElement, s: string): void {
  for (const ch of s) {
    ta.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true }),
    );
  }
}

function key(ta: HTMLElement, name: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return ev;
}

const quote = (id: string, text: string): SerializedBlock => ({
  id,
  type: "blockquote",
  runs: text ? [{ text }] : [],
});

describe("blockquotePlugin", () => {
  it("is a text-bearing block drawn as a <blockquote>", () => {
    const { root } = mount([quote("q", "Said once")]);
    expect(isTextBearingType("blockquote")).toBe(true);
    const el = root.querySelector('blockquote[data-block-id="q"]')!;
    expect(el.getAttribute("data-block-kind")).toBe("blockquote");
    expect(el.textContent).toBe("Said once");
  });

  it("writes markdown, HTML and JSON, and reads HTML back", () => {
    const { editor } = mount([quote("q", "A *b*"), quote("e", ""), { id: "p", type: "p", runs: [{ text: "after" }] }]);
    expect(docToMarkdown(editor.toJSON())).toBe("> A \\*b\\*\n\n>\n\nafter\n");
    expect(docToHtml(editor.docStore.get())).toContain("<blockquote>A *b*</blockquote>");
    expect(editor.toJSON().blocks[0]).toEqual({ id: "q", type: "blockquote", runs: [{ text: "A *b*" }] });

    editor.setDocFromHTML("<blockquote>Quoted <b>bold</b></blockquote><p>plain</p>");
    const [first] = editor.toJSON().blocks;
    expect(first).toMatchObject({ type: "blockquote", runs: [{ text: "Quoted " }, { text: "bold", marks: { b: null } }] });
  });

  it("`> ` at the start of a paragraph quotes it; elsewhere it is text", () => {
    const { ta, shape } = mount();
    type(ta, "> hello");
    expect(shape()).toEqual(["blockquote:hello"]);

    const other = mount();
    type(other.ta, "a > b");
    expect(other.shape()).toEqual(["p:a > b"]);

    const off = mount([], { shortcut: false });
    type(off.ta, "> x");
    expect(off.shape()).toEqual(["p:> x"]);
  });

  it("Enter continues the quote, and Enter on an empty quoted line ends it", () => {
    const { ta, shape, caretAt } = mount([quote("q", "one")]);
    caretAt("q", 3);
    expect(key(ta, "Enter").defaultPrevented).toBe(true);
    type(ta, "two");
    expect(shape()).toEqual(["blockquote:one", "blockquote:two"]);

    key(ta, "Enter");
    expect(shape()).toEqual(["blockquote:one", "blockquote:two", "blockquote:"]);
    key(ta, "Enter");
    expect(shape()).toEqual(["blockquote:one", "blockquote:two", "p:"]);
  });

  it("leaves an Enter that confirms an IME composition to the IME", () => {
    const { ta, shape, caretAt } = mount([quote("q", "one")]);
    caretAt("q", 3);
    const ev = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(shape()).toEqual(["blockquote:one"]);
  });

  it("Backspace at the start of a quoted line unquotes it, and anywhere else deletes", () => {
    const { ta, shape, caretAt } = mount([quote("q", "abc")]);
    caretAt("q", 2);
    expect(key(ta, "Backspace").defaultPrevented).toBe(false);
    caretAt("q", 0);
    expect(key(ta, "Backspace").defaultPrevented).toBe(true);
    expect(shape()).toEqual(["p:abc"]);
  });

  it("each key is one undo step", () => {
    const { editor, ta, shape, caretAt } = mount([quote("q", "one")]);
    caretAt("q", 3);
    key(ta, "Enter");
    expect(shape()).toEqual(["blockquote:one", "blockquote:"]);
    editor.undo();
    expect(shape()).toEqual(["blockquote:one"]);
  });

  it("blockquote.toggle quotes and unquotes, and setBlockType reaches it", () => {
    const { editor, shape, caretAt } = mount([{ id: "p", type: "p", runs: [{ text: "x" }] }]);
    caretAt("p", 0);
    editor.dispatch({ t: "blockquote.toggle" });
    expect(shape()).toEqual(["blockquote:x"]);
    editor.dispatch({ t: "blockquote.toggle" });
    expect(shape()).toEqual(["p:x"]);
    editor.dispatch({ t: "setBlockType", payload: { type: "blockquote" } });
    expect(shape()).toEqual(["blockquote:x"]);
  });
});
