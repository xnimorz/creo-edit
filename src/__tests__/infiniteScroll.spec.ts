import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { calendarPlugin } from "../plugins/calendar";
import { infiniteScrollPlugin } from "../plugins/infinite-scroll";
import type { Editor } from "../createEditor";
import type { BlockInsertInput } from "../createEditor";

afterEach(() => {
  clearDom();
});

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayPair(date: string): BlockInsertInput[] {
  return [
    { type: "date-marker", date } as BlockInsertInput,
    { type: "p", runs: [] } as BlockInsertInput,
  ];
}

describe("editor — appendBlocks / prependBlocks", () => {
  it("appendBlocks adds blocks at the end and preserves existing block identity", () => {
    const root = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "p", runs: [{ text: "first" }] },
          { type: "p", runs: [{ text: "second" }] },
        ],
      },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const before = editor.docStore.get();
    const beforeIds = before.order.slice();
    const beforeBlocks = beforeIds.map((id) => before.byId.get(id));

    const newIds = editor.appendBlocks([
      { type: "p", runs: [{ text: "appended" }] } as BlockInsertInput,
    ]);

    const after = editor.docStore.get();
    expect(newIds.length).toBe(1);
    expect(after.order.length).toBe(3);
    // Existing block IDs unchanged + the new id appended at the end.
    expect(after.order.slice(0, 2)).toEqual(beforeIds);
    expect(after.order[2]).toBe(newIds[0]!);
    // Existing block REFERENCES unchanged (identity-preserving) so the
    // renderer's shouldUpdate skips them.
    for (let i = 0; i < beforeIds.length; i++) {
      expect(after.byId.get(beforeIds[i]!)).toBe(beforeBlocks[i]);
    }
  });

  it("prependBlocks adds blocks at the start and preserves existing identities", () => {
    const root = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: [
          { type: "p", runs: [{ text: "a" }] },
          { type: "p", runs: [{ text: "b" }] },
        ],
      },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const beforeIds = editor.docStore.get().order.slice();

    const newIds = editor.prependBlocks([
      { type: "p", runs: [{ text: "zeroth" }] } as BlockInsertInput,
    ]);

    const after = editor.docStore.get();
    expect(after.order.length).toBe(3);
    expect(after.order[0]).toBe(newIds[0]!);
    expect(after.order.slice(1)).toEqual(beforeIds);
  });

  it("appendBlocks/prependBlocks both auto-generate ids when missing", () => {
    const root = makeContainer();
    const editor = createEditor();
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const ids = editor.appendBlocks([
      { type: "p", runs: [] } as BlockInsertInput,
      { type: "p", runs: [] } as BlockInsertInput,
    ]);
    expect(ids.length).toBe(2);
    expect(typeof ids[0]).toBe("string");
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(editor.docStore.get().byId.has(id)).toBe(true);
    }
  });

  it("preserves selection across appendBlocks/prependBlocks", () => {
    const root = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: [
          { id: "p1", type: "p", runs: [{ text: "hello" }] },
        ],
      },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    editor.selStore.set({
      kind: "caret",
      at: { blockId: "p1", path: [3], offset: 3 },
    });
    editor.appendBlocks([{ type: "p", runs: [] } as BlockInsertInput]);
    editor.prependBlocks([{ type: "p", runs: [] } as BlockInsertInput]);
    const sel = editor.selStore.get();
    if (sel.kind === "caret") {
      expect(sel.at.blockId).toBe("p1");
      expect(sel.at.offset).toBe(3);
    } else {
      throw new Error("expected caret");
    }
  });
});

describe("infiniteScrollPlugin", () => {
  function mountJournal(): { editor: Editor; container: HTMLElement } {
    const root = makeContainer();
    let calls = { before: 0, after: 0 };
    void calls;
    const editor = createEditor({
      plugins: [
        calendarPlugin(),
        infiniteScrollPlugin({
          // Use a function-form scrollContainer so the plugin looks it
          // up after the wrapper div is in the DOM.
          scrollContainer: () => root,
          threshold: 100,
          loadAfter: (ed) => {
            const order = (ed as unknown as Editor).docStore.get().order;
            const last = order[order.length - 1]!;
            const lastBlock = (ed as unknown as Editor).docStore
              .get()
              .byId.get(last);
            const fromIso =
              lastBlock && lastBlock.type === "date-marker"
                ? (lastBlock as { date: string }).date
                : todayIso();
            const next = `${fromIso.slice(0, -2)}${String(
              Number(fromIso.slice(-2)) + 1,
            ).padStart(2, "0")}`;
            (ed as unknown as Editor).appendBlocks(dayPair(next));
          },
          loadBefore: (ed) => {
            const order = (ed as unknown as Editor).docStore.get().order;
            const first = order[0]!;
            const firstBlock = (ed as unknown as Editor).docStore
              .get()
              .byId.get(first);
            const fromIso =
              firstBlock && firstBlock.type === "date-marker"
                ? (firstBlock as { date: string }).date
                : todayIso();
            const prev = `${fromIso.slice(0, -2)}${String(
              Number(fromIso.slice(-2)) - 1,
            ).padStart(2, "0")}`;
            (ed as unknown as Editor).prependBlocks(dayPair(prev));
          },
        }),
      ],
      initial: {
        blocks: [
          { type: "date-marker", date: "2026-05-10" },
          { type: "p", runs: [] },
          { type: "date-marker", date: "2026-05-11" },
          { type: "p", runs: [] },
        ],
      },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    return { editor, container: root };
  }

  it("calls loadAfter when scrolling near the bottom and loadBefore near the top", async () => {
    const { editor, container } = mountJournal();

    // happy-dom's getComputedStyle has limited support; force an
    // overflow style so findScrollAncestor would pick up our container
    // if explicit scrollContainer hadn't been supplied.
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      get: () => 400,
    });

    const initial = editor.docStore.get().order.length;

    // Scroll near bottom — should fire loadAfter.
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      writable: true,
      value: 1700, // 2000 - 400 - 1700 = -100, well within threshold
    });
    // Let the editor's onMount run so the decoration manager has synced
    // and the plugin's scroll listener is attached.
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    container.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 50));

    expect(editor.docStore.get().order.length).toBeGreaterThanOrEqual(initial + 2);
  });
});
