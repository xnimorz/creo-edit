import { describe, expect, it } from "bun:test";
import "../../__tests__/setup";

import { createEditor, type SerializedDoc } from "../../createEditor";
import { blockquotePlugin } from "../../plugins/blockquote";
import { horizontalRulePlugin } from "../../plugins/horizontal-rule";
import { markdownToDoc, parseInline } from "../parse";
import { docToMarkdown } from "../serialize";

// Installing the plugins registers their markdown codecs, parse included.
createEditor({ plugins: [blockquotePlugin(), horizontalRulePlugin()] });

const roundTrip = (doc: SerializedDoc): SerializedDoc => markdownToDoc(docToMarkdown(doc));

describe("markdownToDoc", () => {
  it("reads back everything docToMarkdown writes", () => {
    const doc: SerializedDoc = {
      blocks: [
        { type: "h1", runs: [{ text: "Plan" }] },
        {
          type: "p",
          runs: [
            { text: "Mixed " },
            { text: "bold", marks: { b: null } },
            { text: " and " },
            { text: "it", marks: { i: null } },
            { text: ", " },
            { text: "gone", marks: { s: null } },
            { text: ", " },
            { text: "x*y", marks: { code: null } },
            { text: ", a " },
            { text: "link", marks: { link: { href: "https://e.x/a_b" } } },
            { text: " and 2*3_4." },
          ],
        },
        { type: "p", runs: [{ text: "two\nlines" }] },
        { type: "li", ordered: false, depth: 0, runs: [{ text: "one" }] },
        { type: "li", ordered: false, depth: 1, runs: [{ text: "nested" }] },
        { type: "li", ordered: false, depth: 0, runs: [{ text: "two" }] },
        { type: "p", runs: [{ text: "between" }] },
        { type: "li", ordered: true, depth: 0, runs: [{ text: "first" }] },
        { type: "li", ordered: true, depth: 0, runs: [{ text: "second" }] },
        { type: "code", lang: "ts", runs: [{ text: "const a = 1;\n\nconst b = `x`;" }] },
        { type: "img", src: "https://e.x/i.png", alt: "pic" },
        {
          type: "table",
          rows: 2,
          cols: 2,
          cells: [
            [[{ text: "k" }], [{ text: "v|w" }]],
            [[{ text: "a" }], [{ text: "line\nbreak" }]],
          ],
          align: [null, "right"],
        },
        { type: "blockquote", runs: [{ text: "quoted" }] },
        { type: "hr" },
        { type: "h3", runs: [{ text: "End" }] },
      ],
    };
    expect(roundTrip(doc)).toEqual(doc);
  });

  it("reads markdown it did not write", () => {
    const doc = markdownToDoc(
      ["Para one", "continues", "", "* star item", "    * four-space nested", "3) paren", "", "~~~", "raw", "~~~"].join("\n"),
    );
    expect(doc.blocks).toEqual([
      { type: "p", runs: [{ text: "Para one\ncontinues" }] },
      { type: "li", ordered: false, depth: 0, runs: [{ text: "star item" }] },
      { type: "li", ordered: false, depth: 1, runs: [{ text: "four-space nested" }] },
      { type: "li", ordered: true, depth: 0, runs: [{ text: "paren" }] },
      { type: "code", runs: [{ text: "raw" }] },
    ]);
  });

  it("code spans keep backticks, backslashes and edge spaces", () => {
    for (const text of ["a`b", "`tick", "c:\\dir\\*", " padded ", "  "]) {
      const doc: SerializedDoc = { blocks: [{ type: "p", runs: [{ text, marks: { code: null } }] }] };
      expect(roundTrip(doc)).toEqual(doc);
    }
  });

  it("leaves snake_case and lone markers as text", () => {
    expect(parseInline("snake_case_name and 2 * 3 and a [bracket]")).toEqual([
      { text: "snake_case_name and 2 * 3 and a [bracket]" },
    ]);
  });

  it("an empty document is one empty paragraph", () => {
    expect(markdownToDoc("\n\n")).toEqual({ blocks: [{ type: "p", runs: [] }] });
  });

  it("loads into an editor as it reads", () => {
    const editor = createEditor({ initial: markdownToDoc("# T\n\n- a\n- b\n") });
    expect(editor.getText()).toBe("T\na\nb");
  });
});
