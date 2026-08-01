import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import {
  deleteRange,
  insertText,
  normalizeRuns,
  splitRunsAt,
  withRunText,
} from "../model/blockText";
import { updateBlock } from "../model/doc";
import type { Block, InlineRun } from "../model/types";

afterEach(() => {
  clearDom();
});

const kw = (text: string): InlineRun => ({ text, attrs: { class: "tok-keyword" } });
const str = (text: string): InlineRun => ({ text, attrs: { class: "tok-string" } });

describe("run attrs — model", () => {
  it("does not merge adjacent runs whose attrs differ", () => {
    const out = normalizeRuns([kw("const"), str(" x")]);
    expect(out.length).toBe(2);
    expect(out[0]!.attrs?.class).toBe("tok-keyword");
    expect(out[1]!.attrs?.class).toBe("tok-string");
  });

  it("merges adjacent runs whose attrs are equal but not identical", () => {
    const out = normalizeRuns([
      { text: "a", attrs: { class: "tok-keyword" } },
      { text: "b", attrs: { class: "tok-keyword" } },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("ab");
    expect(out[0]!.attrs?.class).toBe("tok-keyword");
  });

  it("does not merge an attr-bearing run into a plain one", () => {
    const out = normalizeRuns([{ text: "a" }, kw("b")]);
    expect(out.length).toBe(2);
  });

  it("preserves attrs when a run is split by an insertion", () => {
    const out = insertText([kw("const")], 2, "XY");
    // "co" + "XY" + "nst" — all three inherit the token class, so they
    // re-merge into a single run.
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("coXYnst");
    expect(out[0]!.attrs?.class).toBe("tok-keyword");
  });

  it("does not inherit attrs when marks are dictated explicitly", () => {
    const out = insertText([kw("const")], 2, "XY", new Set(["b"] as const));
    const inserted = out.find((r) => r.text === "XY");
    expect(inserted).toBeTruthy();
    expect(inserted!.attrs).toBeUndefined();
    expect(inserted!.marks?.has("b")).toBe(true);
  });

  it("preserves attrs across deleteRange and splitRunsAt", () => {
    const del = deleteRange([kw("const")], 1, 3);
    expect(del[0]!.text).toBe("cst");
    expect(del[0]!.attrs?.class).toBe("tok-keyword");

    const [left, right] = splitRunsAt([kw("const")], 2);
    expect(left[0]!.attrs?.class).toBe("tok-keyword");
    expect(right[0]!.attrs?.class).toBe("tok-keyword");
  });

  it("withRunText carries marks and attrs", () => {
    const r: InlineRun = { text: "abc", marks: new Set(["b"]), attrs: { class: "t" } };
    const next = withRunText(r, "z");
    expect(next.text).toBe("z");
    expect(next.marks?.has("b")).toBe(true);
    expect(next.attrs?.class).toBe("t");
  });
});

describe("run attrs — render + commands", () => {
  // `attrs` is view-only, so it never survives `initial` (deserialization
  // drops it by design). Hosts apply it by writing runs straight into the
  // doc store — a syntax-highlight pass does exactly this.
  function mount(runs: InlineRun[]) {
    const container = makeContainer();
    const editor = createEditor({
      initial: { blocks: [{ type: "p", runs: [{ text: "" }] }] },
    });
    const doc = editor.docStore.get();
    const id = doc.order[0]!;
    editor.docStore.set(
      updateBlock(doc, { ...doc.byId.get(id)!, runs } as Block),
    );
    createApp(
      () => editor.EditorView(),
      new HtmlRender(container),
      SYNC_SCHEDULER,
    ).mount();
    return { container, editor };
  }

  it("renders the class on the run span", () => {
    const { container } = mount([kw("const"), { text: " x" }]);
    const spans = container.querySelectorAll("[data-run-index]");
    expect(spans.length).toBe(2);
    expect((spans[0] as HTMLElement).getAttribute("class")).toBe("tok-keyword");
    expect((spans[1] as HTMLElement).getAttribute("class")).toBeFalsy();
  });

  it("toggling a mark keeps the run's attrs", () => {
    const { editor } = mount([kw("const")]);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({
      kind: "range",
      anchor: { blockId: id, path: [0], offset: 0 },
      focus: { blockId: id, path: [5], offset: 5 },
    });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    const b = editor.docStore.get().byId.get(id) as { runs: InlineRun[] };
    expect(b.runs[0]!.marks?.has("b")).toBe(true);
    expect(b.runs[0]!.attrs?.class).toBe("tok-keyword");
  });

  it("attrs are view-only — they do not round-trip through toJSON", () => {
    const { editor } = mount([kw("const")]);
    const json = editor.toJSON();
    expect(json.blocks[0]).toEqual({
      id: editor.docStore.get().order[0]!,
      type: "p",
      runs: [{ text: "const" }],
    });
    // …and setDoc does not resurrect them.
    editor.setDoc(json);
    const id = editor.docStore.get().order[0]!;
    const b = editor.docStore.get().byId.get(id) as { runs: InlineRun[] };
    expect(b.runs[0]!.attrs).toBeUndefined();
  });
});
