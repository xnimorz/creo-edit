import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom } from "./setup";

import { createEditor } from "../createEditor";
import { caretAt } from "../controller/selection";

// ---------------------------------------------------------------------------
// Reading text out of the editor. `toJSON()` used to be the only way, and a
// host that wants "the current text of this file" — to hash it, diff it
// against disk, hand it to a language server — paid a full document
// serialization every time, several times per keystroke.
// ---------------------------------------------------------------------------

afterEach(clearDom);

describe("editor.getText", () => {
  it("joins blocks with newlines", () => {
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "h1", runs: [{ text: "Title" }] },
          { type: "p", runs: [{ text: "one " }, { text: "two", marks: ["b"] }] },
        ],
      },
    });
    expect(editor.getText()).toBe("Title\none two");
  });

  it("reads a single block by id", () => {
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "p", runs: [{ text: "first" }] },
          { type: "code", runs: [{ text: "a\nb\nc" }] },
        ],
      },
    });
    const [, codeId] = editor.docStore.get().order;
    expect(editor.getText(codeId!)).toBe("a\nb\nc");
    expect(editor.getText("nope")).toBe("");
  });

  it("counts characters exactly as anchors do", () => {
    const editor = createEditor({
      initial: { blocks: [{ type: "code", runs: [{ text: "alpha\nbeta" }] }] },
    });
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: caretAt(id, 10) });
    editor.dispatch({ t: "insertText", text: "!" });
    // Offset 10 is the end of "beta" — the newline is a real character in
    // both the model and `getText`, so the two agree on where that is.
    expect(editor.getText(id)).toBe("alpha\nbeta!");
  });

  it("flattens cell blocks: tabs across, newlines down", () => {
    const editor = createEditor({
      initial: {
        blocks: [
          {
            type: "table",
            rows: 2,
            cols: 2,
            cells: [
              [[{ text: "a" }], [{ text: "b" }]],
              [[{ text: "c" }], []],
            ],
          },
          { type: "columns", cols: 2, cells: [[{ text: "L" }], [{ text: "R" }]] },
        ],
      },
    });
    expect(editor.getText()).toBe("a\tb\nc\t\nL\tR");
  });

  it("skips atomic blocks rather than inventing text for them", () => {
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "p", runs: [{ text: "before" }] },
          { type: "img", src: "x.png" },
          { type: "p", runs: [{ text: "after" }] },
        ],
      },
    });
    expect(editor.getText()).toBe("before\n\nafter");
  });
});

describe("editor.toJSON", () => {
  it("returns the same object until the document changes", () => {
    const editor = createEditor({
      initial: { blocks: [{ type: "p", runs: [{ text: "hello" }] }] },
    });
    const a = editor.toJSON();
    expect(editor.toJSON()).toBe(a);

    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: caretAt(id, 5) });
    editor.dispatch({ t: "insertText", text: "!" });

    const b = editor.toJSON();
    expect(b).not.toBe(a);
    const textOf = (doc: typeof a) =>
      (doc.blocks[0] as { runs: { text: string }[] }).runs[0]!.text;
    expect(textOf(b)).toBe("hello!");
    // …and the old value wasn't mutated in place under the caller's feet.
    expect(textOf(a)).toBe("hello");
  });
});
