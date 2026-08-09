import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { caretAt } from "../controller/selection";
import { newBlockId } from "../model/doc";
import {
  createHistory,
  HISTORY_CAP,
  HISTORY_MAX_BLOCK_SLOTS,
} from "../controller/history";
import type { DocState, Selection } from "../model/types";

afterEach(() => clearDom());

function setup(text = "hello") {
  const root = makeContainer();
  const id = newBlockId();
  const editor = createEditor({
    initial: { blocks: [{ id, type: "p", runs: [{ text }] }] },
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(root),
    SYNC_SCHEDULER,
  ).mount();
  return { root, editor, id };
}

describe("Undo / redo", () => {
  it("undo restores the doc + selection before the last command", () => {
    const { editor, id } = setup("hello");
    editor.selStore.set({ kind: "caret", at: caretAt(id, 5) });
    editor.dispatch({ t: "insertText", text: "!" });
    expect(blockText(editor, id)).toBe("hello!");
    editor.undo();
    expect(blockText(editor, id)).toBe("hello");
    const sel = editor.selStore.get();
    if (sel.kind === "caret") expect(sel.at.offset).toBe(5);
  });

  it("redo replays an undone command", () => {
    const { editor, id } = setup("hi");
    editor.selStore.set({ kind: "caret", at: caretAt(id, 2) });
    editor.dispatch({ t: "insertText", text: "!" });
    editor.undo();
    editor.redo();
    expect(blockText(editor, id)).toBe("hi!");
  });

  it("multiple consecutive insertText collapse into one undo entry", () => {
    const { editor, id } = setup("");
    editor.selStore.set({ kind: "caret", at: caretAt(id, 0) });
    editor.dispatch({ t: "insertText", text: "h" });
    editor.dispatch({ t: "insertText", text: "i" });
    editor.dispatch({ t: "insertText", text: "!" });
    expect(blockText(editor, id)).toBe("hi!");
    editor.undo();
    // Coalesce: one undo wipes ALL three keystrokes.
    expect(blockText(editor, id)).toBe("");
  });

  it("undo at empty stack is a no-op", () => {
    const { editor, id } = setup("hi");
    editor.undo();
    expect(blockText(editor, id)).toBe("hi");
  });

  it("non-text commands do not coalesce", () => {
    const { editor, id } = setup("hello world");
    editor.selStore.set({ kind: "caret", at: caretAt(id, 6) });
    editor.dispatch({ t: "splitBlock" });
    editor.dispatch({ t: "splitBlock" });
    expect(editor.docStore.get().order.length).toBe(3);
    editor.undo();
    expect(editor.docStore.get().order.length).toBe(2);
    editor.undo();
    expect(editor.docStore.get().order.length).toBe(1);
  });

  it("a new edit invalidates the redo stack", () => {
    const { editor, id } = setup("hi");
    editor.selStore.set({ kind: "caret", at: caretAt(id, 2) });
    editor.dispatch({ t: "insertText", text: "!" });
    editor.undo();
    editor.dispatch({ t: "insertText", text: "?" });
    editor.redo();
    // redo had nothing to do — the "?" stays.
    expect(blockText(editor, id)).toBe("hi?");
  });

  it("setDocFromHTML clears history", () => {
    const { editor, id } = setup("hi");
    editor.dispatch({ t: "insertText", text: "!" });
    editor.setDocFromHTML("<p>fresh</p>");
    editor.undo();
    // doc still shows the new content — undo couldn't roll back past reset.
    let txt = "";
    const doc = editor.docStore.get();
    for (const bid of doc.order) {
      const b = doc.byId.get(bid)!;
      if (b.type === "p") for (const r of b.runs) txt += r.text;
    }
    expect(txt).toBe("fresh");
    void id;
  });
});

function blockText(editor: ReturnType<typeof createEditor>, id: string): string {
  const b = editor.docStore.get().byId.get(id)!;
  if (b.type !== "p") return "";
  let s = "";
  for (const r of b.runs) s += r.text;
  return s;
}

// ---------------------------------------------------------------------------
// Depth is bounded by retained cost as well as entry count: an entry pins a
// whole `DocState`, whose `byId` map is one slot per block. At 50 000
// one-line blocks, 250 unbounded steps grew the heap by 926MB.
// ---------------------------------------------------------------------------

describe("history depth caps", () => {
  function fakeStores(blockCount: number) {
    let doc: DocState = {
      byId: new Map(),
      order: Array.from({ length: blockCount }, (_v, i) => `b${i}`),
    };
    let sel: Selection = { kind: "caret", at: caretAt("b0", 0) };
    const mkStore = <T,>(get: () => T, set: (v: T) => void) =>
      ({ get, set, subscribe: () => () => {} }) as never;
    return {
      docStore: mkStore(() => doc, (v: DocState) => { doc = v; }),
      selStore: mkStore(() => sel, (v: Selection) => { sel = v; }),
      // A distinct doc identity per edit, the way a real mutation produces one.
      touch: () => { doc = { byId: doc.byId, order: doc.order.slice() }; },
    };
  }

  it("keeps the full entry cap for ordinary documents", () => {
    const s = fakeStores(50);
    const h = createHistory({ docStore: s.docStore, selStore: s.selStore });
    for (let i = 0; i < HISTORY_CAP + 40; i++) {
      h.record(`edit:${i}`);
      s.touch();
    }
    let depth = 0;
    while (h.undo()) depth++;
    expect(depth).toBe(HISTORY_CAP);
  });

  it("trades depth for bounded memory on a very large document", () => {
    const blocks = 50_000;
    const s = fakeStores(blocks);
    const h = createHistory({ docStore: s.docStore, selStore: s.selStore });
    for (let i = 0; i < HISTORY_CAP; i++) {
      h.record(`edit:${i}`);
      s.touch();
    }
    let depth = 0;
    while (h.undo()) depth++;
    // Bounded by cost, not by count…
    expect(depth).toBeLessThan(HISTORY_CAP);
    expect(depth * blocks).toBeLessThanOrEqual(HISTORY_MAX_BLOCK_SLOTS);
    // …but never trimmed down to nothing.
    expect(depth).toBeGreaterThanOrEqual(10);
  });
});
