import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedDoc } from "../createEditor";
import { domToAnchor, anchorToDom } from "../dom/anchorMap";
import { selectionToClipboard } from "../clipboard/htmlSerializer";
import type { Anchor } from "../model/types";
import type { EditorPlugin, InlineWidgetDef } from "../plugin/types";

afterEach(() => clearDom());

const flush = () => new Promise((r) => queueMicrotask(() => r(undefined)));

const A = (blockId: string, offset: number): Anchor => ({
  blockId,
  path: [offset],
  offset,
});

function mount(initial: SerializedDoc, plugins: EditorPlugin[] = []) {
  const container = makeContainer();
  const editor = createEditor({ initial, plugins });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const root = container.querySelector("[data-creo-edit]") as HTMLElement;
  return { container, root, editor };
}

/** Ghost-text style: inert, renders text, sits at a fixed offset. */
function widgetPlugin(
  opts: {
    id?: string;
    text?: string;
    offsets?: number[];
    interactive?: boolean;
    affinity?: "before" | "after";
    onMount?: () => void;
  } = {},
): EditorPlugin {
  const def: InlineWidgetDef = {
    id: opts.id ?? "ghost",
    ...(opts.interactive !== undefined ? { interactive: opts.interactive } : {}),
    ...(opts.affinity ? { affinity: opts.affinity } : {}),
    at(doc) {
      const blockId = doc.order[0]!;
      return (opts.offsets ?? [5]).map((offset) => ({
        anchor: A(blockId, offset),
        data: offset,
      }));
    },
    mount(host) {
      opts.onMount?.();
      host.textContent = opts.text ?? ": string";
    },
  };
  return { name: `widget-${def.id}`, inlineWidgets: [def] };
}

const oneLine: SerializedDoc = {
  blocks: [{ type: "p", runs: [{ text: "hello world" }] }],
};

function widgets(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-ce-inline-widget]"),
  );
}

describe("inline widgets", () => {
  it("registers plugin widgets on the registry", () => {
    const { editor } = mount(oneLine, [widgetPlugin()]);
    expect(editor.registry.inlineWidgets.map((w) => w.id)).toEqual(["ghost"]);
  });

  it("mounts inside the line at the anchor's offset", () => {
    const { root } = mount(oneLine, [widgetPlugin()]);
    const w = widgets(root);
    expect(w.length).toBe(1);
    expect(w[0]!.textContent).toBe(": string");
    // Spliced into the run span, not appended to the block.
    expect(w[0]!.closest("[data-run-index]")).toBeTruthy();
    // The visible text reads as if the widget were part of the line…
    expect(root.textContent).toContain("hello: string world");
  });

  it("carries the marker and contenteditable=false", () => {
    const { root } = mount(oneLine, [widgetPlugin()]);
    const w = widgets(root)[0]!;
    expect(w.getAttribute("data-ce-inline-widget")).toBe("ghost");
    expect(w.getAttribute("contenteditable")).toBe("false");
    expect(w.getAttribute("data-affinity")).toBe("after");
  });

  it("is inert by default and interactive on request", () => {
    const { root } = mount(oneLine, [widgetPlugin()]);
    expect(widgets(root)[0]!.style.pointerEvents).toBe("none");
    clearDom();
    const b = mount(oneLine, [widgetPlugin({ interactive: true })]);
    expect(widgets(b.root)[0]!.style.pointerEvents).toBe("auto");
  });

  // -------------------------------------------------------------------------
  // 1. Invisible to the character-offset walk.
  // -------------------------------------------------------------------------

  it("contributes no characters to the offset walk", () => {
    const { root, editor } = mount(oneLine, [widgetPlugin()]);
    const id = editor.docStore.get().order[0]!;
    // "world" starts at model offset 6 — after the widget, which sits at 5.
    const point = anchorToDom(A(id, 8), root);
    expect(point).toBeTruthy();
    const back = domToAnchor(point!.node, point!.offset, root);
    expect(back).toEqual(A(id, 8));
  });

  it("keeps every anchor after it on the line unshifted", () => {
    const withW = mount(oneLine, [widgetPlugin({ text: "VERY LONG HINT" })]);
    const id = withW.editor.docStore.get().order[0]!;
    const mapped: number[] = [];
    for (let i = 0; i <= 11; i++) {
      const p = anchorToDom(A(id, i), withW.root)!;
      mapped.push(domToAnchor(p.node, p.offset, withW.root)!.offset);
    }
    expect(mapped).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("maps a hit inside the widget to the position before it", () => {
    const { root, editor } = mount(oneLine, [widgetPlugin()]);
    const id = editor.docStore.get().order[0]!;
    const w = widgets(root)[0]!;
    const inner = w.firstChild!;
    expect(domToAnchor(inner, 3, root)).toEqual(A(id, 5));
  });

  it("does not place the caret inside the widget", () => {
    const { root } = mount(oneLine, [widgetPlugin()]);
    const id = (root.querySelector("[data-block-id]") as HTMLElement).getAttribute(
      "data-block-id",
    )!;
    for (let i = 0; i <= 11; i++) {
      const p = anchorToDom(A(id, i), root)!;
      const el = p.node.nodeType === 1
        ? (p.node as HTMLElement)
        : p.node.parentElement!;
      expect(el.closest("[data-ce-inline-widget]")).toBeFalsy();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Invisible to IME composition diffing.
  // -------------------------------------------------------------------------

  it("is excluded from the composition diff", async () => {
    // Without the exclusion the widget's text reads as a phantom insertion
    // and gets spliced into the model on compositionend.
    const { root, editor } = mount(oneLine, [
      widgetPlugin({ text: "GHOSTGHOSTGHOST" }),
    ]);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 11) });
    await flush();
    root.dispatchEvent(
      new window.CompositionEvent("compositionstart", { bubbles: true }) as unknown as Event,
    );
    root.dispatchEvent(
      new window.CompositionEvent("compositionend", { bubbles: true }) as unknown as Event,
    );
    const b = editor.docStore.get().byId.get(id) as { runs: { text: string }[] };
    expect(b.runs.map((r) => r.text).join("")).toBe("hello world");
  });

  // -------------------------------------------------------------------------
  // 3. Invisible to clipboard serialization.
  // -------------------------------------------------------------------------

  it("is not serialized into the clipboard", () => {
    const { editor } = mount(oneLine, [widgetPlugin({ text: "GHOST" })]);
    const id = editor.docStore.get().order[0]!;
    const payload = selectionToClipboard(editor.docStore.get(), {
      kind: "range",
      anchor: A(id, 0),
      focus: A(id, 11),
    });
    expect(payload.plain).not.toContain("GHOST");
    expect(payload.html).not.toContain("GHOST");
    expect(payload.plain).toContain("hello world");
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it("re-places itself after the renderer rewrites the run", async () => {
    const { root, editor } = mount(oneLine, [widgetPlugin()]);
    expect(widgets(root).length).toBe(1);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 0) });
    editor.dispatch({ t: "insertText", text: "X" });
    // creo rewrote the run span's textContent, discarding the widget…
    await flush();
    // …and the manager put it back.
    const after = widgets(root);
    expect(after.length).toBe(1);
    expect(after[0]!.isConnected).toBe(true);
  });

  it("reuses the host across a re-place rather than remounting", async () => {
    let mounts = 0;
    const { root, editor } = mount(oneLine, [
      widgetPlugin({ onMount: () => { mounts++; } }),
    ]);
    expect(mounts).toBe(1);
    const id = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: A(id, 0) });
    editor.dispatch({ t: "insertText", text: "X" });
    await flush();
    expect(widgets(root).length).toBe(1);
    // Same anchor key → the host is re-placed, not rebuilt, so widget-internal
    // state survives an unrelated keystroke.
    expect(mounts).toBe(1);
  });

  it("unmounts widgets the source stops reporting", async () => {
    let offsets = [3, 7];
    const plugin: EditorPlugin = {
      name: "dyn",
      inlineWidgets: [
        {
          id: "dyn",
          at: (doc) =>
            offsets.map((o) => ({ anchor: A(doc.order[0]!, o) })),
          mount: (host) => { host.textContent = "*"; },
        },
      ],
    };
    const { root, editor } = mount(oneLine, [plugin]);
    expect(widgets(root).length).toBe(2);
    offsets = [3];
    editor.refreshInlineWidgets();
    expect(widgets(root).length).toBe(1);
    offsets = [];
    editor.refreshInlineWidgets();
    expect(widgets(root).length).toBe(0);
  });

  it("runs the cleanup fn on unmount", () => {
    let cleaned = 0;
    let show = true;
    const plugin: EditorPlugin = {
      name: "cleanup",
      inlineWidgets: [
        {
          id: "cleanup",
          at: (doc) => (show ? [{ anchor: A(doc.order[0]!, 2) }] : []),
          mount: () => () => { cleaned++; },
        },
      ],
    };
    const { editor } = mount(oneLine, [plugin]);
    expect(cleaned).toBe(0);
    show = false;
    editor.refreshInlineWidgets();
    expect(cleaned).toBe(1);
  });

  it("orders 'before' widgets ahead of 'after' ones at the same anchor", () => {
    const { root } = mount(oneLine, [
      widgetPlugin({ id: "post", text: "[after]", affinity: "after" }),
      widgetPlugin({ id: "pre", text: "[before]", affinity: "before" }),
    ]);
    const texts = widgets(root).map((w) => w.textContent);
    expect(texts).toEqual(["[before]", "[after]"]);
  });

  it("survives a source that throws", () => {
    const bad: EditorPlugin = {
      name: "bad",
      inlineWidgets: [
        {
          id: "bad",
          at: () => { throw new Error("boom"); },
          mount: (host) => { host.textContent = "!"; },
        },
      ],
    };
    const { root } = mount(oneLine, [bad, widgetPlugin({ text: "ok" })]);
    const texts = widgets(root).map((w) => w.textContent);
    expect(texts).toEqual(["ok"]);
  });

  it("handles multi-line ghost text at end of line", () => {
    const { root, editor } = mount(oneLine, [
      widgetPlugin({ offsets: [11], text: "\nreturn null;\n" }),
    ]);
    expect(widgets(root).length).toBe(1);
    const id = editor.docStore.get().order[0]!;
    // The trailing anchor is still offset 11, not 11 + suggestion length.
    const p = anchorToDom(A(id, 11), root)!;
    expect(domToAnchor(p.node, p.offset, root)).toEqual(A(id, 11));
  });

  it("does nothing when no plugin registers widgets", () => {
    const { root } = mount(oneLine, []);
    expect(widgets(root).length).toBe(0);
  });
});
