import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { mdShortcutsPlugin } from "../plugins/md-shortcuts";

afterEach(() => {
  clearDom();
});

function mount() {
  const root = makeContainer();
  const editor = createEditor({
    plugins: [mdShortcutsPlugin()],
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(root),
    SYNC_SCHEDULER,
  ).mount();
  const ta = root.querySelector("[data-creo-edit]") as HTMLElement;
  return { root, editor, ta };
}

function typeChar(ta: HTMLElement, ch: string): void {
  const ev = new (globalThis as { InputEvent: typeof InputEvent }).InputEvent(
    "beforeinput",
    { inputType: "insertText", data: ch, bubbles: true, cancelable: true },
  );
  ta.dispatchEvent(ev);
}

function typeText(ta: HTMLElement, s: string): void {
  for (const ch of s) typeChar(ta, ch);
}

describe("md-shortcuts plugin", () => {
  it("'# ' at the start of a paragraph promotes it to h1", () => {
    const { editor, ta } = mount();
    typeText(ta, "# ");
    const id = editor.docStore.get().order[0]!;
    const block = editor.docStore.get().byId.get(id)!;
    expect(block.type).toBe("h1");
  });

  it("'## ' promotes to h2", () => {
    const { editor, ta } = mount();
    typeText(ta, "## ");
    const id = editor.docStore.get().order[0]!;
    const block = editor.docStore.get().byId.get(id)!;
    expect(block.type).toBe("h2");
  });

  it("'- ' converts paragraph to a bulleted list item", () => {
    const { editor, ta } = mount();
    typeText(ta, "- ");
    const id = editor.docStore.get().order[0]!;
    const block = editor.docStore.get().byId.get(id)!;
    expect(block.type).toBe("li");
    if (block.type === "li") {
      expect(block.ordered).toBe(false);
    }
  });

  it("'1. ' converts to an ordered list item", () => {
    const { editor, ta } = mount();
    typeText(ta, "1. ");
    const id = editor.docStore.get().order[0]!;
    const block = editor.docStore.get().byId.get(id)!;
    expect(block.type).toBe("li");
    if (block.type === "li") {
      expect(block.ordered).toBe(true);
    }
  });

  it("does NOT trigger on '# ' in the middle of an existing block", () => {
    const { editor, ta } = mount();
    typeText(ta, "abc");
    typeText(ta, "# ");
    const id = editor.docStore.get().order[0]!;
    const block = editor.docStore.get().byId.get(id)!;
    expect(block.type).toBe("p");
  });
});
