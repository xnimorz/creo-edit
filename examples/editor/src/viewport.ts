import { createApp, HtmlRender } from "creo";
import { createEditor, type Editor } from "creo-edit";

// Fixture for tests/viewport.mobile.spec.ts — see viewport.html.

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "doc";
const keepCaretVisible = params.get("keep") !== "0";

const para = (i: number, long = false) => ({
  type: "p" as const,
  runs: [
    { text: long ? "words that wrap across many lines ".repeat(120) : `Paragraph ${i}` },
  ],
});

const editors: Editor[] = [];
const mount = (host: HTMLElement, blocks: ReturnType<typeof para>[], editable: boolean) => {
  const editor = createEditor({ initial: { blocks }, editable, keepCaretVisible });
  editors.push(editor);
  createApp(() => editor.EditorView(), new HtmlRender(host)).mount();
};

const scroller = document.getElementById("scroller")!;
if (mode === "home") {
  for (let t = 0; t < 8; t++) {
    const tile = scroller.appendChild(document.createElement("div"));
    tile.className = "tile";
    mount(tile, Array.from({ length: 20 }, (_, i) => para(i)), false);
  }
} else {
  const host = scroller.appendChild(document.createElement("div"));
  mount(host, Array.from({ length: 80 }, (_, i) => para(i, i === 40)), true);
}

(window as unknown as { __editors: Editor[] }).__editors = editors;
