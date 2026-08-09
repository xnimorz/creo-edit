import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import type { AnchorRange, DocState } from "../model/types";
import type { SerializedBlock } from "../createEditor";
import type { DecorationViewport, EditorPlugin } from "../plugin/types";
import { notifyMountedBlocksChanged } from "../dom/mountSignal";

// ---------------------------------------------------------------------------
// happy-dom ships no CSS Custom Highlight API, so stub the two globals the
// shim probes. The stub records what was registered under each name.
// ---------------------------------------------------------------------------

type PaintedHighlight = { ranges: Range[]; priority: number };

const registered = new Map<string, PaintedHighlight>();

class FakeHighlight {
  ranges: Range[];
  priority = 0;
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

beforeEach(() => {
  registered.clear();
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  (globalThis as { CSS?: unknown }).CSS = {
    highlights: {
      set(name: string, value: FakeHighlight) {
        registered.set(name, { ranges: value.ranges, priority: value.priority });
      },
      delete(name: string) {
        registered.delete(name);
      },
      get(name: string) {
        return registered.get(name);
      },
    },
  };
});

afterEach(() => {
  clearDom();
  delete (globalThis as { Highlight?: unknown }).Highlight;
  delete (globalThis as { CSS?: unknown }).CSS;
});

const flush = () => new Promise((r) => queueMicrotask(() => r(undefined)));

function mount(
  plugins: EditorPlugin[],
  opts: { scrollable?: boolean; blocks?: SerializedBlock[] } = {},
) {
  const container = makeContainer();
  // Must be set before the managers construct — they resolve their scroll
  // source once, at construction.
  if (opts.scrollable) container.style.overflowY = "auto";
  const editor = createEditor({
    initial: {
      blocks: opts.blocks ?? [
        { type: "p", runs: [{ text: "hello world" }] },
        { type: "p", runs: [{ text: "second line" }] },
      ],
    },
    plugins,
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  return { container, editor };
}

/** A source that paints [from, to) of the first block. */
function spanPlugin(
  opts: {
    id?: string;
    className?: string;
    priority?: number;
    from?: number;
    to?: number;
    onCall?: (viewport: DecorationViewport | null) => void;
    ranges?: (doc: DocState) => AnchorRange[];
  } = {},
): EditorPlugin {
  const className = opts.className ?? "creo-test-span";
  return {
    name: `span-${className}`,
    rangeDecorations: [
      {
        id: opts.id ?? className,
        className,
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
        ranges(doc, viewport) {
          opts.onCall?.(viewport);
          if (opts.ranges) return opts.ranges(doc);
          const blockId = doc.order[0]!;
          const from = opts.from ?? 0;
          const to = opts.to ?? 5;
          return [
            {
              from: { blockId, path: [from], offset: from },
              to: { blockId, path: [to], offset: to },
            },
          ];
        },
      },
    ],
  };
}

describe("range decorations", () => {
  it("reports capability from the environment", () => {
    const { editor } = mount([]);
    expect(editor.supportsRangeDecorations()).toBe(true);
    delete (globalThis as { Highlight?: unknown }).Highlight;
    expect(editor.supportsRangeDecorations()).toBe(false);
  });

  it("registers plugin range decorations on the registry", () => {
    const { editor } = mount([spanPlugin()]);
    expect(editor.registry.rangeDecorations.map((d) => d.id)).toEqual([
      "creo-test-span",
    ]);
  });

  it("paints a highlight under the declared className", () => {
    mount([spanPlugin()]);
    const hl = registered.get("creo-test-span");
    expect(hl).toBeTruthy();
    expect(hl!.ranges.length).toBe(1);
    expect(hl!.ranges[0]!.toString()).toBe("hello");
  });

  it("applies priority so overlapping sources have a defined winner", () => {
    mount([
      spanPlugin({ className: "creo-low", priority: 1 }),
      spanPlugin({ className: "creo-high", priority: 5, from: 2, to: 8 }),
    ]);
    expect(registered.get("creo-low")!.priority).toBe(1);
    expect(registered.get("creo-high")!.priority).toBe(5);
    // Overlapping is fine — neither source had to know about the other.
    expect(registered.get("creo-low")!.ranges[0]!.toString()).toBe("hello");
    expect(registered.get("creo-high")!.ranges[0]!.toString()).toBe("llo wo");
  });

  it("passes the mounted viewport to the source", () => {
    let seen: DecorationViewport | null | undefined;
    const { editor } = mount([
      spanPlugin({ onCall: (v) => { seen = v; } }),
    ]);
    const order = editor.docStore.get().order;
    expect(seen?.firstBlock).toBe(order[0]!);
    expect(seen?.lastBlock).toBe(order[1]!);
  });

  it("repaints on the editor's own scroller, not on window scroll", async () => {
    let calls = 0;
    const { container } = mount([spanPlugin({ onCall: () => { calls++; } })], {
      scrollable: true,
    });
    calls = 0;
    // `scroll` doesn't bubble; an editor inside its own overflow pane never
    // hands one to `window`, so listening there saw nothing when the text
    // moved and everything when the page did.
    window.dispatchEvent(new Event("scroll"));
    await flush();
    expect(calls).toBe(0);

    container.dispatchEvent(new Event("scroll"));
    await flush();
    expect(calls).toBe(1);
  });

  it("repaints when the renderer says the mounted blocks changed", async () => {
    let calls = 0;
    const { container } = mount([spanPlugin({ onCall: () => { calls++; } })]);
    const root = container.querySelector<HTMLElement>("[data-creo-edit]")!;
    calls = 0;
    notifyMountedBlocksChanged(root);
    await flush();
    expect(calls).toBe(1);

    // A signal from some other editor on the page is not ours to repaint for.
    calls = 0;
    notifyMountedBlocksChanged(document.createElement("div"));
    await flush();
    expect(calls).toBe(0);
  });

  it("reports the visible character window of a code block", () => {
    let seen: DecorationViewport | null | undefined;
    const { container, editor } = mount(
      [spanPlugin({ onCall: (v) => { seen = v; } })],
      {
        scrollable: true,
        blocks: [
          {
            type: "code",
            runs: [{ text: Array.from({ length: 100 }, (_v, i) => `line ${i}`).join("\n") }],
          },
        ],
      },
    );
    const blockId = editor.docStore.get().order[0]!;
    const blockEl = container.querySelector<HTMLElement>(".ce-code-block")!;
    // happy-dom has no layout — fake just the two rects `windowIn` reads: a
    // 60px pane scrolled so lines 20..25 are on screen, over 100 10px lines.
    Object.defineProperty(container, "clientHeight", {
      value: 60,
      configurable: true,
    });
    const rect = (top: number, height: number) =>
      ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    container.getBoundingClientRect = () => rect(0, 60);
    blockEl.getBoundingClientRect = () => rect(-200, 1000);

    editor.refreshRangeDecorationsSync();
    // Viewport is lines 20..26; the manager adds a viewport of slack each way,
    // so lines 14..32. Line n starts at n * "line n".length-ish — assert
    // against the DOM's own published starts rather than recomputing them.
    const starts = Array.from(
      blockEl.querySelectorAll<HTMLElement>(".ce-code-line"),
    ).map((el) => Number(el.getAttribute("data-line-start")));
    const win = seen!.windowIn!(blockId);
    expect(win).toEqual({ from: starts[14]!, to: starts[33]! });
  });

  it("offers a per-block character window, null for unmeasurable blocks", () => {
    let seen: DecorationViewport | null | undefined;
    const { editor } = mount([spanPlugin({ onCall: (v) => { seen = v; } })]);
    const order = editor.docStore.get().order;
    // happy-dom has no layout, so nothing is measurable — the contract says
    // that reads as "no window, paint everything", not as an empty window.
    expect(typeof seen?.windowIn).toBe("function");
    expect(seen!.windowIn!(order[0]!)).toBeNull();
    expect(seen!.windowIn!("not-a-block" as never)).toBeNull();
  });

  it("repaints after a document change", async () => {
    const { editor } = mount([
      spanPlugin({ ranges: (doc) => {
        const blockId = doc.order[0]!;
        // Always the whole first block, so the painted text tracks edits.
        const b = doc.byId.get(blockId) as { runs: { text: string }[] };
        const len = b.runs.reduce((n, r) => n + r.text.length, 0);
        return [
          { from: { blockId, path: [0], offset: 0 },
            to: { blockId, path: [len], offset: len } },
        ];
      } }),
    ]);
    expect(registered.get("creo-test-span")!.ranges[0]!.toString()).toBe(
      "hello world",
    );
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: { blockId: id, path: [11], offset: 11 } });
    editor.dispatch({ t: "insertText", text: "!" });
    await flush();
    expect(registered.get("creo-test-span")!.ranges[0]!.toString()).toBe(
      "hello world!",
    );
  });

  it("coalesces refreshRangeDecorations() into one deferred repaint", async () => {
    let calls = 0;
    const { editor } = mount([spanPlugin({ onCall: () => { calls++; } })]);
    calls = 0;
    editor.refreshRangeDecorations();
    editor.refreshRangeDecorations();
    editor.refreshRangeDecorations();
    // Nothing yet — the whole point is to keep the repaint off the caller's
    // task, so a host can call this from a lifecycle hook.
    expect(calls).toBe(0);
    await flush();
    expect(calls).toBe(1);
  });

  it("refreshRangeDecorationsSync() repaints before returning", () => {
    let calls = 0;
    const { editor } = mount([spanPlugin({ onCall: () => { calls++; } })]);
    calls = 0;
    editor.refreshRangeDecorationsSync();
    expect(calls).toBe(1);
  });

  it("clears its highlight when the source returns nothing", async () => {
    let empty = false;
    const { editor } = mount([
      spanPlugin({ ranges: (doc) => {
        if (empty) return [];
        const blockId = doc.order[0]!;
        return [
          { from: { blockId, path: [0], offset: 0 },
            to: { blockId, path: [5], offset: 5 } },
        ];
      } }),
    ]);
    expect(registered.get("creo-test-span")!.ranges.length).toBe(1);
    empty = true;
    editor.refreshRangeDecorations();
    await flush();
    // Still registered (so the name is reset) but with no ranges.
    expect(registered.get("creo-test-span")!.ranges.length).toBe(0);
  });

  it("skips ranges whose blocks are not mounted", () => {
    mount([
      spanPlugin({ ranges: () => [
        {
          from: { blockId: "does-not-exist", path: [0], offset: 0 },
          to: { blockId: "does-not-exist", path: [3], offset: 3 },
        },
      ] }),
    ]);
    expect(registered.get("creo-test-span")!.ranges.length).toBe(0);
  });

  it("a throwing source clears itself without taking others down", () => {
    mount([
      spanPlugin({ className: "creo-bad", ranges: () => { throw new Error("x"); } }),
      spanPlugin({ className: "creo-good" }),
    ]);
    expect(registered.get("creo-bad")!.ranges.length).toBe(0);
    expect(registered.get("creo-good")!.ranges.length).toBe(1);
  });

  it("paints nothing when the API is unavailable", () => {
    delete (globalThis as { Highlight?: unknown }).Highlight;
    const { editor } = mount([spanPlugin()]);
    expect(editor.supportsRangeDecorations()).toBe(false);
    expect(registered.size).toBe(0);
  });
});
