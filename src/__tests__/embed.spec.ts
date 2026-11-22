import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { embedPlugin, type EmbedContext } from "../plugins/embed";
import { selectionToClipboard } from "../clipboard/htmlSerializer";
import { caretAt } from "../controller/selection";
import type { Block } from "../model/types";

afterEach(() => clearDom());

type Island = Block & { html: string; title: string };

function setup() {
  const log: string[] = [];
  const editor = createEditor({
    plugins: [
      embedPlugin({
        type: "island",
        className: "my-island",
        mount(block, shell, ctx) {
          const frame = document.createElement("iframe");
          frame.setAttribute("srcdoc", (block as Island).html);
          shell.appendChild(frame);
          log.push(`mount:${ctx.editor ? "editor" : "none"}`);
          return {
            update(next: Block, c: EmbedContext) {
              frame.setAttribute("srcdoc", (next as Island).html);
              log.push(`update:${c.selected}`);
            },
            destroy() {
              log.push("destroy");
            },
          };
        },
        plainText: (b) => `[${(b as Island).title}]`,
      }),
    ],
    initial: {
      blocks: [
        { id: "p", type: "p", runs: [{ text: "before" }] },
        { id: "i", type: "island", html: "<b>hi</b>", title: "Chart" } as never,
      ],
    },
  });
  const root = makeContainer();
  const app = createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER);
  app.mount();
  return { editor, root, log };
}

describe("embedPlugin", () => {
  it("draws a non-editable shell and hands it to mount, with the editor", () => {
    const { root, log } = setup();
    const shell = root.querySelector('[data-block-id="i"]')!;
    expect(shell.getAttribute("contenteditable")).toBe("false");
    expect(shell.getAttribute("data-block-kind")).toBe("island");
    expect(shell.className).toBe("ce-block ce-embed my-island");
    expect(shell.querySelector("iframe")?.getAttribute("srcdoc")).toBe("<b>hi</b>");
    expect(log).toEqual(["mount:editor"]);
  });

  it("follows the block and its selection without remounting", () => {
    const { editor, root, log } = setup();
    editor.applyBlocks({ replace: [{ id: "i", type: "island", html: "<i>new</i>", title: "Chart" } as never] });
    editor.selStore.set({
      kind: "range",
      anchor: { blockId: "i", path: [0], offset: 0 },
      focus: { blockId: "i", path: [1], offset: 1 },
    });
    const shell = root.querySelector('[data-block-id="i"]')!;
    expect(shell.querySelector("iframe")?.getAttribute("srcdoc")).toBe("<i>new</i>");
    expect(shell.getAttribute("data-selected")).toBe("true");
    expect(log).toEqual(["mount:editor", "update:false", "update:true"]);
  });

  it("round-trips through JSON and copies as its plain text", () => {
    const { editor } = setup();
    expect(editor.toJSON().blocks[1]).toEqual({ id: "i", type: "island", html: "<b>hi</b>", title: "Chart" } as never);
    editor.selStore.set({ kind: "range", anchor: caretAt("p", 0), focus: { blockId: "i", path: [1], offset: 1 } });
    expect(selectionToClipboard(editor.docStore.get(), editor.selStore.get()).plain).toBe("before\n[Chart]");
  });

  it("destroys what it built when the block goes", () => {
    const { editor, log } = setup();
    editor.applyBlocks({ remove: ["i"] });
    expect(log.at(-1)).toBe("destroy");
  });
});
