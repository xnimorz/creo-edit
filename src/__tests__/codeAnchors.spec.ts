import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { anchorsToDom, anchorToDom, domToAnchor } from "../dom/anchorMap";
import { LINE_START_ATTR } from "../plugin/anchorCodec";
import { caretAt } from "../controller/selection";
import type { Anchor } from "../model/types";

// ---------------------------------------------------------------------------
// The code block's anchor path, which the range-decoration repaint drives tens
// of thousands of times a frame. Three things have to stay true no matter how
// it's optimized:
//
//   - `data-line-start` agrees with the model after every kind of edit (it is
//     what the codec binary-searches, so a stale one is silent corruption),
//   - anchor → DOM → anchor round-trips at every offset in the block,
//   - the batch resolver returns exactly what N single calls would.
// ---------------------------------------------------------------------------

afterEach(clearDom);

function mountCode(text: string) {
  const container = makeContainer();
  const editor = createEditor({
    initial: { blocks: [{ type: "code", runs: [{ text }] }] },
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const root = container.querySelector<HTMLElement>("[data-creo-edit]")!;
  return { editor, container, root, blockId: editor.docStore.get().order[0]! };
}

/** What the DOM claims each line starts at. */
function declaredStarts(root: HTMLElement): number[] {
  return Array.from(root.querySelectorAll(".ce-code-line")).map((el) =>
    Number(el.getAttribute(LINE_START_ATTR)),
  );
}

/** What the model says each line starts at. */
function modelStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

describe("code block line offsets", () => {
  it("publishes model line starts on mount", () => {
    const text = "alpha\nbeta\n\ngamma delta";
    const { root } = mountCode(text);
    expect(declaredStarts(root)).toEqual(modelStarts(text));
  });

  it("keeps them correct after an edit at the very top", () => {
    const text = "alpha\nbeta\ngamma";
    const { editor, root, blockId } = mountCode(text);
    editor.selStore.set({ kind: "caret", at: caretAt(blockId, 0) });
    editor.dispatch({ t: "insertText", text: "XY" });
    const next = `XY${text}`;
    expect(declaredStarts(root)).toEqual(modelStarts(next));
    expect(editor.getText(blockId)).toBe(next);
  });

  it("keeps them correct after inserting a whole line at the top", () => {
    const text = "alpha\nbeta\ngamma";
    const { editor, root, blockId } = mountCode(text);
    editor.selStore.set({ kind: "caret", at: caretAt(blockId, 0) });
    // Enter inside a code block inserts a newline rather than splitting.
    editor.dispatch({ t: "splitBlock" });
    const next = `\n${text}`;
    expect(declaredStarts(root)).toEqual(modelStarts(next));
    expect(root.querySelectorAll(".ce-code-line").length).toBe(4);
  });

  it("keeps them correct after deleting across a line boundary", () => {
    const text = "alpha\nbeta\ngamma";
    const { editor, root, blockId } = mountCode(text);
    // Caret at the start of "beta"; backspace eats the preceding newline.
    editor.selStore.set({ kind: "caret", at: caretAt(blockId, 6) });
    editor.dispatch({ t: "deleteBackward" });
    const next = "alphabeta\ngamma";
    expect(editor.getText(blockId)).toBe(next);
    expect(declaredStarts(root)).toEqual(modelStarts(next));
  });

  it("keeps them correct after replacing the block's runs wholesale", () => {
    // What a tokenizer does: same text, resliced into many marked runs.
    const { editor, root, blockId } = mountCode("alpha\nbeta\ngamma");
    editor.setDoc({
      blocks: [
        {
          type: "code",
          id: blockId,
          runs: [
            { text: "alp" },
            { text: "ha\nbe", marks: ["b"] },
            { text: "ta\ngamma" },
          ],
        },
      ],
    });
    expect(declaredStarts(root)).toEqual(modelStarts("alpha\nbeta\ngamma"));
  });
});

describe("code block anchor round-trip", () => {
  it("resolves every offset, and maps back to itself", () => {
    const text = "alpha\nbeta\n\ngamma delta\nend";
    const { root, blockId } = mountCode(text);
    for (let off = 0; off <= text.length; off++) {
      const at: Anchor = { blockId, path: [off], offset: off };
      const point = anchorToDom(at, root);
      expect(point).not.toBeNull();
      const back = domToAnchor(point!.node, point!.offset, root);
      expect(back?.offset).toBe(off);
    }
  });

  it("batch resolution matches one-at-a-time resolution", () => {
    const text = "alpha\nbeta\n\ngamma delta\nend";
    const { root, blockId } = mountCode(text);
    // Deliberately unsorted and with duplicates — the batch sorts internally
    // and must restore the caller's order.
    const offsets = [17, 0, 6, 6, text.length, 11, 3, 12, 1, 23, 5];
    const anchors: Anchor[] = offsets.map((o) => ({
      blockId,
      path: [o],
      offset: o,
    }));
    const batch = anchorsToDom(anchors, root);
    for (let i = 0; i < anchors.length; i++) {
      const single = anchorToDom(anchors[i]!, root);
      expect(batch[i]!.node).toBe(single!.node);
      expect(batch[i]!.offset).toBe(single!.offset);
    }
  });

  it("batches across blocks, leaving unmounted ones null", () => {
    const container = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "p", runs: [{ text: "hello world" }] },
          { type: "code", runs: [{ text: "one\ntwo" }] },
        ],
      },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(container),
      SYNC_SCHEDULER,
    ).mount();
    const root = container.querySelector<HTMLElement>("[data-creo-edit]")!;
    const [pId, codeId] = editor.docStore.get().order;
    const anchors: Anchor[] = [
      { blockId: codeId!, path: [5], offset: 5 },
      { blockId: "ghost", path: [0], offset: 0 },
      { blockId: pId!, path: [3], offset: 3 },
    ];
    const batch = anchorsToDom(anchors, root);
    expect(batch[1]).toBeNull();
    expect(domToAnchor(batch[0]!.node, batch[0]!.offset, root)?.offset).toBe(5);
    expect(domToAnchor(batch[2]!.node, batch[2]!.offset, root)?.offset).toBe(3);
  });

  it("still resolves when a host's code view omits data-line-start", () => {
    const text = "alpha\nbeta\ngamma";
    const { root, blockId } = mountCode(text);
    for (const el of Array.from(root.querySelectorAll(".ce-code-line"))) {
      el.removeAttribute(LINE_START_ATTR);
    }
    for (let off = 0; off <= text.length; off++) {
      const at: Anchor = { blockId, path: [off], offset: off };
      const point = anchorToDom(at, root);
      expect(point).not.toBeNull();
      expect(domToAnchor(point!.node, point!.offset, root)?.offset).toBe(off);
    }
    // …and the batch path falls back with it.
    const anchors: Anchor[] = [9, 2, 15].map((o) => ({
      blockId,
      path: [o],
      offset: o,
    }));
    const batch = anchorsToDom(anchors, root);
    for (let i = 0; i < anchors.length; i++) {
      expect(domToAnchor(batch[i]!.node, batch[i]!.offset, root)?.offset).toBe(
        anchors[i]!.offset,
      );
    }
  });
});
