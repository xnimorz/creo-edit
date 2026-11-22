import "../../../../src/__tests__/setup";
import { afterEach, describe, expect, test } from "bun:test";
import { createApp, HtmlRender } from "creo";
import * as visimerCore from "@visimer/core";
import * as pele from "pele";
import { clearDom, makeContainer, SYNC_SCHEDULER, win } from "../../../../src/__tests__/setup";
import {
  createEditor,
  docToMarkdown,
  isAtomicBlockType,
  type DocChange,
  type Editor,
  type SerializedDoc,
} from "creo-edit";
import { docToHtml } from "../../../../src/clipboard/htmlSerializer";
import { parseHTML } from "../../../../src/clipboard/htmlParser";
import {
  createPeleEngine,
  mermaidActions,
  mermaidController,
  mermaidPlugin,
  mermaidSlashItem,
  type MermaidEngine,
} from "../index";
import { defaultMermaidTemplates } from "../templates";
import { runtimeOf } from "../runtime";
import type { PeleLike } from "../engine";

// Runs against the REAL engine and the REAL source rewriter. happy-dom has
// no layout, which Pele does not need to render (it measures text with its
// own font metrics) — but it reports every element as zero wide, and Pele
// reads that as "hidden, draw later". Giving elements a width is the one
// piece of fakery here.
Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get() {
    return 640;
  },
});

const FLOW = "flowchart TD\n  A[Start] --> B{OK?}";
const doc = (blocks: unknown[]): SerializedDoc => ({ blocks } as unknown as SerializedDoc);
const engine = (): Promise<MermaidEngine> =>
  Promise.resolve(createPeleEngine(pele as unknown as PeleLike));
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Mounted = { editor: Editor; root: HTMLElement; block: () => HTMLElement; changes: DocChange[][] };

async function mount(
  blocks: unknown[] = [{ id: "m1", type: "mermaid", source: FLOW }, { id: "p1", type: "p", runs: [{ text: "after" }] }],
  opts: { editable?: boolean; plugin?: Parameters<typeof mermaidPlugin>[0] } = {},
): Promise<Mounted> {
  const root = makeContainer();
  const editor = createEditor({
    editable: opts.editable ?? true,
    plugins: [mermaidPlugin({ engine, preload: false, ...opts.plugin })],
    initial: doc(blocks),
  });
  const changes: DocChange[][] = [];
  editor.onChange((c) => changes.push(c));
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  // The block's UI finds its editor a microtask after the first mount, then
  // waits on the two lazy loads. Load both, then let the queue drain.
  const rt = runtimeOf(editor)!;
  await rt.engine();
  await rt.visimer();
  await tick(30);
  return {
    editor,
    root,
    block: () => root.querySelector('[data-block-kind="mermaid"]') as HTMLElement,
    changes,
  };
}

const sourceOf = (editor: Editor, id = "m1"): string =>
  (editor.docStore.get().byId.get(id) as unknown as { source: string }).source;

const press = (el: Element, type: string, init: Record<string, unknown> = {}): void => {
  el.dispatchEvent(new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }) as unknown as Event);
};
const key = (el: Element, k: string, init: Record<string, unknown> = {}): void => {
  el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }) as unknown as Event);
};
const click = (el: Element): void => {
  press(el, "pointerdown");
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
};

afterEach(() => clearDom());

describe("mermaid block — model and codecs", () => {
  test("is an atomic block that round-trips through JSON", async () => {
    const { editor } = await mount();
    expect(isAtomicBlockType("mermaid")).toBe(true);
    const json = editor.toJSON();
    expect(json.blocks[0]).toEqual({ id: "m1", type: "mermaid", source: FLOW } as never);
    editor.setDoc(json);
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("a missing source deserializes to an empty diagram, not a crash", async () => {
    const { editor } = await mount([{ id: "m1", type: "mermaid" }]);
    expect(sourceOf(editor)).toBe("");
  });

  test("markdown: a mermaid fence, lengthened past any backticks in the source", async () => {
    const { editor } = await mount();
    expect(docToMarkdown(editor.toJSON())).toContain("```mermaid\n" + FLOW + "\n```");
    const tricky = await mount([{ id: "m1", type: "mermaid", source: "flowchart TD\n  A[\"```\"]" }]);
    expect(docToMarkdown(tricky.editor.toJSON())).toContain("````mermaid\n");
  });

  test("HTML out is a language-mermaid fence, escaped", async () => {
    const { editor } = await mount([{ id: "m1", type: "mermaid", source: "flowchart TD\n  A[\"a < b\"]" }]);
    const html = docToHtml(editor.docStore.get());
    expect(html).toContain('<pre data-block-kind="mermaid"><code class="language-mermaid">');
    expect(html).toContain("a &lt; b");
  });

  test("HTML in: a mermaid fence becomes a diagram; any other <pre> stays code", async () => {
    await mount();
    // The plugin's <pre> parser is registered AFTER the built-in one, which
    // never declines. Plugin-first precedence is what lets this through.
    const blocks = parseHTML(
      // `>` escaped, as any serializer writes it (ours included).
      '<pre><code class="language-mermaid">flowchart LR\n  X --&gt; Y\n</code></pre>' +
        '<pre><code class="language-js">let a = 1;</code></pre>' +
        '<div class="mermaid">pie\n  "a" : 1</div>',
    );
    expect(blocks.map((b) => b.type as string)).toEqual(["mermaid", "code", "mermaid"]);
    expect((blocks[0] as unknown as { source: string }).source).toBe("flowchart LR\n  X --> Y");
  });

  test("adoptCodeBlocks turns code[lang=mermaid] into a diagram on load, keeping its id", async () => {
    const blocks = [{ id: "c1", type: "code", lang: "mermaid", runs: [{ text: FLOW }] }, { id: "c2", type: "code", lang: "js", runs: [{ text: "x" }] }];
    const on = await mount(blocks, { plugin: { adoptCodeBlocks: true } });
    on.editor.setDoc(doc(blocks));
    expect(on.editor.docStore.get().byId.get("c1")!.type as string).toBe("mermaid");
    expect(sourceOf(on.editor, "c1")).toBe(FLOW);
    expect(on.editor.docStore.get().byId.get("c2")!.type).toBe("code");
  });

  test("every starter template is something the engine can draw", () => {
    for (const t of defaultMermaidTemplates) {
      expect(() => pele.render(t.source)).not.toThrow();
    }
  });
});

describe("mermaid block — commands", () => {
  test("setSource is one change and one undo step", async () => {
    const { editor, changes } = await mount();
    const next = FLOW + "\n  B --> C";
    expect(editor.dispatch({ t: "mermaid.setSource", payload: { blockId: "m1", source: next } })).toBe(true);
    expect(changes.at(-1)).toEqual([{ kind: "blockAttrs", blockId: "m1", type: "mermaid" }]);
    editor.undo();
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("setSource refuses an unchanged source, an unknown block, and a block of another type", async () => {
    const { editor, changes } = await mount();
    const before = changes.length;
    const set = (blockId: string, source: string) =>
      editor.dispatch({ t: "mermaid.setSource", payload: { blockId, source } });
    expect(set("m1", FLOW)).toBe(false);
    expect(set("nope", "pie")).toBe(false);
    expect(set("p1", "pie")).toBe(false);
    expect(changes.length).toBe(before);
  });

  test("insert is one undo step and one change", async () => {
    const { editor, changes } = await mount([{ id: "t", type: "p", runs: [{ text: "hello" }] }]);
    const before = changes.length;
    editor.dispatch({ t: "mermaid.insert", payload: { source: FLOW } });
    expect(editor.docStore.get().order.length).toBe(2);
    expect(changes.length).toBe(before + 1);
    expect(changes.at(-1)!.map((c) => c.kind)).toEqual(["insertBlock"]);
    editor.undo();
    expect(editor.docStore.get().order).toEqual(["t"]);
  });

  test("insert turns an empty paragraph into the diagram, else goes after the caret's block", async () => {
    const a = await mount([{ id: "e", type: "p", runs: [] }]);
    a.editor.selStore.set({ kind: "caret", at: { blockId: "e", path: [0], offset: 0 } });
    expect(a.editor.dispatch({ t: "mermaid.insert", payload: { source: FLOW } })).toBe(true);
    expect(a.editor.docStore.get().order).toEqual(["e"]);
    expect(sourceOf(a.editor, "e")).toBe(FLOW);

    const b = await mount([{ id: "t", type: "p", runs: [{ text: "hello" }] }, { id: "u", type: "p", runs: [{ text: "end" }] }]);
    b.editor.selStore.set({ kind: "caret", at: { blockId: "t", path: [2], offset: 2 } });
    b.editor.dispatch({ t: "mermaid.insert", payload: {} });
    const order = b.editor.docStore.get().order;
    expect(order.length).toBe(3);
    expect(order[0]).toBe("t");
    expect(b.editor.docStore.get().byId.get(order[1]!)!.type as string).toBe("mermaid");
    // The caret ends up beside the new block.
    const sel = b.editor.selStore.get();
    expect(sel.kind === "caret" && sel.at.blockId).toBe(order[1]!);
  });

  test("fromCode and toCode convert in place, keeping the block's id", async () => {
    const { editor } = await mount([{ id: "c", type: "code", lang: "mermaid", runs: [{ text: FLOW }] }]);
    expect(editor.dispatch({ t: "mermaid.fromCode", payload: { blockId: "c" } })).toBe(true);
    expect(editor.docStore.get().byId.get("c")!.type as string).toBe("mermaid");
    expect(editor.dispatch({ t: "mermaid.toCode", payload: { blockId: "c" } })).toBe(true);
    const back = editor.docStore.get().byId.get("c") as unknown as { type: string; lang: string; runs: { text: string }[] };
    expect([back.type, back.lang, back.runs[0]!.text]).toEqual(["code", "mermaid", FLOW]);
  });

  test("a read-only editor refuses every mutating command", async () => {
    const { editor } = await mount(undefined, { editable: false });
    expect(editor.dispatch({ t: "mermaid.setSource", payload: { blockId: "m1", source: "pie\n \"a\": 1" } })).toBe(false);
    expect(editor.dispatch({ t: "mermaid.insert", payload: {} })).toBe(false);
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("the slash item inserts a diagram", async () => {
    const { editor } = await mount([{ id: "e", type: "p", runs: [] }]);
    // The slash menu hands an item the editor's own command context.
    mermaidSlashItem.run(editor.commandCtx as Parameters<typeof mermaidSlashItem.run>[0]);
    expect(editor.docStore.get().byId.get("e")!.type as string).toBe("mermaid");
  });
});

describe("mermaid block — the block on screen", () => {
  test("draws the diagram inside a non-editable shell the renderer leaves alone", async () => {
    const { block, editor } = await mount();
    expect(block().getAttribute("contenteditable")).toBe("false");
    expect(block().dataset.state).toBe("ready");
    expect(block().querySelector(".ce-mermaid-canvas svg")).not.toBeNull();
    // A re-render of the block (new source) must keep the UI the shell holds:
    // creo declared no children for it, so it has none to reconcile away.
    const bar = block().querySelector(".ce-mermaid-bar");
    editor.dispatch({ t: "mermaid.setSource", payload: { blockId: "m1", source: FLOW + "\n  B --> C[New]" } });
    await tick(30);
    expect(block().querySelector(".ce-mermaid-bar")).toBe(bar);
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).toContain("New");
  });

  test("an empty block offers starters; picking one writes it", async () => {
    const { block, editor } = await mount([{ id: "m1", type: "mermaid", source: "" }]);
    expect(block().dataset.state).toBe("empty");
    const flow = block().querySelector('.ce-mermaid-template[data-template="flowchart"]')!;
    click(flow);
    expect(sourceOf(editor)).toBe(defaultMermaidTemplates[0]!.source);
    expect(block().dataset.state).toBe("ready");
  });

  test("source the engine cannot draw is an error state, not a blank block", async () => {
    const { block } = await mount([{ id: "m1", type: "mermaid", source: "flowchart TD\n  A[Start --> B" }]);
    expect(block().dataset.state).toBe("error");
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).toMatch(/error/i);
  });

  test("Code mode is view state: switching emits nothing and adds no undo step", async () => {
    const { block, editor, changes } = await mount();
    const ctl = mermaidController(editor)!;
    const before = changes.length;
    ctl.setMode("m1", "code");
    expect(block().dataset.mode).toBe("code");
    expect(ctl.mode("m1")).toBe("code");
    const ta = block().querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe(FLOW);
    ctl.setMode("m1", "diagram");
    expect(changes.length).toBe(before);
    editor.undo();
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("typing in the code field is a draft: the picture follows, the document waits for the commit", async () => {
    const { block, editor, changes } = await mount();
    mermaidController(editor)!.setMode("m1", "code");
    const ta = block().querySelector("textarea") as HTMLTextAreaElement;
    const next = "flowchart TD\n  X[Typed] --> Y";
    const before = changes.length;
    ta.value = next;
    ta.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    await tick(40);
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).toContain("Typed");
    expect(sourceOf(editor)).toBe(FLOW);
    ta.dispatchEvent(new win.Event("blur") as unknown as Event);
    expect(sourceOf(editor)).toBe(next);
    // One commit, however many keystrokes: one change, one undo step.
    expect(changes.length).toBe(before + 1);
    editor.undo();
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("Escape in the code field discards the draft", async () => {
    const { block, editor } = await mount();
    mermaidController(editor)!.setMode("m1", "code");
    const ta = block().querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "pie\n  \"x\" : 1";
    ta.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    key(ta, "Escape");
    expect(block().dataset.mode).toBe("diagram");
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("the code field keeps its keystrokes from the editor", async () => {
    const { block, root, editor } = await mount();
    mermaidController(editor)!.setMode("m1", "code");
    const ta = block().querySelector("textarea")!;
    const editorRoot = root.querySelector("[data-creo-edit]")!;
    let reached = 0;
    editorRoot.addEventListener("beforeinput", () => reached++);
    const ev = new win.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "x" });
    ta.dispatchEvent(ev as unknown as Event);
    // The editor cancels every `beforeinput` that reaches its root. This one
    // never got there, so the field's own typing is not swallowed.
    expect(reached).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  test("code: false offers no switch; a read-only editor shows the source read-only", async () => {
    const off = await mount(undefined, { plugin: { code: false } });
    expect(off.block().querySelector(".ce-mermaid-switch")).toBeNull();
    mermaidController(off.editor)!.setMode("m1", "code");
    expect(off.block().dataset.mode).toBe("diagram");

    const ro = await mount(undefined, { editable: false });
    mermaidController(ro.editor)!.setMode("m1", "code");
    expect((ro.block().querySelector("textarea") as HTMLTextAreaElement).readOnly).toBe(true);
  });
});

describe("mermaid block — visual editing", () => {
  const entity = (block: HTMLElement, id: string): Element =>
    Array.from(block.querySelectorAll("[data-ce-entity]")).find((n) => n.getAttribute("data-ce-entity") === id)!;
  const input = (block: HTMLElement): HTMLTextAreaElement | null => block.querySelector(".ce-mmd-input");
  const type = (field: HTMLTextAreaElement, value: string, commit = "Enter"): void => {
    field.value = value;
    key(field, commit);
  };

  test("clicking a node selects it and offers its actions in the bar", async () => {
    const { block, editor } = await mount();
    expect(block().dataset.interactive).toBe("true");
    press(entity(block(), "node:A"), "pointerdown");
    expect((block().querySelector(".ce-mmd-box") as HTMLElement).hidden).toBe(false);
    const keys = mermaidActions(editor, "m1").map((a) => `${a.scope}:${a.key}`);
    expect(keys).toEqual([
      "block:mode", "block:add", "block:direction", "block:copy", "block:download",
      "entity:edit", "entity:shape", "entity:delete",
    ]);
    // The bar draws the same list.
    expect(block().querySelector('.ce-mermaid-entity [data-action="delete"]')).not.toBeNull();
  });

  test("+ adds a connected node, selected and open for typing; one undo takes it back", async () => {
    const { block, editor } = await mount();
    press(entity(block(), "node:B"), "pointerdown");
    click(block().querySelector(".ce-mmd-plus")!);
    expect(sourceOf(editor)).toBe(FLOW + "\n  C[New step]\n  B --> C");
    const field = input(block())!;
    expect(field.value).toBe("New step");
    type(field, "Ship it");
    expect(sourceOf(editor)).toBe(FLOW + "\n  C[Ship it]\n  B --> C");
    editor.undo();
    expect(sourceOf(editor)).toBe(FLOW + "\n  C[New step]\n  B --> C");
    editor.undo();
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("the node grows as its name is typed; the document changes once, on Enter", async () => {
    const { block, editor, changes } = await mount();
    press(entity(block(), "node:A"), "pointerdown");
    key(block().querySelector(".ce-mermaid-canvas")!, "Enter");
    const field = input(block())!;
    const before = changes.length;
    const typing = (value: string): void => {
      field.value = value;
      field.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    };
    typing("Sta");
    typing("A much longer name");
    // The picture already shows it — that is the node growing…
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).toContain("A much longer name");
    // …the field is still open on the same node…
    expect(input(block())).toBe(field);
    // …and the document has not been touched.
    expect(sourceOf(editor)).toBe(FLOW);
    expect(changes.length).toBe(before);

    key(field, "Enter");
    expect(sourceOf(editor)).toBe("flowchart TD\n  A[A much longer name] --> B{OK?}");
    expect(changes.length).toBe(before + 1);
    // Still selected after the commit, though nothing had to be redrawn.
    expect((block().querySelector(".ce-mmd-box") as HTMLElement).hidden).toBe(false);
    editor.undo();
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("Escape puts back the picture of what the document holds", async () => {
    const { block, editor } = await mount();
    press(entity(block(), "node:A"), "pointerdown");
    key(block().querySelector(".ce-mermaid-canvas")!, "Enter");
    const field = input(block())!;
    field.value = "Abandoned";
    field.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).toContain("Abandoned");
    key(field, "Escape");
    expect(input(block())).toBeNull();
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).not.toContain("Abandoned");
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("a name the engine cannot draw yet keeps the last picture, and is still refused on commit", async () => {
    const { block, editor } = await mount();
    const rt = runtimeOf(editor)!;
    const real = rt.engineNow()!;
    const original = real.check.bind(real);
    real.check = (s) => (s.includes("POISON") ? { message: "no" } : original(s));
    press(entity(block(), "node:A"), "pointerdown");
    key(block().querySelector(".ce-mermaid-canvas")!, "Enter");
    const field = input(block())!;
    field.value = "POISON";
    field.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    expect(block().dataset.state).toBe("ready");
    expect(block().querySelector(".ce-mermaid-canvas")!.textContent).not.toContain("POISON");
    key(field, "Enter");
    expect(sourceOf(editor)).toBe(FLOW);
  });

  test("Tab in the label field commits and chains another connected node", async () => {
    const { block, editor } = await mount();
    press(entity(block(), "node:B"), "pointerdown");
    key(block().querySelector(".ce-mermaid-canvas")!, "Tab");
    type(input(block())!, "One", "Tab");
    type(input(block())!, "Two");
    expect(sourceOf(editor)).toBe(FLOW + "\n  C[One]\n  B --> C\n  D[Two]\n  C --> D");
  });

  test("double-click renames; Delete removes the node and its edges", async () => {
    const { block, editor } = await mount();
    entity(block(), "node:A").dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true }) as unknown as Event);
    type(input(block())!, "Begin");
    expect(sourceOf(editor)).toBe("flowchart TD\n  A[Begin] --> B{OK?}");
    press(entity(block(), "node:B"), "pointerdown");
    key(block().querySelector(".ce-mermaid-canvas")!, "Delete");
    expect(sourceOf(editor)).toBe("flowchart TD\n  A[Begin]");
  });

  test("Delete on the canvas removes the node — it must not reach the editor and remove the block", async () => {
    const { block, editor, root } = await mount();
    let reached = 0;
    root.querySelector("[data-creo-edit]")!.addEventListener("keydown", () => reached++);
    press(entity(block(), "node:B"), "pointerdown");
    key(block().querySelector(".ce-mermaid-canvas")!, "Backspace");
    expect(reached).toBe(0);
    expect(editor.docStore.get().byId.has("m1")).toBe(true);
  });

  test("shape and direction are edits to the source", async () => {
    const { block, editor } = await mount();
    press(entity(block(), "node:A"), "pointerdown");
    click(block().querySelector('.ce-mermaid-entity [data-action="shape:stadium"]')!);
    expect(sourceOf(editor)).toContain("A([Start])");
    click(block().querySelector('.ce-mermaid-bar [data-action="direction"]')!);
    expect(sourceOf(editor).startsWith("flowchart LR")).toBe(true);
  });

  test("an edit that would leave a diagram the engine cannot draw is not applied", async () => {
    // visimer accepts this rename; the label then breaks the flowchart
    // grammar for the engine. The document must keep the last good source.
    const { block, editor } = await mount();
    const rt = runtimeOf(editor)!;
    const real = rt.engineNow()!;
    const original = real.check.bind(real);
    real.check = (s) => (s.includes("POISON") ? { message: "no" } : original(s));
    entity(block(), "node:A").dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true }) as unknown as Event);
    type(input(block())!, "POISON");
    expect(sourceOf(editor)).toBe(FLOW);
    expect(block().querySelector(".ce-mermaid-info")!.textContent).toMatch(/not applied/);
  });

  test("nothing is editable by hand in a read-only editor or with visualEditing off", async () => {
    const ro = await mount(undefined, { editable: false });
    expect(ro.block().dataset.interactive).toBeUndefined();
    expect(ro.block().querySelectorAll("[data-ce-entity]").length).toBe(0);
    const off = await mount(undefined, { plugin: { visualEditing: false } });
    expect(off.block().dataset.interactive).toBeUndefined();
    expect(mermaidActions(off.editor, "m1").map((a) => a.key)).toEqual(["mode", "copy", "download"]);
  });

  test("a diagram type with no kit is still drawn, just not editable by hand", async () => {
    const { block, editor } = await mount([{ id: "m1", type: "mermaid", source: 'pie\n  "a" : 1\n  "b" : 2' }]);
    expect(block().dataset.state).toBe("ready");
    expect(block().dataset.interactive).toBeUndefined();
    expect(mermaidActions(editor, "m1").some((a) => a.key === "add")).toBe(false);
  });

  // Reference visimer so a build that tree-shakes the import is noticed here.
  test("the source rewriter is the real one", () => {
    expect(typeof visimerCore.MermaidWysiwygEditor).toBe("function");
  });
});
