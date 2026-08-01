import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import type { AnchorRange, DocState } from "../model/types";
import type { DecorationViewport, EditorPlugin } from "../plugin/types";

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

function mount(plugins: EditorPlugin[]) {
  const container = makeContainer();
  const editor = createEditor({
    initial: {
      blocks: [
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
    expect(seen).toEqual({ firstBlock: order[0]!, lastBlock: order[1]! });
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
