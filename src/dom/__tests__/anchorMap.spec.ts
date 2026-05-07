import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { clearDom, makeContainer } from "../../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../../createEditor";
import type { SerializedDoc } from "../../createEditor";
import type { Anchor, BlockSpec } from "../../model/types";
import { newBlockId } from "../../model/doc";
import { anchorToDom, domToAnchor } from "../anchorMap";

afterEach(() => {
  clearDom();
});

// ---------------------------------------------------------------------------
// Test rig — mount a real editor so we exercise the same DOM the runtime
// produces, including data-block-kind / data-cell / data-col markers.
// ---------------------------------------------------------------------------

function mount(blocks: BlockSpec[]): {
  root: HTMLElement;
  editorRoot: HTMLElement;
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
  return { root, editorRoot, ids };
}

function spec(over: Partial<BlockSpec> & { type: BlockSpec["type"] }): BlockSpec {
  return { id: newBlockId(), ...over } as BlockSpec;
}

// Build a (Node, offset) pair from an anchor, then map back. The result must
// equal the original anchor (canonical form: path field = offset for
// text-bearing, last path entry = offset for table/columns).
function roundTrip(anchor: Anchor, root: HTMLElement): Anchor | null {
  const point = anchorToDom(anchor, root);
  if (!point) return null;
  return domToAnchor(point.node, point.offset, root);
}

// ---------------------------------------------------------------------------
// Text-bearing blocks: paragraph
// ---------------------------------------------------------------------------

describe("anchorMap — paragraph", () => {
  it("round-trips offsets across the block", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "p", runs: [{ text: "hello" }] }),
    ]);
    for (let off = 0; off <= 5; off++) {
      const a: Anchor = { blockId: id, path: [off], offset: off };
      const back = roundTrip(a, editorRoot);
      expect(back).toEqual(a);
    }
  });

  it("round-trips offsets across mark boundaries", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "p",
        runs: [
          { text: "hi " },
          { text: "bold", marks: new Set(["b"] as const) },
          { text: " end" },
        ],
      }),
    ]);
    for (let off = 0; off <= 11; off++) {
      const a: Anchor = { blockId: id, path: [off], offset: off };
      const back = roundTrip(a, editorRoot);
      expect(back).toEqual(a);
    }
  });

  it("anchor at offset 0 of an empty paragraph", () => {
    const id = newBlockId();
    const { editorRoot } = mount([spec({ id, type: "p", runs: [] })]);
    const a: Anchor = { blockId: id, path: [0], offset: 0 };
    const back = roundTrip(a, editorRoot);
    expect(back).toEqual(a);
  });

  it("offsets past end clamp to end-of-block", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "p", runs: [{ text: "abc" }] }),
    ]);
    const point = anchorToDom(
      { blockId: id, path: [99], offset: 99 },
      editorRoot,
    );
    expect(point).not.toBeNull();
    const back = domToAnchor(point!.node, point!.offset, editorRoot);
    expect(back?.blockId).toBe(id);
    expect(back?.offset).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Text-bearing blocks: heading, list item
// ---------------------------------------------------------------------------

describe("anchorMap — heading / list item", () => {
  it("round-trips inside h1", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "h1", runs: [{ text: "Title" }] }),
    ]);
    for (let off = 0; off <= 5; off++) {
      const a: Anchor = { blockId: id, path: [off], offset: off };
      expect(roundTrip(a, editorRoot)).toEqual(a);
    }
  });

  it("round-trips inside li", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "li",
        ordered: false,
        depth: 0,
        runs: [{ text: "item one" }],
      }),
    ]);
    for (let off = 0; off <= 8; off++) {
      const a: Anchor = { blockId: id, path: [off], offset: off };
      expect(roundTrip(a, editorRoot)).toEqual(a);
    }
  });
});

// ---------------------------------------------------------------------------
// Code blocks — \n in model is a real character; DOM has no \n text but
// renders one .ce-code-line per line.
// ---------------------------------------------------------------------------

describe("anchorMap — code", () => {
  it("round-trips offsets including newline boundaries", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "code",
        runs: [{ text: "abc\ndef\n\ng" }],
      }),
    ]);
    // Total length: 3 + 1 + 3 + 1 + 0 + 1 + 1 = 10
    const total = "abc\ndef\n\ng".length;
    for (let off = 0; off <= total; off++) {
      const a: Anchor = { blockId: id, path: [off], offset: off };
      const back = roundTrip(a, editorRoot);
      expect(back).toEqual(a);
    }
  });

  it("offset at the start of an empty middle line maps cleanly", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "code", runs: [{ text: "x\n\ny" }] }),
    ]);
    // Offsets: 0=x|, 1=|\n, 2=|empty, 3=|\n, 4=|y, 5=y|
    // The empty middle line lives at offset 2.
    const point = anchorToDom(
      { blockId: id, path: [2], offset: 2 },
      editorRoot,
    );
    expect(point).not.toBeNull();
    const back = domToAnchor(point!.node, point!.offset, editorRoot);
    expect(back?.offset).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Table — path = [row, col, charOffset]
// ---------------------------------------------------------------------------

describe("anchorMap — table", () => {
  it("round-trips an anchor in a non-corner cell", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "table",
        rows: 2,
        cols: 3,
        cells: [
          [[{ text: "00" }], [{ text: "01" }], [{ text: "02" }]],
          [[{ text: "10" }], [{ text: "11" }], [{ text: "12" }]],
        ],
      }),
    ]);
    const a: Anchor = { blockId: id, path: [1, 2, 1], offset: 1 };
    expect(roundTrip(a, editorRoot)).toEqual(a);
  });

  it("preserves the (r, c) prefix in the round-trip", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "table",
        rows: 2,
        cols: 2,
        cells: [
          [[{ text: "aa" }], [{ text: "bb" }]],
          [[{ text: "cc" }], [{ text: "dd" }]],
        ],
      }),
    ]);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        for (let off = 0; off <= 2; off++) {
          const a: Anchor = { blockId: id, path: [r, c, off], offset: off };
          expect(roundTrip(a, editorRoot)).toEqual(a);
        }
      }
    }
  });

  it("empty cell anchors at offset 0", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "table",
        rows: 1,
        cols: 2,
        cells: [[[], [{ text: "x" }]]],
      }),
    ]);
    const a: Anchor = { blockId: id, path: [0, 0, 0], offset: 0 };
    expect(roundTrip(a, editorRoot)).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Columns — path = [colIdx, charOffset]
// ---------------------------------------------------------------------------

describe("anchorMap — columns", () => {
  it("round-trips across all columns", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({
        id,
        type: "columns",
        cols: 3,
        cells: [[{ text: "AA" }], [{ text: "BBB" }], [{ text: "C" }]],
      }),
    ]);
    const cases: Anchor[] = [
      { blockId: id, path: [0, 0], offset: 0 },
      { blockId: id, path: [0, 2], offset: 2 },
      { blockId: id, path: [1, 1], offset: 1 },
      { blockId: id, path: [1, 3], offset: 3 },
      { blockId: id, path: [2, 0], offset: 0 },
      { blockId: id, path: [2, 1], offset: 1 },
    ];
    for (const a of cases) {
      expect(roundTrip(a, editorRoot)).toEqual(a);
    }
  });
});

// ---------------------------------------------------------------------------
// Image — path = [side]   side: 0 = before, 1 = after
// ---------------------------------------------------------------------------

describe("anchorMap — img", () => {
  it("maps both sides of an img block", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "img", src: "x.png", alt: "x" }),
    ]);
    for (const side of [0, 1] as const) {
      const a: Anchor = { blockId: id, path: [side], offset: side };
      const point = anchorToDom(a, editorRoot);
      expect(point).not.toBeNull();
      const back = domToAnchor(point!.node, point!.offset, editorRoot);
      expect(back?.blockId).toBe(id);
      expect(back?.path[0]).toBe(side);
    }
  });
});

// ---------------------------------------------------------------------------
// Boundary / negative cases
// ---------------------------------------------------------------------------

describe("anchorMap — defensive paths", () => {
  it("returns null for nodes outside the editor root", () => {
    const id = newBlockId();
    const { editorRoot } = mount([
      spec({ id, type: "p", runs: [{ text: "x" }] }),
    ]);
    const stray = document.createElement("div");
    document.body.appendChild(stray);
    expect(domToAnchor(stray, 0, editorRoot)).toBeNull();
    document.body.removeChild(stray);
  });

  it("returns null for a non-existent blockId", () => {
    const { editorRoot } = mount([
      spec({ id: newBlockId(), type: "p", runs: [{ text: "x" }] }),
    ]);
    const point = anchorToDom(
      { blockId: "no-such-block", path: [0], offset: 0 },
      editorRoot,
    );
    expect(point).toBeNull();
  });

  it("hit on the editor root with no block ancestor returns null", () => {
    const { editorRoot } = mount([
      spec({ id: newBlockId(), type: "p", runs: [{ text: "x" }] }),
    ]);
    expect(domToAnchor(editorRoot, 0, editorRoot)).toBeNull();
  });
});
