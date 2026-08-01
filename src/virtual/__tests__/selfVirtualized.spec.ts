import { afterEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "../../__tests__/setup";
import { createApp, div, HtmlRender, view, _ } from "creo";
import type { PublicView } from "creo";

import { createEditor } from "../../createEditor";
import { newBlockId } from "../../model/doc";
import type { Block, BlockSpec, CodeBlock } from "../../model/types";
import type { BlockDef, EditorPlugin, SelfVirtualizedProps } from "../../plugin/types";

afterEach(() => clearDom());

const LINE_H = 16;

// A stand-in for the motivating case: a long code block that windows its own
// lines. Registered under a distinct type so it doesn't disturb the built-in
// code block (whose anchor codec walks every mounted line and therefore must
// not opt in).
type LongCodeBlock = Omit<CodeBlock, "type"> & { type: "longcode" };

/** Records what each render was asked to show, so tests can assert windowing. */
const renderLog: { first: number; last: number; count: number }[] = [];

const LongCodeView = view<SelfVirtualizedProps<Block>>(({ props }) => ({
  shouldUpdate(next) {
    const cur = props();
    return (
      next.block !== cur.block ||
      next.viewport?.top !== cur.viewport?.top ||
      next.viewport?.bottom !== cur.viewport?.bottom
    );
  },
  render() {
    const b = props().block as unknown as LongCodeBlock;
    const vp = props().viewport;
    const lines = (b.runs[0]?.text ?? "").split("\n");
    // No viewport (non-virtualized host) → render everything.
    const first = vp ? Math.max(0, Math.floor(vp.top / LINE_H)) : 0;
    const last = vp
      ? Math.min(lines.length - 1, Math.ceil(vp.bottom / LINE_H))
      : lines.length - 1;
    renderLog.push({ first, last, count: Math.max(0, last - first + 1) });
    div(
      {
        "data-block-id": b.id,
        "data-block-kind": "longcode",
        class: "ce-block ce-longcode",
      },
      () => {
        if (first > 0) {
          div({ key: "sp-top", class: "lc-spacer", style: `height:${first * LINE_H}px;` });
        }
        for (let i = first; i <= last; i++) {
          div({ key: i, class: "lc-line" }, lines[i] ?? "");
        }
        const after = lines.length - 1 - last;
        if (after > 0) {
          div({ key: "sp-bot", class: "lc-spacer", style: `height:${after * LINE_H}px;` });
        }
      },
    );
    void _;
  },
}));

function longCodePlugin(onMeasure?: () => void): EditorPlugin {
  const def: BlockDef<Block> = {
    type: "longcode" as Block["type"],
    view: LongCodeView as PublicView<SelfVirtualizedProps<Block>, void>,
    isTextBearing: true,
    selfVirtualized: {
      measureHeight(block, metrics) {
        onMeasure?.();
        const b = block as unknown as LongCodeBlock;
        const lineCount = (b.runs[0]?.text ?? "").split("\n").length;
        return lineCount * metrics.lineHeight;
      },
    },
    serializeCodec: {
      serialize: (b) => ({ ...(b as unknown as LongCodeBlock) }),
      deserialize: (s, id) =>
        ({ ...(s as object), id, type: "longcode" }) as unknown as BlockSpec,
    },
  };
  return { name: "longcode", blocks: [def] };
}

function mount(opts: {
  lineCount: number;
  before?: number;
  after?: number;
  onMeasure?: () => void;
}) {
  renderLog.length = 0;
  const root = makeContainer();
  const code = Array.from({ length: opts.lineCount }, (_v, i) => `line ${i}`).join("\n");
  const blocks: unknown[] = [];
  for (let i = 0; i < (opts.before ?? 0); i++) {
    blocks.push({ id: newBlockId(), type: "p", runs: [{ text: `p${i}` }] });
  }
  const codeId = newBlockId();
  blocks.push({ id: codeId, type: "longcode", runs: [{ text: code }] });
  for (let i = 0; i < (opts.after ?? 0); i++) {
    blocks.push({ id: newBlockId(), type: "p", runs: [{ text: `tail${i}` }] });
  }
  const editor = createEditor({
    initial: { blocks: blocks as never },
    virtualized: true,
    virtualEstimatedHeight: 32,
    plugins: [longCodePlugin(opts.onMeasure)],
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(root),
    SYNC_SCHEDULER,
  ).mount();
  return { root, editor, codeId };
}

describe("self-virtualized blocks", () => {
  it("mounts only the lines inside the passed viewport", () => {
    const { root } = mount({ lineCount: 5000 });
    const rendered = root.querySelectorAll(".lc-line");
    // 5000 lines would be 5000 nodes without sub-block windowing.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(5000);
    const last = renderLog[renderLog.length - 1]!;
    expect(last.first).toBe(0);
    expect(last.count).toBeLessThan(5000);
  });

  it("absorbs its own off-screen height internally, not via the outer spacers", () => {
    // 5000 lines * 16px = 80,000px — two orders of magnitude past the 32px
    // estimate a non-self-virtualized block would have contributed. The outer
    // index treats the block as one tall entry; the block itself covers the
    // unrendered part with its own spacers.
    const { root } = mount({ lineCount: 5000, after: 3 });
    const last = renderLog[renderLog.length - 1]!;
    const internal = Array.from(
      root.querySelectorAll<HTMLElement>(".lc-spacer"),
    ).reduce((n, el) => n + parseFloat(el.style.height), 0);
    expect(internal).toBe((5000 - last.count) * LINE_H);
    // The outer bottom spacer only covers the three trailing paragraphs at
    // the 32px estimate — the block is not double-counted.
    const bottom = root.querySelector(
      ".creo-vspacer-bottom",
    ) as HTMLElement | null;
    expect(root.querySelector(".creo-vspacer-top")).toBeFalsy();
    expect(bottom).toBeTruthy();
    expect(parseFloat(bottom!.style.height)).toBe(3 * 32);
  });

  it("uses measureHeight even while the block is scrolled out of view", () => {
    // The block sits far below the window, so it never mounts — its height
    // must still land in the index, or the scrollbar is wrong.
    const { root, codeId } = mount({ lineCount: 4000, before: 3000 });
    expect(root.querySelector(`[data-block-id="${codeId}"]`)).toBeFalsy();
    const bottom = root.querySelector(
      ".creo-vspacer-bottom",
    ) as HTMLElement | null;
    expect(bottom).toBeTruthy();
    // 4000 lines * 16px = 64,000px of the bottom spacer come from the block
    // alone; the 3000 leading paragraphs above it are in the top spacer.
    expect(parseFloat(bottom!.style.height)).toBeGreaterThan(60000);
  });

  it("excludes self-virtualized blocks from the ResizeObserver", () => {
    const observed: string[] = [];
    const RealRO = globalThis.ResizeObserver;
    class SpyRO {
      constructor(_cb: unknown) {}
      observe(el: HTMLElement) {
        observed.push(el.getAttribute("data-block-kind") ?? "?");
      }
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = SpyRO;
    try {
      mount({ lineCount: 40, before: 2 });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed).not.toContain("longcode");
      expect(observed).toContain("p");
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RealRO;
    }
  });

  it("re-measures when the block changes, not every frame", () => {
    let measures = 0;
    const { editor, codeId } = mount({
      lineCount: 100,
      onMeasure: () => { measures++; },
    });
    const afterMount = measures;
    expect(afterMount).toBeGreaterThan(0);
    // A doc change that leaves the block object identical must not re-measure.
    const doc = editor.docStore.get();
    editor.docStore.set({ byId: doc.byId, order: doc.order.slice() });
    expect(measures).toBe(afterMount);
    // Changing the block does re-measure.
    const b = doc.byId.get(codeId)!;
    editor.docStore.set({
      byId: new Map(doc.byId).set(codeId, {
        ...b,
        runs: [{ text: "just one line" }],
      } as Block),
      order: doc.order,
    });
    expect(measures).toBeGreaterThan(afterMount);
  });

  it("blocks without selfVirtualized are unaffected", () => {
    const root = makeContainer();
    const editor = createEditor({
      initial: {
        blocks: Array.from({ length: 300 }, (_v, i) => ({
          type: "p" as const,
          runs: [{ text: `p${i}` }],
        })),
      },
      virtualized: true,
      virtualEstimatedHeight: 30,
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const ps = root.querySelectorAll("p[data-block-id]");
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.length).toBeLessThan(300);
  });
});
