// ---------------------------------------------------------------------------
// The surface a plugin author actually builds against: what a command
// receives, when init and teardown run, and the paste hook.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type SerializedDoc } from "../createEditor";
import type { DocChange } from "../model/changes";
import type { Anchor, Block, InlineRun } from "../model/types";
import type { EditorPlugin } from "../plugin/types";

afterEach(() => clearDom());

const A = (blockId: string, offset: number): Anchor => ({
  blockId,
  path: [offset],
  offset,
});

function mount(
  initial?: SerializedDoc,
  opts: Parameters<typeof createEditor>[0] = {},
) {
  const container = makeContainer();
  const editor = createEditor({ ...opts, ...(initial ? { initial } : {}) });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  const batches: DocChange[][] = [];
  editor.onChange((c) => batches.push(c));
  return { editor, batches, container };
}

const textOf = (editor: ReturnType<typeof createEditor>, id: string): string =>
  ((editor.docStore.get().byId.get(id) as { runs?: InlineRun[] })?.runs ?? [])
    .map((r) => r.text)
    .join("");

describe("CommandCtx", () => {
  it("carries dispatch, change and the editor, and nested dispatches fold into one batch", () => {
    const seen: string[] = [];
    const plugin: EditorPlugin = {
      name: "ctx-probe",
      commands: [
        {
          t: "probe",
          run(ctx) {
            seen.push(typeof ctx.dispatch, typeof ctx.change, typeof ctx.editor.toJSON);
            // Compose with a built-in instead of reimplementing it.
            ctx.dispatch({ t: "insertText", text: "!" });
            return true;
          },
        },
      ],
    };
    const { editor, batches } = mount(
      { blocks: [{ id: "a", type: "p", runs: [{ text: "hi" }] }] },
      { plugins: [plugin] },
    );
    editor.selStore.set({ kind: "caret", at: A("a", 2) });
    editor.dispatch({ t: "probe" });
    expect(seen).toEqual(["function", "function", "function"]);
    expect(textOf(editor, "a")).toBe("hi!");
    expect(batches.length).toBe(1);
    expect(batches[0]!.length).toBe(1);
  });
});

describe("plugin lifecycle", () => {
  it("onInit runs after every plugin is installed; destroy() tears down once", () => {
    const order: string[] = [];
    const a: EditorPlugin = {
      name: "a",
      onInit(ed) {
        // The other plugin's command is already registered.
        order.push(`a:init:${ed.registry.commands.has("b.cmd")}`);
        return () => order.push("a:teardown");
      },
      onDestroy: () => order.push("a:destroy"),
    };
    const b: EditorPlugin = {
      name: "b",
      commands: [{ t: "b.cmd", run: () => true }],
    };
    const { editor } = mount(undefined, { plugins: [a, b] });
    expect(order).toEqual(["a:init:true"]);
    editor.destroy();
    expect(order).toEqual(["a:init:true", "a:teardown", "a:destroy"]);
    editor.destroy();
    expect(order.length).toBe(3);
  });
});

describe("paste hook", () => {
  it("a plugin can claim the event before the built-in clipboard path", () => {
    let claimed = false;
    const plugin: EditorPlugin = {
      name: "paste-probe",
      onPaste(ctx) {
        if (!ctx.text.startsWith("MINE:")) return false;
        claimed = true;
        ctx.editor.dispatch({ t: "insertText", text: ctx.text.slice(5) });
        return true;
      },
    };
    const { editor, container } = mount(
      { blocks: [{ id: "a", type: "p", runs: [{ text: "" }] }] },
      { plugins: [plugin] },
    );
    editor.selStore.set({ kind: "caret", at: A("a", 0) });
    const root = container.querySelector("[data-creo-edit]") as HTMLElement;
    // Put the native selection inside the root so the paste handler engages.
    const target = root.querySelector("[data-run-index]") ?? root;
    const range = document.createRange();
    range.setStart(target.firstChild ?? target, 0);
    range.collapse(true);
    const nativeSel = document.getSelection()!;
    nativeSel.removeAllRanges();
    nativeSel.addRange(range);

    const dt = new DataTransfer();
    dt.setData("text/plain", "MINE:hello");
    const ev = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    expect(claimed).toBe(true);
    expect(textOf(editor, "a")).toBe("hello");
  });
});

describe("history coalescing is registry-driven", () => {
  function typingPlugin(prefixes?: string[]): EditorPlugin {
    return {
      name: "typing",
      ...(prefixes ? { historyCoalescePrefixes: prefixes } : {}),
      commands: [
        {
          t: "typing:append",
          run(ctx, payload) {
            const doc = ctx.docStore.get();
            const b = doc.byId.get("a") as Block & { runs: InlineRun[] };
            const runs = [{ text: b.runs.map((r) => r.text).join("") + String(payload) }];
            ctx.docStore.set({
              byId: new Map(doc.byId).set("a", { ...b, runs } as Block),
              order: doc.order,
            });
            return true;
          },
        },
      ],
    };
  }
  const doc: SerializedDoc = {
    blocks: [{ id: "a", type: "p", runs: [{ text: "" }] }],
  };

  it("collapses consecutive same-tag commands when the plugin declares the prefix", () => {
    const { editor } = mount(doc, { plugins: [typingPlugin(["typing:"])] });
    editor.dispatch({ t: "typing:append", payload: "x" });
    editor.dispatch({ t: "typing:append", payload: "y" });
    editor.dispatch({ t: "typing:append", payload: "z" });
    expect(textOf(editor, "a")).toBe("xyz");
    editor.undo();
    // One undo step for the whole run.
    expect(textOf(editor, "a")).toBe("");
  });

  it("without the declaration each command is its own undo step", () => {
    const { editor } = mount(doc, { plugins: [typingPlugin()] });
    editor.dispatch({ t: "typing:append", payload: "x" });
    editor.dispatch({ t: "typing:append", payload: "y" });
    editor.undo();
    expect(textOf(editor, "a")).toBe("x");
  });
});
