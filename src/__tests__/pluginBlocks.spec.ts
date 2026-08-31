// ---------------------------------------------------------------------------
// Plugin-introduced block types: whether the text commands reach them, and
// what happens to a block whose plugin isn't installed.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender, view, div } from "creo";

import { createEditor, type SerializedDoc } from "../createEditor";
import { isTextBearing } from "../model/blockText";
import { isOpaqueBlock } from "../plugin/unknownBlock";
import type { Anchor, Block, InlineRun } from "../model/types";
import type { BlockDef, EditorPlugin } from "../plugin/types";

afterEach(() => clearDom());

const A = (blockId: string, offset: number): Anchor => ({
  blockId,
  path: [offset],
  offset,
});

function mount(
  initial?: SerializedDoc,
  opts: Parameters<typeof createEditor>[0] = {},
) {
  const container = makeContainer();
  const editor = createEditor({ ...opts, ...(initial ? { initial } : {}) });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  return { editor, container };
}

const textOf = (editor: ReturnType<typeof createEditor>, id: string): string =>
  ((editor.docStore.get().byId.get(id) as { runs?: InlineRun[] })?.runs ?? [])
    .map((r) => r.text)
    .join("");

// ---------------------------------------------------------------------------
// A minimal plugin block shaped like a paragraph — declares `isTextBearing`
// and nothing else unusual.
// ---------------------------------------------------------------------------

const TaskView = view<{ block: Block }>(({ props }) => ({
  render() {
    const b = props().block;
    div({ "data-block-id": b.id, "data-block-kind": "task" });
  },
}));

const taskDef = {
  type: "task",
  view: TaskView,
  isTextBearing: true,
  serializeCodec: {
    serialize: (b: Block) => ({
      id: b.id,
      type: "task",
      runs: (b as never as { runs: InlineRun[] }).runs,
    }),
    deserialize: (s: unknown, id: string) =>
      ({ id, type: "task", runs: (s as { runs?: InlineRun[] }).runs ?? [] }) as never,
  },
} as unknown as BlockDef<Block>;

const taskPlugin: EditorPlugin = { name: "task", blocks: [taskDef] };

describe("text commands reach plugin blocks", () => {
  const doc: SerializedDoc = {
    blocks: [{ id: "t1", type: "task", runs: [{ text: "buy milk" }] } as never],
  };

  it("isTextBearing() reports a registered plugin block", () => {
    const { editor } = mount(doc, { plugins: [taskPlugin] });
    expect(isTextBearing(editor.docStore.get().byId.get("t1")!)).toBe(true);
  });

  it("Enter inside a task block splits it", () => {
    const { editor } = mount(doc, { plugins: [taskPlugin] });
    editor.selStore.set({ kind: "caret", at: A("t1", 3) });
    expect(editor.dispatch({ t: "splitBlock" })).toBe(true);
    const order = editor.docStore.get().order;
    expect(order.length).toBe(2);
    expect(textOf(editor, order[0]!)).toBe("buy");
    expect(textOf(editor, order[1]!)).toBe(" milk");
  });

  it("Backspace at offset 0 merges a task block backwards", () => {
    const { editor } = mount(
      {
        blocks: [
          { type: "p", runs: [{ text: "a" }] },
          { id: "t1", type: "task", runs: [{ text: "b" }] } as never,
        ],
      },
      { plugins: [taskPlugin] },
    );
    editor.selStore.set({ kind: "caret", at: A("t1", 0) });
    expect(editor.dispatch({ t: "mergeBackward" })).toBe(true);
    const order = editor.docStore.get().order;
    expect(order.length).toBe(1);
    expect(textOf(editor, order[0]!)).toBe("ab");
  });

  it("setBlockType converts a task block", () => {
    const { editor } = mount(doc, { plugins: [taskPlugin] });
    editor.selStore.set({ kind: "caret", at: A("t1", 0) });
    expect(editor.dispatch({ t: "setBlockType", payload: { type: "h2" } })).toBe(true);
    expect(editor.docStore.get().byId.get("t1")!.type).toBe("h2");
  });

  it("a block declaring isTextBearing: false stays inert", () => {
    const inertPlugin: EditorPlugin = {
      name: "inert",
      blocks: [
        {
          ...taskDef,
          type: "inert",
          isTextBearing: false,
          serializeCodec: {
            serialize: (b: Block) => ({ id: b.id, type: "inert" }),
            deserialize: (s: unknown, id: string) =>
              ({ id, type: "inert", runs: (s as { runs?: InlineRun[] }).runs ?? [] }),
          },
        } as never,
      ],
    };
    const { editor } = mount(
      { blocks: [{ id: "i1", type: "inert", runs: [{ text: "x" }] } as never] },
      { plugins: [inertPlugin] },
    );
    expect(isTextBearing(editor.docStore.get().byId.get("i1")!)).toBe(false);
  });
});

describe("blocks whose plugin isn't installed", () => {
  const withPlugin: SerializedDoc = {
    blocks: [
      { id: "p1", type: "p", runs: [{ text: "hi" }] },
      { id: "x1", type: "some-plugin-block", payload: { n: 42 } } as never,
    ],
  };

  it("are kept, and round-trip their payload byte-for-byte", () => {
    const { editor } = mount(withPlugin);
    expect(editor.docStore.get().order).toEqual(["p1", "x1"]);
    expect(isOpaqueBlock(editor.docStore.get().byId.get("x1")!)).toBe(true);
    expect(editor.toJSON().blocks[1] as unknown).toEqual({
      id: "x1",
      type: "some-plugin-block",
      payload: { n: 42 },
    });
  });

  it("survive edits to the rest of the document", () => {
    const { editor } = mount(withPlugin);
    editor.selStore.set({ kind: "caret", at: A("p1", 2) });
    editor.dispatch({ t: "insertText", text: "!" });
    expect(editor.toJSON().blocks[1] as unknown).toEqual({
      id: "x1",
      type: "some-plugin-block",
      payload: { n: 42 },
    });
  });

  it('unknownBlocks: "drop" discards them instead', () => {
    const { editor } = mount(
      { blocks: [{ id: "y1", type: "another-unknown-kind" } as never] },
      { unknownBlocks: "drop" },
    );
    expect(editor.docStore.get().order).toEqual([]);
  });

  it('unknownBlocks: "throw" refuses the document', () => {
    expect(() =>
      createEditor({
        initial: { blocks: [{ id: "z1", type: "yet-another-unknown" } as never] },
        unknownBlocks: "throw",
      }),
    ).toThrow(/no block codec registered/);
  });
});
