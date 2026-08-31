// ---------------------------------------------------------------------------
// moveBlock / insertBlocks / removeBlocks / replaceBlocks — the structural
// commands, and how they differ from a wholesale `setDoc`.
//
// The thing under test in most of these is not just the mutation but its two
// side effects: an entry on the undo stack and a DocChange on the stream.
// Both were missing when these paths wrote to `docStore` directly.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedDoc } from "../createEditor";
import type { DocChange } from "../model/changes";
import type { Anchor, InlineRun } from "../model/types";

afterEach(() => clearDom());

const A = (blockId: string, offset: number): Anchor => ({
  blockId,
  path: [offset],
  offset,
});

function mount(initial: SerializedDoc) {
  const container = makeContainer();
  const editor = createEditor({ initial });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const batches: DocChange[][] = [];
  editor.onChange((c) => batches.push(c));
  return { editor, batches, container };
}

const textOf = (editor: ReturnType<typeof createEditor>, id: string): string =>
  ((editor.docStore.get().byId.get(id) as { runs?: InlineRun[] })?.runs ?? [])
    .map((r) => r.text)
    .join("");

const threeParas: SerializedDoc = {
  blocks: [
    { id: "a", type: "p", runs: [{ text: "a" }] },
    { id: "b", type: "p", runs: [{ text: "b" }] },
    { id: "c", type: "p", runs: [{ text: "c" }] },
  ],
};

describe("moveBlock", () => {
  it("reorders, emits a change, and is undoable", () => {
    const { editor, batches } = mount(threeParas);
    expect(editor.dispatch({ t: "moveBlock", payload: { blockId: "a", toIndex: 2 } })).toBe(true);
    expect(editor.docStore.get().order).toEqual(["b", "c", "a"]);
    expect(batches[0]).toEqual([{ kind: "moveBlock", blockId: "a", from: 0, to: 2 }]);
    editor.undo();
    expect(editor.docStore.get().order).toEqual(["a", "b", "c"]);
  });

  it("moving a block to its own position is a no-op", () => {
    const { editor, batches } = mount(threeParas);
    expect(editor.dispatch({ t: "moveBlock", payload: { blockId: "a", toIndex: 0 } })).toBe(false);
    expect(batches).toEqual([]);
  });
});

describe("insertBlocks", () => {
  it("inserts before an id, emits insertBlock, and is undoable", () => {
    const { editor, batches } = mount(threeParas);
    expect(
      editor.dispatch({
        t: "insertBlocks",
        payload: { blocks: [{ id: "new", type: "p", runs: [] }], before: "b" },
      }),
    ).toBe(true);
    expect(editor.docStore.get().order).toEqual(["a", "new", "b", "c"]);
    expect(batches[0]).toEqual([{ kind: "insertBlock", blockId: "new", index: 1 }]);
    editor.undo();
    expect(editor.docStore.get().order).toEqual(["a", "b", "c"]);
  });

  it("refuses a missing anchor rather than guessing a position", () => {
    const { editor } = mount(threeParas);
    expect(
      editor.dispatch({
        t: "insertBlocks",
        payload: { blocks: [{ type: "p", runs: [] }], before: "gone" },
      }),
    ).toBe(false);
  });
});

describe("removeBlocks", () => {
  it("emits removeBlock per id and repairs the caret", () => {
    const { editor, batches } = mount(threeParas);
    editor.selStore.set({ kind: "caret", at: A("b", 1) });
    expect(editor.dispatch({ t: "removeBlocks", blockIds: ["b"] })).toBe(true);
    expect(batches[0]).toEqual([{ kind: "removeBlock", blockId: "b" }]);
    const sel = editor.selStore.get() as { kind: "caret"; at: Anchor };
    expect(sel.kind).toBe("caret");
    expect(editor.docStore.get().byId.has(sel.at.blockId)).toBe(true);
  });
});

describe("replaceBlocks — the targeted-update path", () => {
  const doc: SerializedDoc = {
    blocks: [
      { id: "a", type: "p", runs: [{ text: "one" }] },
      { id: "b", type: "p", runs: [{ text: "two" }] },
    ],
  };

  it("updates in place, keeping untouched block identity, caret and undo", () => {
    const { editor, batches } = mount(doc);
    const before = editor.docStore.get().byId.get("b")!;
    editor.selStore.set({ kind: "caret", at: A("b", 3) });
    expect(
      editor.dispatch({
        t: "replaceBlocks",
        blocks: [{ id: "a", type: "p", runs: [{ text: "ONE!" }] }],
      }),
    ).toBe(true);
    expect(textOf(editor, "a")).toBe("ONE!");
    // `b` is the SAME object, so the renderer skips it entirely.
    expect(editor.docStore.get().byId.get("b")).toBe(before);
    expect((editor.selStore.get() as { at: Anchor }).at.blockId).toBe("b");
    expect(batches[0]).toEqual([{ kind: "resetBlock", blockId: "a" }]);
    // …and undoable, which setDoc never is.
    editor.undo();
    expect(textOf(editor, "a")).toBe("one");
  });

  it("appends a block with an unknown id", () => {
    const { editor } = mount(doc);
    editor.dispatch({
      t: "replaceBlocks",
      blocks: [{ id: "c", type: "p", runs: [{ text: "three" }] }],
    });
    expect(editor.docStore.get().order).toEqual(["a", "b", "c"]);
  });
});

describe("setDoc options", () => {
  const doc: SerializedDoc = {
    blocks: [
      { id: "a", type: "p", runs: [{ text: "one" }] },
      { id: "b", type: "p", runs: [{ text: "two" }] },
    ],
  };

  it("resets selection and history by default", () => {
    const { editor } = mount(doc);
    editor.selStore.set({ kind: "caret", at: A("a", 1) });
    editor.dispatch({ t: "insertText", text: "X" });
    editor.setDoc(doc);
    editor.undo();
    // History was cleared, so undo has nothing to restore.
    expect(textOf(editor, "a")).toBe("one");
  });

  it("preserveSelection clamps the caret onto the new document", () => {
    const { editor } = mount(doc);
    editor.selStore.set({ kind: "caret", at: A("b", 3) });
    editor.setDoc(
      { blocks: [{ id: "b", type: "p", runs: [{ text: "t" }] }] },
      { preserveSelection: true },
    );
    const sel = editor.selStore.get() as { kind: "caret"; at: Anchor };
    expect(sel.at.blockId).toBe("b");
    expect(sel.at.offset).toBe(1); // clamped to the shorter text
  });

  it("preserveHistory keeps the undo stack across a swap", () => {
    const { editor } = mount(doc);
    editor.selStore.set({ kind: "caret", at: A("a", 3) });
    editor.dispatch({ t: "insertText", text: "X" });
    editor.setDoc(editor.toJSON(), { preserveHistory: true });
    editor.undo();
    expect(textOf(editor, "a")).toBe("one");
  });
});
