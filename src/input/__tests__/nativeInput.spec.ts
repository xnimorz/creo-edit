import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { clearDom, makeContainer } from "../../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../../createEditor";
import type { SerializedDoc } from "../../createEditor";
import type { BlockSpec } from "../../model/types";
import { newBlockId } from "../../model/doc";
import { caretAt } from "../../controller/selection";
import { findBlockElementById } from "../../dom/anchorMap";

afterEach(() => {
  clearDom();
});

function mount(blocks: BlockSpec[]): {
  root: HTMLElement;
  editorRoot: HTMLElement;
  editor: ReturnType<typeof createEditor>;
  ids: string[];
} {
  const root = makeContainer();
  const ids = blocks.map((b) => b.id);
  const initial: SerializedDoc = {
    blocks: blocks.map((b) => ({ ...b } as never)),
  };
  const editor = createEditor({ initial });
  createApp(() => editor.EditorView(), new HtmlRender(root)).mount();
  const editorRoot = root.querySelector("[data-creo-edit]") as HTMLElement;
  return { root, editorRoot, editor, ids };
}

function spec(over: Partial<BlockSpec> & { type: BlockSpec["type"] }): BlockSpec {
  return { id: newBlockId(), ...over } as BlockSpec;
}

function fireBeforeInput(
  target: EventTarget,
  inputType: string,
  data: string | null,
): boolean {
  const ev = new (globalThis as { Event: typeof Event }).Event(
    "beforeinput",
    { bubbles: true, cancelable: true },
  );
  Object.defineProperty(ev, "data", { value: data, configurable: true });
  Object.defineProperty(ev, "inputType", {
    value: inputType,
    configurable: true,
  });
  return target.dispatchEvent(ev);
}

function blockText(editor: ReturnType<typeof createEditor>, id: string): string {
  const b = editor.docStore.get().byId.get(id);
  if (!b) return "";
  if ("runs" in b) return b.runs.map((r) => r.text).join("");
  return "";
}

// ---------------------------------------------------------------------------
// Mount surface
// ---------------------------------------------------------------------------

describe("nativeInput — mount surface", () => {
  it("editor root is contenteditable when the flag is on", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "p", runs: [{ text: "hello" }] }),
    ]);
    expect(editorRoot.getAttribute("contenteditable")).toBe("true");
  });

  it("does NOT render HiddenInput / CaretOverlay / SelectionHandles", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "p", runs: [{ text: "x" }] }),
    ]);
    expect(editorRoot.querySelector("textarea[data-creo-input]")).toBeNull();
    // CaretOverlay paints a div with class containing "caret-overlay" or
    // similar; the simplest signal is "no element with role='presentation'
    // showing a blinking caret". Inspect by class fragment.
    const overlays = editorRoot.querySelectorAll('[class*="caret"]');
    expect(overlays.length).toBe(0);
  });

  it("default options mount as contenteditable (no textarea)", () => {
    const root = makeContainer();
    const editor = createEditor();
    createApp(() => editor.EditorView(), new HtmlRender(root)).mount();
    const editorRoot = root.querySelector("[data-creo-edit]") as HTMLElement;
    expect(editorRoot.getAttribute("contenteditable")).toBe("true");
    expect(
      editorRoot.querySelector("textarea[data-creo-input]"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// beforeinput → command dispatch
// ---------------------------------------------------------------------------

describe("nativeInput — beforeinput dispatching", () => {
  it("insertText inserts at current selection", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "hi" }] }),
    ]);
    // Selection ends up at end of doc by default — at end of "hi".
    expect(blockText(editor, id)).toBe("hi");
    const cancelled = !fireBeforeInput(editorRoot, "insertText", "X");
    expect(cancelled).toBe(true);
    expect(blockText(editor, id)).toBe("hiX");
  });

  it("deleteContentBackward removes one character", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "abc" }] }),
    ]);
    fireBeforeInput(editorRoot, "deleteContentBackward", null);
    expect(blockText(editor, id)).toBe("ab");
  });

  it("insertParagraph splits the block", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "split" }] }),
    ]);
    // Move caret to middle.
    editor.selStore.set({ kind: "caret", at: caretAt(id, 2) });
    fireBeforeInput(editorRoot, "insertParagraph", null);
    const order = editor.docStore.get().order;
    expect(order.length).toBe(2);
    expect(blockText(editor, order[0]!)).toBe("sp");
    expect(blockText(editor, order[1]!)).toBe("lit");
  });

  it("formatBold toggles the bold mark", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "abc" }] }),
    ]);
    // Select "ab".
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 0),
      focus: caretAt(id, 2),
    });
    fireBeforeInput(editorRoot, "formatBold", null);
    const block = editor.docStore.get().byId.get(id)!;
    if ("runs" in block) {
      const bolded = block.runs.find((r) => r.marks?.has("b"));
      expect(bolded?.text).toBe("ab");
    } else {
      throw new Error("expected text-bearing block");
    }
  });

  it("composition events are NOT preventDefaulted (Phase 3 owns IME)", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "p", runs: [{ text: "" }] }),
    ]);
    const cancelled = !fireBeforeInput(
      editorRoot,
      "insertCompositionText",
      "あ",
    );
    expect(cancelled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Selection: programmatic Anchor → native Range
// ---------------------------------------------------------------------------

describe("nativeInput — selection sync (anchor → native)", () => {
  it("setting selStore updates window.getSelection", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "hello" }] }),
    ]);
    editor.selStore.set({ kind: "caret", at: caretAt(id, 3) });
    const native = document.getSelection();
    expect(native).not.toBeNull();
    if (!native || native.rangeCount === 0) return;
    const range = native.getRangeAt(0);
    const blockEl = findBlockElementById(editorRoot, id)!;
    expect(blockEl.contains(range.startContainer)).toBe(true);
    if (range.startContainer.nodeType === 3) {
      expect(range.startOffset).toBe(3);
    }
  });

  it("selecting a range maps both endpoints to native", () => {
    const id = newBlockId();
    const { editor } = mount([
      spec({ id, type: "p", runs: [{ text: "abcdef" }] }),
    ]);
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 1),
      focus: caretAt(id, 4),
    });
    const native = document.getSelection();
    if (!native || native.rangeCount === 0) {
      throw new Error("native selection expected");
    }
    const r = native.getRangeAt(0);
    expect(r.startOffset).toBe(1);
    expect(r.endOffset).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Keymap → command dispatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structural blocks (Phase 4): tables, columns, img
// ---------------------------------------------------------------------------

describe("nativeInput — structural blocks", () => {
  it("typing inside a table cell updates the model correctly", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({
        id,
        type: "table",
        rows: 2,
        cols: 2,
        cells: [
          [[{ text: "" }], [{ text: "" }]],
          [[{ text: "" }], [{ text: "" }]],
        ],
      }),
    ]);
    // Place caret in cell (1, 1).
    editor.selStore.set({
      kind: "caret",
      at: { blockId: id, path: [1, 1, 0], offset: 0 },
    });
    fireBeforeInput(editorRoot, "insertText", "X");
    const block = editor.docStore.get().byId.get(id)!;
    if (block.type !== "table") throw new Error("expected table");
    expect(block.cells[1]![1]!.map((r) => r.text).join("")).toBe("X");
    // Other cells untouched.
    expect(block.cells[0]![0]!.map((r) => r.text).join("")).toBe("");
    expect(block.cells[0]![1]!.map((r) => r.text).join("")).toBe("");
    expect(block.cells[1]![0]!.map((r) => r.text).join("")).toBe("");
  });

  it("typing inside a columns cell updates the right column", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({
        id,
        type: "columns",
        cols: 3,
        cells: [[{ text: "" }], [{ text: "" }], [{ text: "" }]],
      }),
    ]);
    editor.selStore.set({
      kind: "caret",
      at: { blockId: id, path: [1, 0], offset: 0 },
    });
    fireBeforeInput(editorRoot, "insertText", "Y");
    const block = editor.docStore.get().byId.get(id)!;
    if (block.type !== "columns") throw new Error("expected columns");
    expect(block.cells[0]!.map((r) => r.text).join("")).toBe("");
    expect(block.cells[1]!.map((r) => r.text).join("")).toBe("Y");
    expect(block.cells[2]!.map((r) => r.text).join("")).toBe("");
  });

  it("img block elements are contenteditable=false (atomic to caret)", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "img", src: "x.png", alt: "x" }),
    ]);
    const imgBlock = editorRoot.querySelector(
      '[data-block-kind="img"]',
    ) as HTMLElement;
    expect(imgBlock.getAttribute("contenteditable")).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// IME composition (Phase 3)
//
// We mimic what the browser does during composition: mutate the DOM in
// place between compositionstart and compositionend so that the
// reconciliation logic's textContent diff has something to read.
// ---------------------------------------------------------------------------

function fireComposition(target: EventTarget, type: "start" | "end"): void {
  const ev = new (globalThis as { Event: typeof Event }).Event(
    `composition${type}`,
    { bubbles: true, cancelable: true },
  );
  target.dispatchEvent(ev);
}

describe("nativeInput — IME composition reconciliation", () => {
  it("composition that inserts text into a paragraph", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "hi" }] }),
    ]);
    // Caret at end of "hi".
    editor.selStore.set({ kind: "caret", at: caretAt(id, 2) });
    fireComposition(editorRoot, "start");
    // Browser writes the composition output into the DOM.
    const blockEl = findBlockElementById(editorRoot, id)!;
    // Simulate the browser appending "あい" to the existing text node.
    const textNode = blockEl.querySelector("span")!.firstChild as Text;
    textNode.data = textNode.data + "あい";
    fireComposition(editorRoot, "end");
    expect(blockText(editor, id)).toBe("hiあい");
  });

  it("cancelled composition (no insertion) is a no-op", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "abc" }] }),
    ]);
    editor.selStore.set({ kind: "caret", at: caretAt(id, 3) });
    fireComposition(editorRoot, "start");
    // No DOM mutation — composition cancelled.
    fireComposition(editorRoot, "end");
    expect(blockText(editor, id)).toBe("abc");
  });

  it("composition snapshot survives selectionchange echoes during composition", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "x" }] }),
    ]);
    editor.selStore.set({ kind: "caret", at: caretAt(id, 1) });
    fireComposition(editorRoot, "start");
    // The browser advances native selection through intermediate IME
    // positions — selectionchange must NOT mutate selStore while composing.
    document.dispatchEvent(new Event("selectionchange"));
    const blockEl = findBlockElementById(editorRoot, id)!;
    const textNode = blockEl.querySelector("span")!.firstChild as Text;
    textNode.data = textNode.data + "Y";
    fireComposition(editorRoot, "end");
    expect(blockText(editor, id)).toBe("xY");
  });

  it("composition starting from a range deletes the range first", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "abcdef" }] }),
    ]);
    // Select "bcd".
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 1),
      focus: caretAt(id, 4),
    });
    fireComposition(editorRoot, "start");
    // "abcdef" had bcd selected → after start, model should be "aef" with
    // caret at offset 1.
    expect(blockText(editor, id)).toBe("aef");
    // Browser writes the IME output as if into the now-collapsed caret.
    const blockEl = findBlockElementById(editorRoot, id)!;
    const textNode = blockEl.querySelector("span")!.firstChild as Text;
    textNode.data = "a" + "Z" + "ef";
    fireComposition(editorRoot, "end");
    expect(blockText(editor, id)).toBe("aZef");
  });
});

// ---------------------------------------------------------------------------
// Regression: cross-block range delete must collapse selection to a caret.
// Previous bug: unsubDoc captured selStore.get() at scheduling time (before
// collapseRangeForStructuralOp updated it), so the post-render rAF re-applied
// the OLD range over the new (shorter) DOM — user saw the highlight persist
// and the selection appeared to extend past where they actually selected.
// ---------------------------------------------------------------------------

describe("nativeInput — cross-block range delete (regression)", () => {
  it("Backspace on a cross-block range collapses to a caret at the start", () => {
    const idA = newBlockId();
    const idB = newBlockId();
    const idC = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id: idA, type: "p", runs: [{ text: "first paragraph" }] }),
      spec({ id: idB, type: "p", runs: [{ text: "middle paragraph" }] }),
      spec({ id: idC, type: "p", runs: [{ text: "last paragraph" }] }),
    ]);
    // Select from offset 6 of A ("first ") to offset 5 of C ("last ").
    editor.selStore.set({
      kind: "range",
      anchor: { blockId: idA, path: [6], offset: 6 },
      focus: { blockId: idC, path: [5], offset: 5 },
    });
    fireBeforeInput(editorRoot, "deleteContentBackward", null);
    // Selection must be a CARET (not a stale range).
    const sel = editor.selStore.get();
    expect(sel.kind).toBe("caret");
    if (sel.kind === "caret") {
      expect(sel.at.blockId).toBe(idA);
      expect(sel.at.offset).toBe(6);
    }
    // Doc collapsed to one block, with idA's prefix + idC's suffix merged.
    const doc = editor.docStore.get();
    expect(doc.order.length).toBe(1);
    expect(doc.order[0]).toBe(idA);
    const merged = doc.byId.get(idA)!;
    if ("runs" in merged) {
      expect(merged.runs.map((r) => r.text).join("")).toBe("first paragraph");
    }
  });
});

// Regression — Cmd+A in a doc whose end is not in the DOM (virtualized, or
// any range whose focus block is unmounted). The model must still hold the
// full range; the native selection clamps to whatever is currently in the
// DOM so the user gets a visible highlight on the mounted portion.
describe("nativeInput — selection with virtualized / unmounted endpoints", () => {
  it("range with unmounted focus block falls back to selectAllChildren", () => {
    const idA = newBlockId();
    const idB = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id: idA, type: "p", runs: [{ text: "hello" }] }),
      spec({ id: idB, type: "p", runs: [{ text: "world" }] }),
    ]);
    // Simulate the unmounted-block case by removing block B from the DOM.
    const blockBel = findBlockElementById(editorRoot, idB)!;
    blockBel.remove();
    editor.selStore.set({
      kind: "range",
      anchor: { blockId: idA, path: [0], offset: 0 },
      focus: { blockId: idB, path: [5], offset: 5 },
    });
    const native = document.getSelection();
    if (!native || native.rangeCount === 0) {
      throw new Error("native selection expected");
    }
    const range = native.getRangeAt(0);
    expect(range.collapsed).toBe(false);
    // selectAllChildren(root) was used; the range spans the editor root.
    expect(range.startContainer === editorRoot).toBe(true);
    expect(range.endContainer === editorRoot).toBe(true);
  });

  it("logical-only range survives a render-induced selectionchange that would collapse it", () => {
    const idA = newBlockId();
    const idB = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id: idA, type: "p", runs: [{ text: "hello" }] }),
      spec({ id: idB, type: "p", runs: [{ text: "world" }] }),
    ]);
    // Set up the "logical-only" range: focus block unmounted.
    const blockBel = findBlockElementById(editorRoot, idB)!;
    blockBel.remove();
    editor.selStore.set({
      kind: "range",
      anchor: { blockId: idA, path: [0], offset: 0 },
      focus: { blockId: idB, path: [5], offset: 5 },
    });
    // Simulate a render-induced selectionchange firing after our apply:
    // native selection collapses (e.g. because idB's stand-in span got
    // detached) and the browser fires selectionchange. The handler must
    // see the unmounted-endpoint state and refuse to overwrite selStore.
    const native = document.getSelection()!;
    native.collapseToStart();
    document.dispatchEvent(new Event("selectionchange"));
    // selStore must still be the original range — NOT a caret collapsed
    // to the start of idA.
    const after = editor.selStore.get();
    expect(after.kind).toBe("range");
    if (after.kind === "range") {
      expect(after.focus.blockId).toBe(idB);
    }
  });
});

describe("nativeInput — keymap shortcuts", () => {
  it("Cmd+B (or Ctrl+B) toggles bold on current selection", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "abc" }] }),
    ]);
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 0),
      focus: caretAt(id, 3),
    });
    const ev = new (globalThis as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
      "keydown",
      {
        key: "b",
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      },
    );
    editorRoot.dispatchEvent(ev);
    const block = editor.docStore.get().byId.get(id)!;
    if ("runs" in block) {
      expect(block.runs.some((r) => r.marks?.has("b"))).toBe(true);
    }
  });

  it("Cmd+Z (or Ctrl+Z) triggers undo", () => {
    const id = newBlockId();
    const { editorRoot, editor } = mount([
      spec({ id, type: "p", runs: [{ text: "" }] }),
    ]);
    fireBeforeInput(editorRoot, "insertText", "X");
    expect(blockText(editor, id)).toBe("X");
    const ev = new (globalThis as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent(
      "keydown",
      {
        key: "z",
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      },
    );
    editorRoot.dispatchEvent(ev);
    expect(blockText(editor, id)).toBe("");
  });
});
