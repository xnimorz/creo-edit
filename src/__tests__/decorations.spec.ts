import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { addBlockPlugin } from "../plugins/add-block";
import { dragHandlePlugin } from "../plugins/drag-handle";

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
});
