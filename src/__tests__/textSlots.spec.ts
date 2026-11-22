import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { anchorToDom } from "../dom/anchorMap";
import { textSlotsOf } from "../model/blockText";

afterEach(() => {
  clearDom();
});

describe("textSlotsOf", () => {
  it("addresses a word inside a table cell by the anchors the cell's own codec reads", () => {
    const root = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: [
          {
            id: "t",
            type: "table",
            rows: 2,
            cols: 2,
            cells: [
              [[{ text: "Key" }], [{ text: "Does" }]],
              [[{ text: "j" }], [{ text: "next match" }]],
            ],
          },
        ],
      },
    });
    createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();

    const block = editor.docStore.get().byId.get("t")!;
    const slot = textSlotsOf(block).find((s) => s.text.includes("match"))!;
    expect(slot.path).toEqual([1, 1]);

    const from = slot.text.indexOf("match");
    const point = anchorToDom({ blockId: "t", path: [...slot.path, from], offset: from }, root)!;
    expect((point.node.parentElement!.closest("td") as HTMLElement).getAttribute("data-cell")).toBe("1:1");
    expect(point.node.textContent!.slice(point.offset)).toBe("match");
  });
});
