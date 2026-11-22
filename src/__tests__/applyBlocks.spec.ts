import { describe, expect, it } from "bun:test";
import "./setup";

import { createEditor } from "../createEditor";
import { caretAt } from "../controller/selection";
import { mapAnchor, type DocChange } from "../model/changes";
import { changesBetween } from "../model/docChanges";
import { docFromBlocks } from "../model/doc";
import type { BlockSpec } from "../model/types";

const p = (id: string, text: string) => ({ id, type: "p" as const, runs: [{ text }] });

function editorWith(...blocks: ReturnType<typeof p>[]) {
  return createEditor({ initial: { blocks } });
}

describe("applyBlocks", () => {
  it("replaces a block's text as one text change over what differs", () => {
    const editor = editorWith(p("a", "hello world"), p("b", "keep"));
    const untouched = editor.docStore.get().byId.get("b");
    const seen: DocChange[] = [];
    editor.onChange((c) => seen.push(...c));
    editor.selStore.set({ kind: "caret", at: caretAt("a", 11) });

    editor.applyBlocks({ replace: [p("a", "hello brave world")] });

    expect(editor.getText("a")).toBe("hello brave world");
    expect(seen).toEqual([{ kind: "text", blockId: "a", container: [], from: 6, to: 6, insertedLength: 6 }]);
    expect(editor.docStore.get().byId.get("b")).toBe(untouched!);
    const sel = editor.selStore.get();
    expect(sel.kind === "caret" && sel.at.offset).toBe(17);
  });

  it("an anchor held outside maps through the patch", () => {
    const editor = editorWith(p("a", "one two three"));
    let changes: DocChange[] = [];
    editor.onChange((c) => (changes = c));
    editor.applyBlocks({ replace: [p("a", "zero one two three")] });
    expect(mapAnchor(caretAt("a", 4), changes)?.offset).toBe(9);
  });

  it("is not gated by editable, and records no undo step unless asked", () => {
    const editor = createEditor({ editable: false, initial: { blocks: [p("a", "x")] } });
    editor.applyBlocks({ replace: [p("a", "y")] });
    expect(editor.getText()).toBe("y");

    const live = editorWith(p("a", "x"));
    live.applyBlocks({ replace: [p("a", "y")] }, { history: true });
    live.undo();
    expect(live.getText()).toBe("x");
  });

  it("removes, then inserts where it is told", () => {
    const editor = editorWith(p("a", "A"), p("b", "B"), p("c", "C"));
    const ids = editor.applyBlocks({
      remove: ["b"],
      insert: [
        { blocks: [p("s", "start")], after: null },
        { blocks: [p("m", "mid")], before: "c" },
        { blocks: [p("e", "end")] },
      ],
    });
    expect(ids).toEqual(["s", "m", "e"]);
    expect(editor.docStore.get().order).toEqual(["s", "a", "m", "c", "e"]);
  });

  it("an empty patch changes nothing and says nothing", () => {
    const editor = editorWith(p("a", "A"));
    let calls = 0;
    editor.onChange(() => calls++);
    const before = editor.docStore.get();
    editor.applyBlocks({ replace: [p("zzz", "nope")] });
    expect(editor.docStore.get()).toBe(before);
    expect(calls).toBe(0);
  });
});

describe("changesBetween", () => {
  const doc = (...blocks: BlockSpec[]) => docFromBlocks(blocks);

  it("reports the fewest moves", () => {
    const a = doc(p("1", "1"), p("2", "2"), p("3", "3"), p("4", "4"));
    const b = docFromBlocks(["2", "3", "4", "1"].map((id) => a.byId.get(id)!) as never);
    const moves = changesBetween(a, b).filter((c) => c.kind === "moveBlock");
    expect(moves).toEqual([{ kind: "moveBlock", blockId: "1", from: 0, to: 3 }]);
  });

  it("a type change with the same text keeps anchors", () => {
    const a = doc(p("1", "title"));
    const b = doc({ id: "1", type: "h1", runs: [{ text: "title" }] } as BlockSpec);
    const changes = changesBetween(a, b);
    expect(changes).toEqual([{ kind: "blockAttrs", blockId: "1", type: "h1" }]);
    expect(mapAnchor(caretAt("1", 3), changes)?.offset).toBe(3);
  });
});
