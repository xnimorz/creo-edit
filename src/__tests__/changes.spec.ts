import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedDoc } from "../createEditor";
import { mapAnchor, type DocChange } from "../model/changes";
import type { Anchor } from "../model/types";

afterEach(() => clearDom());

const A = (blockId: string, offset: number, prefix: number[] = []): Anchor => ({
  blockId,
  path: [...prefix, offset],
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

function textOf(editor: ReturnType<typeof createEditor>, id: string): string {
  const b = editor.docStore.get().byId.get(id) as { runs?: { text: string }[] };
  return (b?.runs ?? []).map((r) => r.text).join("");
}

// ---------------------------------------------------------------------------
// mapAnchor — pure
// ---------------------------------------------------------------------------

describe("mapAnchor", () => {
  const text = (
    from: number,
    to: number,
    insertedLength: number,
    blockId = "b1",
    container: number[] = [],
  ): DocChange => ({ kind: "text", blockId, container, from, to, insertedLength });

  it("leaves anchors before the edit alone", () => {
    expect(mapAnchor(A("b1", 2), [text(5, 5, 3)])).toEqual(A("b1", 2));
  });

  it("shifts anchors after an insertion", () => {
    expect(mapAnchor(A("b1", 8), [text(5, 5, 3)])).toEqual(A("b1", 11));
  });

  it("shifts anchors after a deletion", () => {
    expect(mapAnchor(A("b1", 10), [text(2, 5, 0)])).toEqual(A("b1", 7));
  });

  it("shifts anchors after a replacement", () => {
    // [2,5) (3 chars) replaced by 1 char → net -2.
    expect(mapAnchor(A("b1", 10), [text(2, 5, 1)])).toEqual(A("b1", 8));
  });

  it("returns null when the anchored text was deleted outright", () => {
    expect(mapAnchor(A("b1", 3), [text(2, 5, 0)])).toBeNull();
  });

  it("bias decides the side of a pure insertion at the anchor", () => {
    expect(mapAnchor(A("b1", 5), [text(5, 5, 3)], "right")).toEqual(A("b1", 8));
    expect(mapAnchor(A("b1", 5), [text(5, 5, 3)], "left")).toEqual(A("b1", 5));
    // Default is "right".
    expect(mapAnchor(A("b1", 5), [text(5, 5, 3)])).toEqual(A("b1", 8));
  });

  it("keeps an anchor at the left edge of a deletion", () => {
    expect(mapAnchor(A("b1", 2), [text(2, 5, 0)])).toEqual(A("b1", 2));
    // …and pulls one at the right edge back to it.
    expect(mapAnchor(A("b1", 5), [text(2, 5, 0)])).toEqual(A("b1", 2));
  });

  it("ignores edits in other blocks", () => {
    expect(mapAnchor(A("b2", 8), [text(0, 0, 5, "b1")])).toEqual(A("b2", 8));
  });

  it("distinguishes containers within one block", () => {
    // A table cell edit at [0,0] must not move an anchor in cell [1,2].
    const inCell = A("t1", 4, [1, 2]);
    const otherCell = text(0, 0, 3, "t1", [0, 0]);
    expect(mapAnchor(inCell, [otherCell])).toEqual(inCell);
    const sameCell = text(0, 0, 3, "t1", [1, 2]);
    expect(mapAnchor(inCell, [sameCell])).toEqual(A("t1", 7, [1, 2]));
  });

  it("moves an anchor past a split into the new block", () => {
    const split: DocChange = { kind: "split", blockId: "b1", at: 5, into: "b2" };
    expect(mapAnchor(A("b1", 8), [split])).toEqual(A("b2", 3));
    expect(mapAnchor(A("b1", 2), [split])).toEqual(A("b1", 2));
    // Exactly at the split point — bias picks the side.
    expect(mapAnchor(A("b1", 5), [split], "right")).toEqual(A("b2", 0));
    expect(mapAnchor(A("b1", 5), [split], "left")).toEqual(A("b1", 5));
  });

  it("moves an anchor through a merge", () => {
    const merge: DocChange = {
      kind: "merge", blockId: "b2", into: "b1", atOffset: 5,
    };
    expect(mapAnchor(A("b2", 3), [merge])).toEqual(A("b1", 8));
    expect(mapAnchor(A("b1", 3), [merge])).toEqual(A("b1", 3));
  });

  it("nulls anchors in removed or reset blocks", () => {
    expect(mapAnchor(A("b1", 3), [{ kind: "removeBlock", blockId: "b1" }])).toBeNull();
    expect(mapAnchor(A("b2", 3), [{ kind: "removeBlock", blockId: "b1" }])).toEqual(A("b2", 3));
    expect(mapAnchor(A("t1", 3, [0, 0]), [{ kind: "resetBlock", blockId: "t1" }])).toBeNull();
  });

  it("nulls everything on replaceDoc", () => {
    expect(mapAnchor(A("b1", 3), [{ kind: "replaceDoc" }])).toBeNull();
  });

  it("insertBlock does not move offsets", () => {
    const c: DocChange = { kind: "insertBlock", blockId: "new", index: 0 };
    expect(mapAnchor(A("b1", 3), [c])).toEqual(A("b1", 3));
  });

  it("applies a batch in order", () => {
    // Insert 3 at 0, then delete [0,2) — net +1 for an anchor at 5.
    const changes: DocChange[] = [text(0, 0, 3), text(0, 2, 0)];
    expect(mapAnchor(A("b1", 5), changes)).toEqual(A("b1", 6));
  });

  it("short-circuits once an anchor is gone", () => {
    const changes: DocChange[] = [
      { kind: "removeBlock", blockId: "b1" },
      text(0, 0, 100),
    ];
    expect(mapAnchor(A("b1", 3), changes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Emission from real commands — anchors must survive a round trip.
// ---------------------------------------------------------------------------

describe("change emission", () => {
  const twoParas: SerializedDoc = {
    blocks: [
      { type: "p", runs: [{ text: "hello world" }] },
      { type: "p", runs: [{ text: "second" }] },
    ],
  };

  it("insertText emits a text change at the caret", () => {
    const { editor, batches } = mount(twoParas);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 5) });
    editor.dispatch({ t: "insertText", text: "XYZ" });
    expect(batches).toEqual([
      [{ kind: "text", blockId: id, container: [], from: 5, to: 5, insertedLength: 3 }],
    ]);
  });

  it("deleteBackward emits a one-character deletion", () => {
    const { editor, batches } = mount(twoParas);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 5) });
    editor.dispatch({ t: "deleteBackward" });
    expect(batches[0]).toEqual([
      { kind: "text", blockId: id, container: [], from: 4, to: 5, insertedLength: 0 },
    ]);
  });

  it("replacing a range emits one delete-and-insert", () => {
    const { editor, batches } = mount(twoParas);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "range", anchor: A(id, 0), focus: A(id, 5) });
    editor.dispatch({ t: "insertText", text: "HI" });
    expect(textOf(editor, id)).toBe("HI world");
    expect(batches[0]).toEqual([
      { kind: "text", blockId: id, container: [], from: 0, to: 5, insertedLength: 2 },
    ]);
  });

  it("splitBlock emits a split naming the new block", () => {
    const { editor, batches } = mount(twoParas);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 5) });
    editor.dispatch({ t: "splitBlock" });
    const newId = editor.docStore.get().order[1]!;
    expect(batches[0]).toEqual([
      { kind: "split", blockId: id, at: 5, into: newId },
    ]);
  });

  it("mergeBackward emits a merge with the join offset", () => {
    const { editor, batches } = mount(twoParas);
    const ids = editor.docStore.get().order;
    editor.selStore.set({ kind: "caret", at: A(ids[1]!, 0) });
    editor.dispatch({ t: "mergeBackward" });
    expect(batches[0]).toEqual([
      { kind: "merge", blockId: ids[1]!, into: ids[0]!, atOffset: 11 },
    ]);
  });

  it("commands that move no text emit nothing", () => {
    const { editor, batches } = mount(twoParas);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "range", anchor: A(id, 0), focus: A(id, 5) });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    editor.dispatch({ t: "setBlockType", payload: { type: "h2" } });
    editor.dispatch({ t: "moveCursor", to: A(id, 1) });
    expect(batches).toEqual([]);
  });

  it("undo / redo / setDoc report replaceDoc", () => {
    const { editor, batches } = mount(twoParas);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 0) });
    editor.dispatch({ t: "insertText", text: "x" });
    editor.undo();
    editor.redo();
    editor.setDoc(twoParas);
    expect(batches.slice(1)).toEqual([
      [{ kind: "replaceDoc" }],
      [{ kind: "replaceDoc" }],
      [{ kind: "replaceDoc" }],
    ]);
  });

  it("appendBlocks / prependBlocks report insertBlock with positions", () => {
    const { editor, batches } = mount(twoParas);
    const [appended] = editor.appendBlocks([{ type: "p", runs: [] }]);
    const [prepended] = editor.prependBlocks([{ type: "p", runs: [] }]);
    expect(batches[0]).toEqual([
      { kind: "insertBlock", blockId: appended!, index: 2 },
    ]);
    expect(batches[1]).toEqual([
      { kind: "insertBlock", blockId: prepended!, index: 0 },
    ]);
  });

  it("table row insert reports the block as unmappable", () => {
    const { editor, batches } = mount({
      blocks: [
        { type: "table", rows: 2, cols: 2, cells: [[[], []], [[], []]] },
      ],
    });
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: { blockId: id, path: [0, 0, 0], offset: 0 } });
    editor.dispatch({ t: "tableInsertRow", where: "above" });
    expect(batches[0]).toEqual([{ kind: "resetBlock", blockId: id }]);
    // An anchor in that table cannot be mapped — better than a wrong guess.
    expect(mapAnchor({ blockId: id, path: [1, 1, 0], offset: 0 }, batches[0]!)).toBeNull();
  });

  it("a text edit inside a table cell is scoped to that cell", () => {
    const { editor, batches } = mount({
      blocks: [
        { type: "table", rows: 2, cols: 2, cells: [[[], []], [[], []]] },
      ],
    });
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: { blockId: id, path: [1, 0, 0], offset: 0 } });
    editor.dispatch({ t: "insertText", text: "ab" });
    expect(batches[0]).toEqual([
      { kind: "text", blockId: id, container: [1, 0], from: 0, to: 0, insertedLength: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Round trips: an anchor held by a host tracks the text it was pinned to.
// ---------------------------------------------------------------------------

describe("anchor round trips", () => {
  /** Text between two mapped anchors, i.e. what a comment would still cover. */
  function span(
    editor: ReturnType<typeof createEditor>,
    from: Anchor,
    to: Anchor,
  ): string {
    return textOf(editor, from.blockId).slice(from.offset, to.offset);
  }

  it("a comment range survives typing before it", () => {
    const { editor, batches } = mount({
      blocks: [{ type: "p", runs: [{ text: "the quick brown fox" }] }],
    });
    const id = editor.docStore.get().order[0]!;
    // Pin a "comment" on "brown".
    let from: Anchor | null = A(id, 10);
    let to: Anchor | null = A(id, 15);
    expect(span(editor, from, to)).toBe("brown");

    editor.selStore.set({ kind: "caret", at: A(id, 0) });
    editor.dispatch({ t: "insertText", text: "Well, " });

    const batch = batches[0]!;
    from = mapAnchor(from, batch, "right");
    to = mapAnchor(to, batch, "left");
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    expect(span(editor, from!, to!)).toBe("brown");
  });

  it("a comment range follows its text across a split", () => {
    const { editor, batches } = mount({
      blocks: [{ type: "p", runs: [{ text: "alpha beta gamma" }] }],
    });
    const id = editor.docStore.get().order[0]!;
    let from: Anchor | null = A(id, 11); // "gamma"
    let to: Anchor | null = A(id, 16);
    expect(span(editor, from, to)).toBe("gamma");

    editor.selStore.set({ kind: "caret", at: A(id, 6) });
    editor.dispatch({ t: "splitBlock" });

    const batch = batches[0]!;
    from = mapAnchor(from, batch, "right");
    to = mapAnchor(to, batch, "left");
    expect(from!.blockId).toBe(editor.docStore.get().order[1]!);
    expect(span(editor, from!, to!)).toBe("gamma");
  });

  it("a comment range comes back through a merge", () => {
    const { editor, batches } = mount({
      blocks: [
        { type: "p", runs: [{ text: "alpha " }] },
        { type: "p", runs: [{ text: "beta gamma" }] },
      ],
    });
    const ids = editor.docStore.get().order;
    let from: Anchor | null = A(ids[1]!, 5); // "gamma"
    let to: Anchor | null = A(ids[1]!, 10);
    expect(span(editor, from, to)).toBe("gamma");

    editor.selStore.set({ kind: "caret", at: A(ids[1]!, 0) });
    editor.dispatch({ t: "mergeBackward" });

    const batch = batches[0]!;
    from = mapAnchor(from, batch, "right");
    to = mapAnchor(to, batch, "left");
    expect(from!.blockId).toBe(ids[0]!);
    expect(span(editor, from!, to!)).toBe("gamma");
  });

  it("re-anchoring by text search would be wrong where mapping is right", () => {
    // Two identical lines: a search-based re-anchor cannot tell them apart.
    const { editor, batches } = mount({
      blocks: [
        { type: "p", runs: [{ text: "return null;" }] },
        { type: "p", runs: [{ text: "return null;" }] },
      ],
    });
    const ids = editor.docStore.get().order;
    let pinned: Anchor | null = A(ids[1]!, 7); // the SECOND "null"
    editor.selStore.set({ kind: "caret", at: A(ids[0]!, 0) });
    editor.dispatch({ t: "insertText", text: "  " });
    pinned = mapAnchor(pinned, batches[0]!);
    // Untouched: the edit was in the other block.
    expect(pinned).toEqual(A(ids[1]!, 7));
  });

  it("returns null when the pinned text is deleted", () => {
    const { editor, batches } = mount({
      blocks: [{ type: "p", runs: [{ text: "keep DELETE keep" }] }],
    });
    const id = editor.docStore.get().order[0]!;
    const pinned = A(id, 8); // inside "DELETE"
    editor.selStore.set({ kind: "range", anchor: A(id, 5), focus: A(id, 11) });
    editor.dispatch({ t: "deleteBackward" });
    expect(textOf(editor, id)).toBe("keep  keep");
    expect(mapAnchor(pinned, batches[0]!)).toBeNull();
  });

  it("maps across a multi-block range delete", () => {
    const { editor, batches } = mount({
      blocks: [
        { type: "p", runs: [{ text: "first line" }] },
        { type: "p", runs: [{ text: "middle" }] },
        { type: "p", runs: [{ text: "last line" }] },
      ],
    });
    const ids = [...editor.docStore.get().order];
    // Pin "line" at the end of the third block.
    let pinned: Anchor | null = A(ids[2]!, 5);
    editor.selStore.set({
      kind: "range",
      anchor: A(ids[0]!, 6),
      focus: A(ids[2]!, 5),
    });
    editor.dispatch({ t: "mergeBackward" });
    expect(textOf(editor, ids[0]!)).toBe("first line");
    pinned = mapAnchor(pinned, batches[0]!);
    // The end block folded into the first at offset 6.
    expect(pinned).toEqual(A(ids[0]!, 6));
    expect(editor.docStore.get().order.length).toBe(1);
  });

  it("the editor exposes the same mapAnchor", () => {
    const { editor } = mount({ blocks: [{ type: "p", runs: [{ text: "abc" }] }] });
    expect(editor.mapAnchor).toBe(mapAnchor);
  });

  it("unsubscribing stops delivery", () => {
    const { editor } = mount({ blocks: [{ type: "p", runs: [{ text: "abc" }] }] });
    const seen: DocChange[][] = [];
    const off = editor.onChange((c) => seen.push(c));
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 0) });
    editor.dispatch({ t: "insertText", text: "x" });
    expect(seen.length).toBe(1);
    off();
    editor.dispatch({ t: "insertText", text: "y" });
    expect(seen.length).toBe(1);
  });

  it("a throwing listener does not break the edit or other listeners", () => {
    const { editor } = mount({ blocks: [{ type: "p", runs: [{ text: "abc" }] }] });
    const seen: DocChange[][] = [];
    editor.onChange(() => { throw new Error("boom"); });
    editor.onChange((c) => seen.push(c));
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 0) });
    expect(editor.dispatch({ t: "insertText", text: "x" })).toBe(true);
    expect(textOf(editor, id)).toBe("xabc");
    expect(seen.length).toBe(1);
  });
});
