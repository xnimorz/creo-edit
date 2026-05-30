import { describe, expect, it } from "bun:test";
import { docToMarkdown } from "../serialize";
import type { SerializedDoc } from "../../createEditor";

describe("docToMarkdown — table cell escaping", () => {
  it("escapes `|` and newlines inside table cells so the GFM grid stays intact", () => {
    const doc: SerializedDoc = {
      blocks: [
        {
          type: "table",
          rows: 2,
          cols: 2,
          cells: [
            [[{ text: "a|b" }], [{ text: "h2" }]],
            [[{ text: "line1\nline2" }], [{ text: "ok" }]],
          ],
        },
      ],
    };
    const md = docToMarkdown(doc);
    const lines = md.trim().split("\n");
    // Header + separator + one body row → every row has exactly 3 pipes
    // (leading, middle, trailing) so columns don't shift.
    for (const line of lines) {
      expect((line.match(/(?<!\\)\|/g) ?? []).length).toBe(3);
    }
    expect(md).toContain("a\\|b");
    expect(md).toContain("line1<br>line2");
    expect(md).not.toContain("line1\nline2");
  });
});
