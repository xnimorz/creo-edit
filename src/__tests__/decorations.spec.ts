import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { addBlockPlugin } from "../plugins/add-block";
import { dragHandlePlugin } from "../plugins/drag-handle";
import { notifyMountedBlocksChanged } from "../dom/mountSignal";
import type { BlockSpec } from "../model/types";

afterEach(() => {
  clearDom();
});

function mountWith(plugins: Parameters<typeof createEditor>[0] extends infer T
  ? T extends { plugins?: infer P }
    ? P
    : never
  : never) {
  const root = makeContainer();
  const editor = createEditor({
    initial: {
      blocks: [
        { type: "p", runs: [{ text: "first" }] },
        { type: "p", runs: [{ text: "second" }] },
        { type: "p", runs: [{ text: "third" }] },
      ],
    },
    plugins: plugins as never,
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(root),
    SYNC_SCHEDULER,
  ).mount();
  return { root, editor };
}

describe("decoration manager", () => {
  it("registers decoration plugins on the editor's registry", () => {
    const { editor } = mountWith([addBlockPlugin(), dragHandlePlugin()]);
    const ids = editor.registry.decorations.map((d) => d.id).sort();
    // Built-in cellsPlugin contributes table/columns control decorations
    // alongside the user-supplied ones.
    expect(ids).toEqual(
      ["add-block", "columns-controls", "drag-handle", "table-controls"],
    );
  });

  it("mounts one decoration element per matching block per plugin", async () => {
    mountWith([addBlockPlugin(), dragHandlePlugin()]);
    // Decorations mount in a microtask via scheduleSync — flush.
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    const decoLayer = document.querySelector(".ce-decorations");
    expect(decoLayer).toBeTruthy();
    const addBtns = decoLayer!.querySelectorAll(".ce-deco-add-block");
    const dragBtns = decoLayer!.querySelectorAll(".ce-deco-drag-handle");
    expect(addBtns.length).toBe(3);
    expect(dragBtns.length).toBe(3);
  });

  it("add-block click opens a picker menu", async () => {
    mountWith([addBlockPlugin({ hoverOnly: false })]);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    const decoLayer = document.querySelector(".ce-decorations");
    expect(decoLayer).toBeTruthy();
    const addBtns = decoLayer!.querySelectorAll(".ce-deco-add-block button");
    expect(addBtns.length).toBe(3);
    expect(document.querySelector(".creo-slash")).toBeFalsy();
    const btn = addBtns[1] as HTMLElement;
    // Sanity: __creoEdit wired up + closest() finds editor root.
    const editorRoot = document.querySelector(
      "[data-creo-edit]",
    ) as HTMLElement | null;
    expect(editorRoot).toBeTruthy();
    expect(
      (editorRoot as unknown as { __creoEdit?: unknown }).__creoEdit,
    ).toBeTruthy();
    btn.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    // Click opens the menu; pick happens in a separate step.
    expect(document.querySelector(".creo-slash")).toBeTruthy();
  });

  it("picking a menu item inserts a block above the hovered one", async () => {
    const { editor } = mountWith([addBlockPlugin({ hoverOnly: false })]);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    const decoLayer = document.querySelector(".ce-decorations");
    const addBtns = decoLayer!.querySelectorAll(".ce-deco-add-block button");
    const beforeOrder = [...editor.docStore.get().order];
    (addBtns[1] as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    const items = document.querySelectorAll(".creo-slash-item");
    expect(items.length).toBeGreaterThan(0);
    // First item is "Paragraph" — pick it via mousedown (matches the menu's
    // own listener which uses mousedown so the editor doesn't lose focus).
    (items[0] as HTMLElement).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    const afterOrder = editor.docStore.get().order;
    expect(afterOrder.length).toBe(beforeOrder.length + 1);
    // The new block should be at index 1 (above the second).
    expect(afterOrder[1]).not.toBe(beforeOrder[1]);
    expect(afterOrder[2]).toBe(beforeOrder[1]);
  });

  // -------------------------------------------------------------------------
  // Windowed documents. A decoration can only exist against a block that is
  // in the DOM, so the manager iterates the mounted set. It used to walk
  // `doc.order` with a `querySelector` per block — at 50 000 blocks that was
  // ~1.2s per sync, and sync runs on every doc change.
  // -------------------------------------------------------------------------

  function mountVirtualized(n: number) {
    const root = makeContainer();
    const blocks: BlockSpec[] = Array.from({ length: n }, (_v, i) => ({
      type: "p" as const,
      runs: [{ text: `line ${i}` }],
    })) as BlockSpec[];
    const editor = createEditor({
      initial: { blocks: blocks as never },
      plugins: [addBlockPlugin({ hoverOnly: false })] as never,
      virtualized: true,
      virtualEstimatedHeight: 20,
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    return { root, editor };
  }

  it("decorates only the blocks that are actually mounted", async () => {
    const { root } = mountVirtualized(5000);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    const mountedBlocks = root.querySelectorAll("[data-block-kind]").length;
    const decos = document.querySelectorAll(".ce-deco-add-block").length;
    expect(mountedBlocks).toBeGreaterThan(0);
    expect(mountedBlocks).toBeLessThan(5000);
    expect(decos).toBe(mountedBlocks);
  });

  it("every decoration points at a block that exists in the DOM", async () => {
    const { root } = mountVirtualized(5000);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(".ce-deco-add-block"),
    )) {
      const id = el.dataset.blockId!;
      expect(root.querySelector(`[data-block-kind][data-block-id="${id}"]`)).toBeTruthy();
    }
  });

  it("follows the window when virtualized scrolling remounts blocks", async () => {
    // Scrolling changes which blocks exist without changing the document, so
    // the doc subscription can't see it. VirtualDoc announces the new mounted
    // set (dom/mountSignal.ts) and the manager re-syncs off that.
    const { root } = mountVirtualized(5000);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    const idsOf = (sel: string) =>
      new Set(
        Array.from(document.querySelectorAll<HTMLElement>(sel)).map(
          (el) => el.dataset.blockId!,
        ),
      );
    const before = idsOf(".ce-deco-add-block");
    expect(before.size).toBeGreaterThan(0);

    try {
      Object.defineProperty(window, "scrollY", {
        value: 40_000,
        configurable: true,
      });
      window.dispatchEvent(new Event("scroll"));
      await new Promise((r) => queueMicrotask(() => r(undefined)));

      const mountedIds = new Set(
        Array.from(
          root.querySelectorAll<HTMLElement>("[data-block-kind][data-block-id]"),
        ).map((el) => el.getAttribute("data-block-id")!),
      );
      const after = idsOf(".ce-deco-add-block");
      // The window really moved, and the decorations moved with it — no
      // orphans left pointing at blocks that are no longer in the DOM.
      expect([...after].some((id) => !before.has(id))).toBe(true);
      expect([...after].every((id) => mountedIds.has(id))).toBe(true);
      expect(after.size).toBe(mountedIds.size);
    } finally {
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    }
  });
});
