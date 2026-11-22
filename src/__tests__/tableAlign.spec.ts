import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedBlock } from "../createEditor";
import { docToHtml } from "../clipboard/htmlSerializer";
import { docToMarkdown } from "../markdown/serialize";
import { newBlockId } from "../model/doc";
import type { DocChange } from "../model/changes";
import type { TableAlign, TableBlock } from "../model/types";

afterEach(() => {
  clearDom();
});

const cell = (text: string) => (text ? [{ text }] : []);

function mount(align?: TableAlign[]) {
  const root = makeContainer();
  const id = newBlockId();
  const table: SerializedBlock = {
    id,
    type: "table",
    rows: 2,
    cols: 3,
    cells: [
      [cell("Name"), cell("Size"), cell("Note")],
      [cell("a"), cell("1"), cell("x")],
    ],
    ...(align ? { align } : {}),
  };
  const editor = createEditor({ initial: { blocks: [table] } });
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  const block = () => editor.docStore.get().byId.get(id) as TableBlock;
  return { root, editor, id, block };
}

describe("table column alignment", () => {
  it("round-trips through JSON, and a table with none serializes without the key", () => {
    const aligned = mount(["left", "right", null]);
    expect((aligned.editor.toJSON().blocks[0] as { align?: TableAlign[] }).align).toEqual([
      "left",
      "right",
      null,
    ]);
    const plain = mount();
    expect("align" in plain.editor.toJSON().blocks[0]!).toBe(false);
    // All-null says nothing, so it is stored as nothing.
    expect("align" in mount([null, null, null]).editor.toJSON().blocks[0]!).toBe(false);
  });

  it("ignores values it does not know and pads a short array", () => {
    const { block } = mount(["middle" as TableAlign, "center"]);
    expect(block().align).toEqual([null, "center", null]);
  });

  it("puts the alignment on every cell of the column", () => {
    const { root } = mount([null, "right", "center"]);
    const cells = Array.from(root.querySelectorAll("td.ce-cell")).map((td) => [
      td.getAttribute("data-cell"),
      td.getAttribute("data-align"),
      (td as HTMLElement).style.textAlign,
    ]);
    expect(cells).toEqual([
      ["0:0", null, ""],
      ["0:1", "right", "right"],
      ["0:2", "center", "center"],
      ["1:0", null, ""],
      ["1:1", "right", "right"],
      ["1:2", "center", "center"],
    ]);
  });

  it("writes GFM's delimiter row", () => {
    const { editor } = mount(["left", "center", "right"]);
    expect(docToMarkdown(editor.toJSON())).toBe(
      "| Name | Size | Note |\n| :--- | :---: | ---: |\n| a | 1 | x |\n",
    );
    expect(docToMarkdown(mount().editor.toJSON())).toContain("| --- | --- | --- |");
  });

  it("writes and reads it as HTML", () => {
    const { editor } = mount([null, "right", null]);
    const html = docToHtml(editor.docStore.get());
    expect(html).toContain('<td style="text-align:right">1</td>');

    const pasted = mount();
    pasted.editor.setDocFromHTML(
      '<table><tr><th align="center">A</th><th style="text-align: right">B</th><th>C</th></tr></table>',
    );
    const table = pasted.editor.docStore.get().byId.get(pasted.editor.docStore.get().order[0]!) as TableBlock;
    expect(table.align).toEqual(["center", "right", null]);
  });

  it("table.setAlign aligns the caret's column, as one undo step that moves no anchor", () => {
    const { editor, id, block } = mount();
    editor.selStore.set({ kind: "caret", at: { blockId: id, path: [1, 2, 0], offset: 0 } });
    const changes: DocChange[] = [];
    editor.onChange((batch) => changes.push(...batch));

    expect(editor.dispatch({ t: "table.setAlign", payload: { align: "right" } })).toBe(true);
    expect(block().align).toEqual([null, null, "right"]);
    expect(changes).toEqual([{ kind: "blockAttrs", blockId: id, type: "table" }]);
    // Already so: nothing to do.
    expect(editor.dispatch({ t: "table.setAlign", payload: { align: "right" } })).toBe(false);

    editor.dispatch({ t: "table.setAlign", payload: { align: null, col: 2 } });
    expect(block().align).toBeUndefined();
    editor.undo();
    expect(block().align).toEqual([null, null, "right"]);
  });

  it("follows its column when columns are inserted or removed", () => {
    const { editor, id, block } = mount(["left", null, "right"]);
    editor.selStore.set({ kind: "caret", at: { blockId: id, path: [0, 0, 0], offset: 0 } });
    editor.dispatch({ t: "table.insertCol", payload: { where: "after" } });
    expect(block().align).toEqual(["left", null, null, "right"]);
    editor.dispatch({ t: "table.removeCol", payload: { col: 0 } });
    expect(block().align).toEqual([null, null, "right"]);
    editor.dispatch({ t: "table.removeCol", payload: { col: 2 } });
    expect(block().align).toBeUndefined();
  });
});
