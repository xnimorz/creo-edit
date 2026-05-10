import "../../../__tests__/setup";
import { describe, expect, it } from "bun:test";
import type { Block, BlockId, DocState } from "../../../model/types";
import { docFromBlocks } from "../../../model/doc";
import { matchKey, searchDoc, slotsOf } from "../engine";

function p(text: string, id: string): Block {
  return {
    id: id as BlockId,
    index: "a",
    type: "p",
    runs: text ? [{ text }] : [],
  };
}

function h1(text: string, id: string): Block {
  return {
    id: id as BlockId,
    index: "a",
    type: "h1",
    runs: [{ text }],
  };
}

function code(text: string, id: string): Block {
  return {
    id: id as BlockId,
    index: "a",
    type: "code",
    runs: [{ text }],
  };
}

function table(rows: string[][], id: string): Block {
  return {
    id: id as BlockId,
    index: "a",
    type: "table",
    rows: rows.length,
    cols: rows[0]!.length,
    cells: rows.map((row) =>
      row.map((cell) => (cell ? [{ text: cell }] : [])),
    ),
  };
}

function columns(cells: string[], id: string): Block {
  return {
    id: id as BlockId,
    index: "a",
    type: "columns",
    cols: cells.length,
    cells: cells.map((c) => (c ? [{ text: c }] : [])),
  };
}

function img(id: string): Block {
  return {
    id: id as BlockId,
    index: "a",
    type: "img",
    src: "x.png",
  };
}

function doc(...blocks: Block[]): DocState {
  return docFromBlocks(blocks);
}

describe("slotsOf", () => {
  it("yields one slot for text-bearing blocks", () => {
    const slots = [...slotsOf(p("hello", "1"))];
    expect(slots).toEqual([{ text: "hello", prefix: [] }]);
  });
  it("yields per-cell slots for table", () => {
    const t = table([["a", "b"], ["c", "d"]], "t");
    const slots = [...slotsOf(t)];
    expect(slots).toEqual([
      { text: "a", prefix: [0, 0] },
      { text: "b", prefix: [0, 1] },
      { text: "c", prefix: [1, 0] },
      { text: "d", prefix: [1, 1] },
    ]);
  });
  it("yields per-column slots for columns", () => {
    const c = columns(["x", "y", "z"], "c");
    const slots = [...slotsOf(c)];
    expect(slots).toEqual([
      { text: "x", prefix: [0] },
      { text: "y", prefix: [1] },
      { text: "z", prefix: [2] },
    ]);
  });
  it("skips images", () => {
    const slots = [...slotsOf(img("i"))];
    expect(slots).toEqual([]);
  });
});

describe("searchDoc — basic", () => {
  it("finds plain matches across blocks", () => {
    const d = doc(p("hello world", "1"), p("hello there", "2"));
    const m = searchDoc(d, "hello", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(2);
    expect(m[0]!.blockId).toBe("1");
    expect(m[0]!.start.path).toEqual([0]);
    expect(m[0]!.end.path).toEqual([5]);
    expect(m[0]!.snippet).toBe("hello");
    expect(m[1]!.blockId).toBe("2");
  });

  it("finds multiple matches in one block", () => {
    const d = doc(p("aaa bbb aaa ccc aaa", "1"));
    const m = searchDoc(d, "aaa", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(3);
    expect(m.map((x) => x.start.path[0])).toEqual([0, 8, 16]);
  });

  it("returns empty for empty query", () => {
    const d = doc(p("anything", "1"));
    expect(
      searchDoc(d, "", { caseSensitive: false, wholeWord: false, regex: false }),
    ).toHaveLength(0);
  });
});

describe("searchDoc — case sensitivity", () => {
  it("default is case-insensitive", () => {
    const d = doc(p("Hello hello HELLO", "1"));
    const m = searchDoc(d, "hello", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(3);
  });

  it("caseSensitive limits matches", () => {
    const d = doc(p("Hello hello HELLO", "1"));
    const m = searchDoc(d, "hello", {
      caseSensitive: true,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(1);
    expect(m[0]!.start.path).toEqual([6]);
  });
});

describe("searchDoc — whole word", () => {
  it("only matches on word boundaries", () => {
    const d = doc(p("cat catfish concat cat", "1"));
    const m = searchDoc(d, "cat", {
      caseSensitive: false,
      wholeWord: true,
      regex: false,
    });
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.start.path[0])).toEqual([0, 19]);
  });
});

describe("searchDoc — regex", () => {
  it("uses query as regex", () => {
    const d = doc(p("a1 b22 c333", "1"));
    const m = searchDoc(d, "[a-c]\\d+", {
      caseSensitive: true,
      wholeWord: false,
      regex: true,
    });
    expect(m).toHaveLength(3);
    expect(m.map((x) => x.snippet)).toEqual(["a1", "b22", "c333"]);
  });

  it("returns empty on invalid regex", () => {
    const d = doc(p("anything", "1"));
    const m = searchDoc(d, "[unclosed", {
      caseSensitive: false,
      wholeWord: false,
      regex: true,
    });
    expect(m).toHaveLength(0);
  });
});

describe("searchDoc — block kinds", () => {
  it("searches headings and code blocks", () => {
    const d = doc(h1("Title hello", "1"), code("hello world", "2"));
    const m = searchDoc(d, "hello", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.blockId)).toEqual(["1", "2"]);
  });

  it("searches table cells with [r,c,offset] anchors", () => {
    const t = table([["foo", "barfoo"], ["foo", "x"]], "t");
    const m = searchDoc(doc(t), "foo", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(3);
    expect(m[0]!.start.path).toEqual([0, 0, 0]);
    expect(m[0]!.end.path).toEqual([0, 0, 3]);
    expect(m[1]!.start.path).toEqual([0, 1, 3]);
    expect(m[2]!.start.path).toEqual([1, 0, 0]);
  });

  it("searches columns with [c,offset] anchors", () => {
    const c = columns(["alpha", "betafoo", "foogamma"], "c");
    const m = searchDoc(doc(c), "foo", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(2);
    expect(m[0]!.start.path).toEqual([1, 4]);
    expect(m[1]!.start.path).toEqual([2, 0]);
  });

  it("skips images", () => {
    const d = doc(p("hello", "1"), img("i"), p("hello", "2"));
    const m = searchDoc(d, "hello", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(2);
    expect(m.map((x) => x.blockId)).toEqual(["1", "2"]);
  });
});

describe("searchDoc — anchor offsets", () => {
  it("end - start equals match length", () => {
    const d = doc(p("the quick brown fox", "1"));
    const m = searchDoc(d, "quick", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m).toHaveLength(1);
    const pathOffsetStart = m[0]!.start.path[m[0]!.start.path.length - 1]!;
    const pathOffsetEnd = m[0]!.end.path[m[0]!.end.path.length - 1]!;
    expect(pathOffsetEnd - pathOffsetStart).toBe(5);
  });

  it("matchKey is stable", () => {
    const d = doc(p("aa bb aa", "1"));
    const m1 = searchDoc(d, "aa", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    const m2 = searchDoc(d, "aa", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(m1.map(matchKey)).toEqual(m2.map(matchKey));
    expect(new Set(m1.map(matchKey)).size).toBe(m1.length);
  });
});
