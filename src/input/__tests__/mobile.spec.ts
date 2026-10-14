import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../__tests__/setup";
import { clearDom, SYNC_SCHEDULER, win } from "../../__tests__/setup";
import { createApp, HtmlRender } from "creo";
import { createEditor, type EditorOptions } from "../../createEditor";
import { revealScroller } from "../../dom/scroll";
import { __resetCoarsePointerCache, isCoarsePointer } from "../mobile";

type MatchMedia = (q: string) => MediaQueryList;
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  __resetCoarsePointerCache();
  (window as unknown as { matchMedia: MatchMedia }).matchMedia = originalMatchMedia;
});

describe("mobile — isCoarsePointer", () => {
  it("returns false when matchMedia(coarse) does not match", () => {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList })
      .matchMedia = (q: string) =>
      ({ matches: false, media: q } as MediaQueryList);
    expect(isCoarsePointer()).toBe(false);
  });

  it("returns true when matchMedia(coarse) matches (cached)", () => {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList })
      .matchMedia = (q: string) =>
      ({ matches: true, media: q } as MediaQueryList);
    expect(isCoarsePointer()).toBe(true);
    // Cache: a second call doesn't re-query.
    (window as unknown as { matchMedia: (q: string) => MediaQueryList })
      .matchMedia = (() => {
        throw new Error("matchMedia must not be re-queried");
      }) as never;
    expect(isCoarsePointer()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Caret-above-keyboard scrolling. happy-dom has no layout or visualViewport,
// so geometry is stubbed: a 600px scroller over 3000px of content, and a
// caret at `caretTop`. Real-engine tests: examples/editor/tests/viewport.mobile.spec.ts.
// ---------------------------------------------------------------------------

type FakeViewport = {
  height: number;
  offsetTop: number;
  scale: number;
  fire(type: "resize" | "scroll"): void;
  listenerCount(): number;
};

function installViewport(height: number): FakeViewport {
  const listeners = new Map<string, Set<() => void>>();
  const vv = {
    height,
    offsetTop: 0,
    scale: 1,
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
  (window as unknown as { visualViewport?: unknown }).visualViewport = vv;
  return vv;
}

let caretTop = 0;
const RangeProto = win.Range.prototype as unknown as {
  getBoundingClientRect: () => unknown;
};
const originalRangeRect = RangeProto.getBoundingClientRect;

/** Let the tracker's flush run (a microtask under happy-dom). */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function boxed(el: HTMLElement, top: number, height: number, scrollHeight: number) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 390, width: 390 }) as DOMRect;
}

function mount(opts: EditorOptions = {}) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  boxed(scroller, 0, 600, 3000);
  const calls: ScrollToOptions[] = [];
  scroller.scrollTo = ((o: ScrollToOptions) => {
    calls.push(o);
  }) as typeof scroller.scrollTo;
  document.body.appendChild(scroller);
  const host = scroller.appendChild(document.createElement("div"));
  const editor = createEditor({
    initial: {
      blocks: Array.from({ length: 30 }, (_, i) => ({
        type: "p" as const,
        runs: [{ text: `Paragraph ${i}` }],
      })),
    },
    ...opts,
  });
  createApp(() => editor.EditorView(), new HtmlRender(host), SYNC_SCHEDULER).mount();
  const root = host.querySelector("[data-creo-edit]") as HTMLElement;
  const focusCaret = () => {
    root.focus();
    const blockId = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: { blockId, path: [0], offset: 0 } });
  };
  return { root, editor, scroller, calls, focusCaret };
}

describe("mobile — keeping the caret above the keyboard", () => {
  let vv: FakeViewport;

  beforeEach(() => {
    vv = installViewport(700);
    caretTop = 500;
    RangeProto.getBoundingClientRect = () => ({
      top: caretTop,
      bottom: caretTop + 20,
      height: 20,
      left: 10,
      right: 10,
      width: 0,
    });
  });

  afterEach(() => {
    delete (window as unknown as { visualViewport?: unknown }).visualViewport;
    RangeProto.getBoundingClientRect = originalRangeRect;
    clearDom();
  });

  it("scrolls the least that uncovers a focused caret when the viewport shrinks", async () => {
    const { calls, focusCaret } = mount();
    focusCaret();
    vv.height = 400;
    vv.fire("resize");
    await settle();
    // caret bottom 520, band bottom 400 less the 24px margin: 144.
    expect(calls).toEqual([{ top: 144, behavior: "smooth" }]);
  });

  it("jumps instead of animating under prefers-reduced-motion", async () => {
    (window as unknown as { matchMedia: MatchMedia }).matchMedia = (q) =>
      ({ matches: q.includes("reduced-motion"), media: q }) as MediaQueryList;
    const { calls, focusCaret } = mount();
    focusCaret();
    vv.height = 400;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([{ top: 144, behavior: "auto" }]);
  });

  it("does not scroll on mount", async () => {
    const { calls } = mount();
    await settle();
    expect(calls).toEqual([]);
  });

  it("does not scroll on a pan, but reports it in --creo-vv-top", async () => {
    const { root, calls, focusCaret } = mount();
    focusCaret();
    vv.offsetTop = 120;
    vv.fire("scroll");
    await settle();
    expect(calls).toEqual([]);
    expect(root.style.getPropertyValue("--creo-vv-top")).toBe("120px");
  });

  it("does not scroll when the viewport grows", async () => {
    vv = installViewport(400);
    const { calls, focusCaret } = mount();
    focusCaret();
    vv.height = 700;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
  });

  it("does not scroll on a pinch-zoom", async () => {
    const { calls, focusCaret } = mount();
    focusCaret();
    vv.height = 350;
    vv.scale = 2;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
  });

  it("leaves an editor alone when the focus is elsewhere", async () => {
    const { calls, focusCaret } = mount();
    focusCaret();
    const field = document.body.appendChild(document.createElement("input"));
    field.focus();
    vv.height = 400;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
  });

  it("leaves a read-only editor alone", async () => {
    const { calls, focusCaret } = mount({ editable: false });
    focusCaret();
    vv.height = 400;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
  });

  it("keepCaretVisible: false opts out but still writes the CSS properties", async () => {
    const { root, calls, focusCaret } = mount({ keepCaretVisible: false });
    focusCaret();
    vv.height = 400;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
    expect(root.style.getPropertyValue("--creo-vv-height")).toBe("400px");
  });

  it("leaves a caret alone that was off screen before the keyboard came up", async () => {
    const { calls, focusCaret } = mount();
    focusCaret();
    caretTop = -800;
    vv.height = 400;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
  });

  it("does nothing when the caret is still visible", async () => {
    const { calls, focusCaret } = mount();
    focusCaret();
    caretTop = 100;
    vv.height = 400;
    vv.fire("resize");
    await settle();
    expect(calls).toEqual([]);
  });

  it("honours the scroller's scroll-padding-bottom (a composer over the scroller)", async () => {
    const { scroller, calls, focusCaret } = mount();
    scroller.style.scrollPaddingBottom = "60px";
    focusCaret();
    caretTop = 300;
    vv.height = 400;
    vv.fire("resize");
    await settle();
    // band bottom 400 − 60 padding − 24 margin = 316; caret bottom 320.
    expect(calls).toEqual([{ top: 4, behavior: "smooth" }]);
  });

  it("detaches from the viewport on destroy", () => {
    const { editor } = mount();
    expect(vv.listenerCount()).toBe(2);
    editor.destroy();
    expect(vv.listenerCount()).toBe(0);
  });
});

describe("dom/scroll — revealScroller", () => {
  afterEach(() => clearDom());

  function chain(...styles: Partial<CSSStyleDeclaration>[]): HTMLElement[] {
    let parent: HTMLElement = document.body;
    return styles.map((style) => {
      const el = parent.appendChild(document.createElement("div"));
      Object.assign(el.style, style);
      parent = el;
      return el;
    });
  }

  it("skips a scroller with nothing to scroll", () => {
    const [outer, inner, leaf] = chain({ overflowY: "auto" }, { overflowY: "auto" }, {});
    boxed(outer!, 0, 600, 3000);
    boxed(inner!, 0, 600, 600);
    expect(revealScroller(leaf!)).toBe(outer!);
  });

  it("skips a sideways scroller", () => {
    // Browsers compute overflow-y to auto here; happy-dom doesn't, so set both.
    const [outer, sideways, leaf] = chain(
      { overflowY: "auto" },
      { overflowX: "auto", overflowY: "auto" },
      {},
    );
    boxed(outer!, 0, 600, 3000);
    boxed(sideways!, 0, 200, 200);
    expect(revealScroller(leaf!)).toBe(outer!);
  });

  it("stops at a clip that crops its content", () => {
    const [outer, tile, leaf] = chain({ overflowY: "auto" }, { overflowY: "hidden" }, {});
    boxed(outer!, 0, 600, 3000);
    boxed(tile!, 0, 220, 900);
    expect(revealScroller(leaf!)).toBeNull();
  });

  it("walks past an overflow: hidden box that crops nothing", () => {
    const [outer, clearfix, leaf] = chain({ overflowY: "auto" }, { overflowY: "hidden" }, {});
    boxed(outer!, 0, 600, 3000);
    boxed(clearfix!, 0, 300, 300);
    expect(revealScroller(leaf!)).toBe(outer!);
  });

  it("falls back to the page", () => {
    const [leaf] = chain({});
    expect(revealScroller(leaf!)).toBe(window);
  });

  it("does not consider the element itself", () => {
    const [outer, self] = chain({ overflowY: "auto" }, { overflowY: "auto" });
    boxed(outer!, 0, 600, 3000);
    boxed(self!, 0, 600, 3000);
    expect(revealScroller(self!)).toBe(outer!);
  });
});
