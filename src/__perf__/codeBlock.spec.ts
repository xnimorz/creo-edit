import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../__tests__/setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { anchorToDom } from "../dom/anchorMap";
import type { AnchorRange, DocState } from "../model/types";
import type { DecorationViewport, EditorPlugin } from "../plugin/types";
import { caretAt } from "../controller/selection";

// ---------------------------------------------------------------------------
// The shape a code editor built on creo-edit actually drives: ONE `code` block
// holding a whole file, plus a fat set of range decorations carrying syntax
// tokens (one decoration per token style, ~6 token ranges per line).
//
// Timings here run under happy-dom, so absolute numbers are inflated relative
// to a real engine — the budgets below are deliberately loose. What the gate
// really protects is the SHAPE of the growth: before the O(log L) code-block
// codec, a repaint walked every line element for every one of ~18k anchors,
// which is quadratic in file size. A regression there blows these budgets by
// two orders of magnitude, not by a few percent.
//
// TWO globals are stubbed, and for different reasons:
//
//   - `CSS.highlights` / `Highlight`, because happy-dom doesn't implement the
//     Custom Highlight API at all. Same stub the behavioural spec uses.
//   - `Range`, because happy-dom's `setStart` walks the document to validate
//     the boundary point, making ONE call O(nodes in the document): measured
//     0.017ms at 100 lines and 0.73ms at 2 000, i.e. ~26s of pure happy-dom
//     bookkeeping for a 2 000-line repaint. Every real engine does this in
//     roughly constant time. Leaving it in would mean the gate measured
//     happy-dom and nothing else — the editor's own contribution (anchor
//     resolution) would be 1% of the number and a 100× regression in it
//     would still pass. The stub keeps exactly the surface the manager uses.
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

/** Constant-time stand-in for the four Range members `toDomRange` touches. */
class FakeRange {
  startContainer: Node | null = null;
  startOffset = 0;
  endContainer: Node | null = null;
  endOffset = 0;
  setStart(node: Node, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node: Node, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }
  get collapsed(): boolean {
    return (
      this.startContainer === this.endContainer &&
      this.startOffset === this.endOffset
    );
  }
}

let realRange: unknown;

beforeEach(() => {
  registered.clear();
  realRange = (globalThis as { Range?: unknown }).Range;
  (globalThis as { Range?: unknown }).Range = FakeRange;
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
  (globalThis as { Range?: unknown }).Range = realRange;
  delete (globalThis as { Highlight?: unknown }).Highlight;
  delete (globalThis as { CSS?: unknown }).CSS;
});

const TOKEN_STYLES = 64;
/** Roughly what a tokenizer emits per line of real source. */
const TOKENS_PER_LINE = 6;

function makeSource(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`  const value${i} = compute(${i}, "label ${i}"); // note ${i}`);
  }
  return out.join("\n");
}

/**
 * Line start offsets for the model text, so the fixture's token ranges are
 * real character positions rather than a fixed span the codec could special
 * case. Mirrors what a host's tokenizer would hand back.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * 64 decorations, ~6 token ranges per line, bucketed by style id — what a
 * tokenizer feeding `MAX_TOKEN_STYLES` highlight names produces. The ranges
 * are computed once on first call and reused, so the gate times the editor's
 * resolution work rather than the fixture's own tokenizing.
 */
function tokenPlugins(
  text: string,
  /** When true, sources narrow to `viewport.windowIn(block)` — the shape a
   *  host should use once it can ask which characters are on screen. */
  scoped = false,
): EditorPlugin[] {
  let perStyle: AnchorRange[][] | null = null;
  const build = (doc: DocState): AnchorRange[][] => {
    const blockId = doc.order[0]!;
    const starts = lineStarts(text);
    const out: AnchorRange[][] = Array.from({ length: TOKEN_STYLES }, () => []);
    for (let line = 0; line < starts.length; line++) {
      const start = starts[line]!;
      const end = line + 1 < starts.length ? starts[line + 1]! - 1 : text.length;
      const span = Math.max(1, Math.floor((end - start) / TOKENS_PER_LINE));
      for (let t = 0; t < TOKENS_PER_LINE; t++) {
        const from = Math.min(end, start + t * span);
        const to = Math.min(end, from + Math.max(1, span - 1));
        if (to <= from) continue;
        out[(line * TOKENS_PER_LINE + t) % TOKEN_STYLES]!.push({
          from: { blockId, path: [from], offset: from },
          to: { blockId, path: [to], offset: to },
        });
      }
    }
    return out;
  };
  return Array.from({ length: TOKEN_STYLES }, (_v, i) => ({
    name: `tok-${i}`,
    rangeDecorations: [
      {
        id: `tok-${i}`,
        className: `tok-${i}`,
        ranges(doc: DocState, viewport: DecorationViewport | null) {
          perStyle ??= build(doc);
          const all = perStyle[i]!;
          if (!scoped) return all;
          const win = viewport?.windowIn?.(doc.order[0]!);
          if (!win) return all;
          // Ranges are emitted in document order, so a binary search would do;
          // a filter is fine here and keeps the fixture honest about the cost
          // it is NOT trying to hide (the editor's resolution work is what the
          // gate times).
          return all.filter((r) => r.to.offset > win.from && r.from.offset < win.to);
        },
      },
    ],
  }));
}

const LINE_PX = 20;
const VIEWPORT_PX = 400;

/**
 * happy-dom has no layout, so `windowIn` — which needs to know where the
 * block sits relative to the scroll container — can never answer. Give the
 * two elements it measures a plausible fake geometry: a 400px scroll pane at
 * the top of the screen, and a block of 20px lines starting at its top.
 *
 * Nothing else in the editor reads these rects on this path, so the fake
 * stays local to what the gate is about.
 */
function fakeLayout(container: HTMLElement, blockEl: HTMLElement, lines: number) {
  container.style.overflowY = "auto";
  Object.defineProperty(container, "clientHeight", {
    value: VIEWPORT_PX,
    configurable: true,
  });
  const rect = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  container.getBoundingClientRect = () => rect(0, VIEWPORT_PX);
  blockEl.getBoundingClientRect = () => rect(0, lines * LINE_PX);
}

function mountCodeFile(lines: number, opts: { scoped?: boolean } = {}) {
  const text = makeSource(lines);
  const container = makeContainer();
  const editor = createEditor({
    initial: { blocks: [{ type: "code", runs: [{ text }] }] },
    plugins: tokenPlugins(text, opts.scoped),
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const blockEl = container.querySelector<HTMLElement>(".ce-code-block")!;
  if (opts.scoped) fakeLayout(container, blockEl, lines);
  return { editor, container, text, blockId: editor.docStore.get().order[0]! };
}

// Budgets are ~5-10× the measured cost, so ordinary CI noise doesn't flake
// them while a structural regression (anything that reintroduces per-anchor
// O(lines) work) overshoots by orders of magnitude.
describe("Performance gates — large code block", () => {
  it("mounts a 2000-line file in < 600ms", () => {
    const t0 = performance.now();
    const { container } = mountCodeFile(2000);
    const dt = performance.now() - t0;
    expect(container.querySelectorAll(".ce-code-line").length).toBe(2000);
    expect(dt).toBeLessThan(600);
  });

  it("repaints 64 token decorations over a 2000-line file in < 100ms", () => {
    const { editor } = mountCodeFile(2000);
    const t0 = performance.now();
    editor.refreshRangeDecorationsSync();
    const dt = performance.now() - t0;
    // Every style painted something, so the timing covers real resolution
    // work rather than an early-out.
    let painted = 0;
    for (const hl of registered.values()) painted += hl.ranges.length;
    expect(painted).toBeGreaterThan(10_000);
    expect(dt).toBeLessThan(100);
  });

  it("keystroke in a 2000-line file — render + full repaint < 25ms avg", () => {
    const { editor, blockId } = mountCodeFile(2000);
    editor.selStore.set({ kind: "caret", at: caretAt(blockId, 10) });
    const N = 10;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      editor.dispatch({ t: "insertText", text: "x" });
      editor.refreshRangeDecorationsSync();
    }
    const avg = (performance.now() - t0) / N;
    expect(avg).toBeLessThan(25);
  });

  it("a viewport-scoped source repaints in O(visible), not O(file)", () => {
    const { editor } = mountCodeFile(2000, { scoped: true });
    editor.refreshRangeDecorationsSync();
    let painted = 0;
    for (const hl of registered.values()) painted += hl.ranges.length;
    // 400px of viewport + a viewport of slack each way at 20px/line — a few
    // dozen lines out of 2 000, and nothing like the ~18 000 ranges the
    // unscoped source hands over.
    expect(painted).toBeGreaterThan(0);
    expect(painted).toBeLessThan(1000);

    const N = 10;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) editor.refreshRangeDecorationsSync();
    const avg = (performance.now() - t0) / N;
    expect(avg).toBeLessThan(5);
  });

  it("resolves an anchor at the end of a 2000-line file in < 0.05ms", () => {
    const { editor, container, text } = mountCodeFile(2000);
    const editorRoot = container.querySelector<HTMLElement>("[data-creo-edit]")!;
    const blockId = editor.docStore.get().order[0]!;
    const at = { blockId, path: [text.length - 5], offset: text.length - 5 };
    // Warm up the DOM caches the codec may keep.
    anchorToDom(at, editorRoot);
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) anchorToDom(at, editorRoot);
    const avg = (performance.now() - t0) / N;
    expect(avg).toBeLessThan(0.05);
  });
});
