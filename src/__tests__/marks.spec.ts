import { afterEach, describe, expect, it } from "bun:test";
import { hasMark, linkHref, markAttrs, marksEqual } from "../model/marks";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { caretAt } from "../controller/selection";
import { newBlockId } from "../model/doc";
import { docToMarkdown } from "../markdown/serialize";
import type { InlineRun, Mark } from "../model/types";

afterEach(() => {
  clearDom();
});

function setupWithText(text: string) {
  const root = makeContainer();
  const id = newBlockId();
  const editor = createEditor({
    initial: { blocks: [{ id, type: "p", runs: [{ text }] }] },
  });
  createApp(() => editor.EditorView(), new HtmlRender(root)).mount();
  const editorRoot = root.querySelector(
    "[data-creo-edit]",
  ) as HTMLElement;
  return { root, editor, id, ta: editorRoot };
}

function getRuns(editor: ReturnType<typeof createEditor>, id: string): InlineRun[] {
  const b = editor.docStore.get().byId.get(id)!;
  if (b.type !== "p") throw new Error("not a paragraph");
  return b.runs;
}

describe("toggleMark", () => {
  it("adds a mark to a single-block range and splits runs", () => {
    const { editor, id } = setupWithText("hello world");
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 0),
      focus: caretAt(id, 5),
    });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    const runs = getRuns(editor, id);
    expect(runs.length).toBe(2);
    expect(runs[0]!.text).toBe("hello");
    expect(runs[0]!.marks?.has("b")).toBe(true);
    expect(runs[1]!.text).toBe(" world");
    expect(runs[1]!.marks ?? new Set()).toEqual(new Set());
  });

  it("removes a mark when the entire range already has it", () => {
    const { editor, id } = setupWithText("hello");
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 0),
      focus: caretAt(id, 5),
    });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    const runs = getRuns(editor, id);
    // After remove, runs should normalize back to a single un-marked run.
    expect(runs.length).toBe(1);
    expect(runs[0]!.text).toBe("hello");
    expect(runs[0]!.marks).toBeUndefined();
  });

  it("partial coverage forces ADD, not remove", () => {
    const { editor, id } = setupWithText("hello world");
    // Bold "hello" first.
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 0),
      focus: caretAt(id, 5),
    });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    // Now select "ello world" — partial coverage of the bold region.
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 1),
      focus: caretAt(id, 11),
    });
    editor.dispatch({ t: "toggleMark", mark: "b" });
    const runs = getRuns(editor, id);
    // Whole range should now be bold; runs reduce to "h" and "ello world".
    let total = "";
    for (const r of runs) total += r.text;
    expect(total).toBe("hello world");
    // every char from offset 1..11 should be bold
    let off = 0;
    for (const r of runs) {
      const start = off;
      const end = off + r.text.length;
      const intersects = !(end <= 1 || start >= 11);
      if (intersects) {
        expect(r.marks?.has("b")).toBe(true);
      }
      off = end;
    }
  });

  it("caret-only toggle is a no-op", () => {
    const { editor, id } = setupWithText("hi");
    editor.selStore.set({ kind: "caret", at: caretAt(id, 1) });
    const before = getRuns(editor, id);
    editor.dispatch({ t: "toggleMark", mark: "b" });
    expect(getRuns(editor, id)).toBe(before);
  });

  it("Cmd+B chord (mac) triggers toggleMark", () => {
    const { editor, id, ta } = setupWithText("hello");
    editor.selStore.set({
      kind: "range",
      anchor: caretAt(id, 0),
      focus: caretAt(id, 5),
    });
    // Detect platform; force one of the two keys.
    const isMacish = /Mac|iPhone|iPod|iPad/i.test(
      (navigator?.platform ?? "") + " " + (navigator?.userAgent ?? ""),
    );
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        bubbles: true,
        cancelable: true,
        ...(isMacish ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
    const runs = getRuns(editor, id);
    expect(runs[0]!.marks?.has("b" as Mark)).toBe(true);
  });

  it("Property: random toggle sequences converge to canonical run sets", () => {
    // Generate text "abcdefghij" and toggle marks over random sub-ranges.
    // After all toggles, walk the runs and verify (a) every run's marks set
    // is consistent with its text segment, (b) adjacent runs never share an
    // identical marks set (else normalization should have merged them).
    const { editor, id } = setupWithText("abcdefghij");
    const marks: Mark[] = ["b", "i", "u", "s"];
    for (let trial = 0; trial < 200; trial++) {
      const a = Math.floor(Math.random() * 11);
      const b = Math.floor(Math.random() * 11);
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      if (start === end) continue;
      const m = marks[Math.floor(Math.random() * marks.length)]!;
      editor.selStore.set({
        kind: "range",
        anchor: caretAt(id, start),
        focus: caretAt(id, end),
      });
      editor.dispatch({ t: "toggleMark", mark: m });
    }
    const runs = getRuns(editor, id);
    let total = "";
    for (const r of runs) total += r.text;
    expect(total).toBe("abcdefghij");
    // Adjacent normalization invariant.
    for (let i = 1; i < runs.length; i++) {
      expect(marksEqual(runs[i - 1]!.marks, runs[i]!.marks)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The link mark — the built-in mark that carries attrs. Everything here is
// about the attrs surviving: equality, retargeting, rendering, and the three
// round trips (JSON, HTML, markdown).
// ---------------------------------------------------------------------------

describe("link mark", () => {
  /** Like `setupWithText`, but with a synchronous scheduler so the DOM
   *  assertions below can read the render the command triggered. */
  function setupLinkable() {
    const root = makeContainer();
    const id = newBlockId();
    const editor = createEditor({
      initial: { blocks: [{ id, type: "p", runs: [{ text: "see the docs here" }] }] },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const s = { root, editor, id };
    s.editor.selStore.set({
      kind: "range",
      anchor: caretAt(s.id, 8),
      focus: caretAt(s.id, 12),
    });
    return s;
  }
  const linkedRun = (editor: ReturnType<typeof createEditor>, id: string) =>
    getRuns(editor, id).find((r) => r.text === "docs")!;

  it("applies a link with attrs over a range", () => {
    const { editor, id } = setupLinkable();
    expect(
      editor.dispatch({
        t: "toggleMark",
        mark: "link",
        attrs: { href: "https://x.dev" },
      }),
    ).toBe(true);
    expect(linkHref(linkedRun(editor, id).marks)).toBe("https://x.dev");
    expect(markAttrs(linkedRun(editor, id).marks, "link")).toEqual({
      href: "https://x.dev",
    });
  });

  it("re-applying with a DIFFERENT href retargets rather than clearing", () => {
    const { editor, id } = setupLinkable();
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "https://a.dev" } });
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "https://b.dev" } });
    expect(linkHref(linkedRun(editor, id).marks)).toBe("https://b.dev");
  });

  it("re-applying the SAME href toggles it off", () => {
    const { editor, id } = setupLinkable();
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "https://a.dev" } });
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "https://a.dev" } });
    expect(getRuns(editor, id).some((r) => hasMark(r.marks, "link"))).toBe(false);
  });

  it("removeMark unlinks regardless of href, and no-ops when there's nothing to remove", () => {
    const { editor, id } = setupLinkable();
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "https://a.dev" } });
    expect(editor.dispatch({ t: "removeMark", mark: "link" })).toBe(true);
    expect(getRuns(editor, id).some((r) => hasMark(r.marks, "link"))).toBe(false);
    // A second call must not push an empty undo step.
    expect(editor.dispatch({ t: "removeMark", mark: "link" })).toBe(false);
  });

  it("runs differing only by href do not merge", () => {
    const root = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: [
          {
            id: "p1",
            type: "p",
            runs: [
              { text: "a", marks: { link: { href: "https://a.dev" } } },
              { text: "b", marks: { link: { href: "https://b.dev" } } },
            ],
          },
        ],
      },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    editor.selStore.set({ kind: "caret", at: caretAt("p1", 2) });
    editor.dispatch({ t: "insertText", text: "!" });
    expect(getRuns(editor, "p1").map((r) => r.text)).toEqual(["a", "b!"]);
  });

  it("renders as an <a href>", () => {
    const { editor, root } = setupLinkable();
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "https://x.dev" } });
    const a = root.querySelector("a");
    expect(a).toBeTruthy();
    expect(a!.getAttribute("href")).toBe("https://x.dev");
    expect(a!.textContent).toBe("docs");
  });

  it("neutralises an unsafe scheme in the DOM but keeps it in the model", () => {
    const { editor, id, root } = setupLinkable();
    // eslint-disable-next-line no-script-url
    editor.dispatch({ t: "toggleMark", mark: "link", attrs: { href: "javascript:alert(1)" } });
    expect(root.querySelector("a")!.getAttribute("href")).toBe("#");
    // The model is untouched — `toJSON()` gives the host back exactly what it
    // stored, and sanitization is the view's job.
    expect(linkHref(linkedRun(editor, id).marks)).toBe("javascript:alert(1)");
  });

  it("round-trips through JSON", () => {
    const { editor } = setupLinkable();
    editor.dispatch({
      t: "toggleMark",
      mark: "link",
      attrs: { href: "https://x.dev", title: "Docs" },
    });
    const json = editor.toJSON();
    const wire = (json.blocks[0] as { runs: { text: string; marks?: unknown }[] }).runs
      .find((r) => r.text === "docs")!;
    expect(wire.marks).toEqual({ link: { href: "https://x.dev", title: "Docs" } });

    const reloaded = createEditor({ initial: json });
    const backId = reloaded.docStore.get().order[0]!;
    expect(linkHref(linkedRun(reloaded, backId).marks)).toBe("https://x.dev");
  });

  it("parses <a href> out of HTML, and treats a bare <a> as plain text", () => {
    const withHref = createEditor();
    withHref.setDocFromHTML('<p>see <a href="https://x.dev" title="D">docs</a></p>');
    const id = withHref.docStore.get().order[0]!;
    expect(markAttrs(linkedRun(withHref, id).marks, "link")).toEqual({
      href: "https://x.dev",
      title: "D",
    });

    // An <a> with no href is a named anchor, not a link.
    const bare = createEditor();
    bare.setDocFromHTML("<p>see <a>docs</a></p>");
    const bareId = bare.docStore.get().order[0]!;
    expect(getRuns(bare, bareId).some((r) => hasMark(r.marks, "link"))).toBe(false);
    expect(getRuns(bare, bareId).map((r) => r.text).join("")).toBe("see docs");
  });

  it("serializes to a markdown link", () => {
    const md = docToMarkdown({
      blocks: [
        {
          type: "p",
          runs: [
            { text: "see " },
            { text: "docs", marks: { link: { href: "https://x.dev" } } },
          ],
        } as never,
      ],
    });
    expect(md.trim()).toBe("see [docs](https://x.dev)");
  });
});

describe("legacy mark wire form", () => {
  it("reads string[] marks and writes back the object form", () => {
    const editor = createEditor({
      initial: {
        blocks: [
          { id: "p1", type: "p", runs: [{ text: "bold", marks: ["b", "i"] }] } as never,
        ],
      },
    });
    const run = getRuns(editor, "p1")[0]!;
    expect(hasMark(run.marks, "b")).toBe(true);
    expect(hasMark(run.marks, "i")).toBe(true);
    expect(
      (editor.toJSON().blocks[0] as never as { runs: { marks: unknown }[] }).runs[0]!.marks,
    ).toEqual({ b: null, i: null });
  });
});
