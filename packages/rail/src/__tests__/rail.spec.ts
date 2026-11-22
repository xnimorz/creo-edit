import "../../../../src/__tests__/setup";
import { afterEach, describe, expect, test } from "bun:test";
import { createApp, HtmlRender } from "creo";
import { clearDom, makeContainer, SYNC_SCHEDULER, win } from "../../../../src/__tests__/setup";
import { blockTextOf, createEditor, type DocState, type Editor, type SerializedDoc } from "creo-edit";
import { headingPoints, railController, railPlugin, type RailPluginOptions, type RailPoint } from "../index";

// happy-dom has no layout: every box is zero, so "the point being read" is
// not tested here; what is, is everything the rail decides without measuring.
Object.assign(globalThis, {
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  getComputedStyle: win.getComputedStyle.bind(win),
});

const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const p = (id: string, text: string) => ({ id, type: "p", runs: [{ text }] });
const h = (id: string, level: number, text: string) => ({ id, type: `h${level}`, runs: [{ text }] });
const doc = (blocks: unknown[]): SerializedDoc => ({ blocks }) as unknown as SerializedDoc;

const ARTICLE = [
  h("a", 1, "Intro"),
  p("a1", "Why the rail exists."),
  h("b", 2, "Usage"),
  p("b1", ""),
  p("b2", "Give it points."),
  h("c", 4, "Too deep"),
  p("c1", "Not a point."),
  h("d", 3, "Styling"),
];

type Mounted = { editor: Editor; root: HTMLElement; layer: () => HTMLElement | null; ticks: () => HTMLButtonElement[] };

function mount(blocks: unknown[], options: RailPluginOptions): Mounted {
  const host = makeContainer();
  const editor = createEditor({ plugins: [railPlugin(options)], initial: doc(blocks) });
  createApp(() => editor.EditorView(), new HtmlRender(host), SYNC_SCHEDULER).mount();
  const root = host.querySelector<HTMLElement>("[data-creo-edit]")!;
  const layer = (): HTMLElement | null => host.querySelector<HTMLElement>(".creo-rail");
  return {
    editor,
    root,
    layer,
    ticks: () => Array.from(layer()?.querySelectorAll<HTMLButtonElement>(".creo-rail__tick") ?? []),
  };
}

const key = (el: Element, k: string): void => {
  el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }) as unknown as Event);
};

afterEach(() => clearDom());

describe("headingPoints", () => {
  test("a point per heading of the levels asked for, longer the higher, with the first words under it", () => {
    const editor = createEditor({ initial: doc(ARTICLE) });
    const points = headingPoints()(editor.docStore.get());
    expect(points.map((point) => [point.blockId, point.label, point.detail])).toEqual([
      ["a", "Intro", "Why the rail exists."],
      ["b", "Usage", "Give it points."],
      // The h4 has no tick, but it ends the section above it.
      ["d", "Styling", undefined],
    ]);
    expect(points.map((point) => point.size)).toEqual([1, 1 - 1 / 3, 1 - 2 / 3]);

    const top = headingPoints({ levels: [1], detail: false })(editor.docStore.get());
    expect(top).toEqual([{ blockId: "a", label: "Intro", size: 1 }]);
  });
});

describe("the rail", () => {
  test("draws a tick per point beside the editor's root, named for screen readers", () => {
    const { root, layer, ticks } = mount(ARTICLE, { points: headingPoints() });
    expect(layer()!.parentElement).toBe(root.parentElement);
    expect(layer()!.hidden).toBe(false);
    expect(layer()!.querySelector("nav")!.getAttribute("aria-label")).toBe("Jump to");
    expect(ticks().map((tick) => tick.getAttribute("aria-label"))).toEqual(["Intro", "Usage", "Styling"]);
    expect(ticks()[0]!.style.getPropertyValue("--creo-rail-size")).toBe("1");
    // One stop in the tab order; arrows move between the ticks.
    expect(ticks().map((tick) => tick.tabIndex)).toEqual([0, -1, -1]);
  });

  test("takes whatever the host calls a point: here a chat's user messages", () => {
    // The host knows its own blocks; here a user's message is one whose id it gave a `u`.
    const chat = [p("u1", "fix the flaky test"), p("r1", "Fixed."), p("u2", "make pr"), p("r2", "PR is open.")];
    const points = (state: DocState): RailPoint[] => {
      const out: RailPoint[] = [];
      for (const id of state.order) {
        if (id.startsWith("u")) out.push({ blockId: id, label: blockTextOf(state.byId.get(id)!) });
        else if (out.length > 0) out[out.length - 1]!.detail = blockTextOf(state.byId.get(id)!);
      }
      return out;
    };
    const { ticks, layer } = mount(chat, { points, side: "right", label: "Your messages" });
    expect(ticks().map((tick) => tick.getAttribute("aria-label"))).toEqual(["fix the flaky test", "make pr"]);
    expect(layer()!.classList.contains("creo-rail--right")).toBe(true);

    ticks()[1]!.dispatchEvent(new win.PointerEvent("pointerenter") as unknown as Event);
    const card = layer()!.querySelector<HTMLElement>(".creo-rail__card")!;
    expect(card.hidden).toBe(false);
    expect(card.querySelector(".creo-rail__label")!.textContent).toBe("make pr");
    expect(card.querySelector(".creo-rail__detail")!.textContent).toBe("PR is open.");
    expect(ticks()[1]!.classList.contains("is-peeked")).toBe(true);
  });

  test("hides with fewer points than it needs, and follows the document as it changes", async () => {
    const { editor, layer, ticks } = mount([h("a", 1, "Only"), p("a1", "text")], { points: headingPoints() });
    expect(layer()!.hidden).toBe(true);

    editor.appendBlocks([{ type: "h2", runs: [{ text: "Second" }] } as never]);
    await frame();
    expect(layer()!.hidden).toBe(false);
    expect(ticks().map((tick) => tick.getAttribute("aria-label"))).toEqual(["Only", "Second"]);
  });

  test("a click goes to the point's block, lights its tick, and tells the host", async () => {
    const jumped: string[] = [];
    const { editor, ticks } = mount(ARTICLE, {
      points: headingPoints(),
      onJump: (point) => jumped.push(point.blockId),
    });
    const scrolled: unknown[] = [];
    editor.scrollToBlock = (id, opts) => void scrolled.push([id, opts]);

    ticks()[1]!.click();
    expect(scrolled).toEqual([["b", { block: "start" }]]);
    expect(jumped).toEqual(["b"]);
    expect(ticks()[1]!.classList.contains("is-active")).toBe(true);
    expect(ticks()[1]!.getAttribute("aria-current")).toBe("location");
    expect(railController(editor)!.active()).toBe(1);
    await frame();
  });

  test("arrow keys walk the ticks, Escape puts the card away", () => {
    const { layer, ticks } = mount(ARTICLE, { points: headingPoints() });
    ticks()[0]!.focus();
    key(ticks()[0]!, "ArrowDown");
    expect(document.activeElement).toBe(ticks()[1]!);
    expect(ticks().map((tick) => tick.tabIndex)).toEqual([-1, 0, -1]);
    key(ticks()[1]!, "End");
    expect(document.activeElement).toBe(ticks()[2]!);
    expect(layer()!.querySelector<HTMLElement>(".creo-rail__card")!.hidden).toBe(false);
    key(ticks()[2]!, "Escape");
    expect(layer()!.querySelector<HTMLElement>(".creo-rail__card")!.hidden).toBe(true);
  });

  test("the controller reads the points, jumps, and is gone with the editor", () => {
    const { editor, layer } = mount(ARTICLE, { points: headingPoints() });
    const rail = railController(editor)!;
    expect(rail.points().map((point) => point.blockId)).toEqual(["a", "b", "d"]);
    const scrolled: string[] = [];
    editor.scrollToBlock = (id) => void scrolled.push(id);
    rail.jump("d");
    rail.jump("nope");
    expect(scrolled).toEqual(["d"]);

    editor.destroy();
    expect(layer()).toBeNull();
    expect(railController(editor)).toBeNull();
  });

  test("leaves out a point whose block is not in the document, and keeps them in document order", () => {
    const { ticks } = mount(ARTICLE, {
      points: () => [
        { blockId: "d", label: "last" },
        { blockId: "ghost", label: "gone" },
        { blockId: "a", label: "first" },
      ],
    });
    expect(ticks().map((tick) => tick.getAttribute("aria-label"))).toEqual(["first", "last"]);
  });

  test("one plugin object serves two editors, each with its own rail", () => {
    const plugin = railPlugin({ points: headingPoints() });
    const editors = [0, 1].map(() => {
      const host = makeContainer();
      const editor = createEditor({ plugins: [plugin], initial: doc(ARTICLE) });
      createApp(() => editor.EditorView(), new HtmlRender(host), SYNC_SCHEDULER).mount();
      return editor;
    });
    expect(document.querySelectorAll(".creo-rail").length).toBe(2);
    editors[0]!.destroy();
    expect(document.querySelectorAll(".creo-rail").length).toBe(1);
    expect(railController(editors[1]!)).not.toBeNull();
  });
});
