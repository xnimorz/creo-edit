import { describe, expect, it } from "bun:test";
import "./setup";

import { createEditor, docToHtml } from "../createEditor";
import { parseHTML } from "../clipboard/htmlParser";
import { embedPlugin } from "../plugins/embed";

describe("docToHtml", () => {
  it("writes the wire form and the model alike", () => {
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "h2", runs: [{ text: "Title" }] },
          { type: "p", runs: [{ text: "Hi " }, { text: "there", marks: { b: null } }] },
          { type: "li", ordered: false, depth: 0, runs: [{ text: "one" }] },
        ],
      },
    });
    const html = docToHtml(editor.toJSON());
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>there</strong>");
    expect(html).toContain(`<ul><li data-depth="0">one</li></ul>`);
    expect(docToHtml(editor.docStore.get())).toBe(html);
  });
});

describe("claimElement", () => {
  it("keeps an element the host claims as its block, instead of flattening it", () => {
    createEditor({ plugins: [embedPlugin({ type: "island", mount: () => {} })] });
    const blocks = parseHTML(
      `<h1>Plan</h1><section id="cards" data-island><div class="card">A</div></section><p>after</p>`,
      {
        claimElement: (el) =>
          el.hasAttribute("data-island") ? { type: "island", key: el.id, html: el.outerHTML } : null,
      },
    );
    expect(blocks.map((b) => b.type as string)).toEqual(["h1", "island", "p"]);
    const island = blocks[1] as unknown as { key: string; html: string };
    expect(island.key).toBe("cards");
    expect(island.html).toContain('<div class="card">A</div>');
  });

  it("an unclaimed unknown element is flattened as before", () => {
    expect(parseHTML(`<section><p>x</p></section>`, { claimElement: () => null }).map((b) => b.type)).toEqual(["p"]);
  });

  it("setDocFromHTML takes it too", () => {
    const editor = createEditor({ plugins: [embedPlugin({ type: "island", mount: () => {} })] });
    editor.setDocFromHTML(`<p>a</p><figure><svg></svg></figure>`, {
      claimElement: (el) => (el.tagName === "FIGURE" ? { type: "island", html: el.innerHTML } : null),
    });
    expect(editor.toJSON().blocks.map((b) => b.type as string)).toEqual(["p", "island"]);
  });
});
