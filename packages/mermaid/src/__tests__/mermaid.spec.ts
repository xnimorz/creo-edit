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
      "entity:edit", "entity:shape", "entity:copyItem", "entity:delete",
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

// The types that are not graphs: nothing to connect, and what is in the
// source is known by its LINE (`textkit.ts`). Same block, same gestures.
describe("mermaid block — mind maps, timelines and Gantt charts", () => {
  const MAP = "mindmap\n  root((Topic))\n    Idea one\n    Idea two\n      Detail";
  const TIMELINE = "timeline\n  title History\n  2024 : Idea\n  2025 : Prototype";
  const GANTT = "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-01-05, 5d\n  Implement :10d";

  const of = (source: string) => mount([{ id: "m1", type: "mermaid", source }]);
  const entity = (block: HTMLElement, id: string): Element =>
    Array.from(block.querySelectorAll("[data-ce-entity]")).find((n) => n.getAttribute("data-ce-entity") === id)!;
  const canvas = (block: HTMLElement): Element => block.querySelector(".ce-mermaid-canvas")!;
  const input = (block: HTMLElement): HTMLTextAreaElement | null => block.querySelector(".ce-mmd-input");
  const type = (field: HTMLTextAreaElement, value: string, commit = "Enter"): void => {
    field.value = value;
    key(field, commit);
  };
  const typing = (field: HTMLTextAreaElement | HTMLInputElement, value: string): void => {
    field.value = value;
    field.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  };
  const plus = (block: HTMLElement): HTMLElement => block.querySelector(".ce-mmd-plus")!;
  const selected = (block: HTMLElement): string[] =>
    Array.from(block.querySelectorAll(".ce-mmd-selected")).map((n) => n.getAttribute("data-ce-entity")!);
  const actions = (editor: Editor): string[] =>
    mermaidActions(editor, "m1").map((a) => `${a.scope}:${a.key}`);
  const setSource = (editor: Editor, source: string): boolean =>
    editor.dispatch({ t: "mermaid.setSource", payload: { blockId: "m1", source } });

  test("a mind map: an idea's actions; the root is renamed, not removed", async () => {
    const { block, editor } = await of(MAP);
    expect(block().dataset.interactive).toBe("true");
    press(entity(block(), "idea:2"), "pointerdown");
    expect(actions(editor)).toEqual([
      "block:mode", "block:add", "block:copy", "block:download",
      "entity:edit", "entity:shape", "entity:copyItem", "entity:delete",
    ]);
    // Nothing to connect: no dots, and the + says what it does here.
    expect(Array.from(block().querySelectorAll(".ce-mmd-dot")).every((d) => (d as HTMLElement).hidden)).toBe(true);
    expect(plus(block()).hidden).toBe(false);
    expect(plus(block()).getAttribute("aria-label")).toBe("Add an idea under this one");
    press(entity(block(), "idea:1"), "pointerdown");
    expect(actions(editor)).not.toContain("entity:delete");
    key(canvas(block()), "Delete");
    expect(sourceOf(editor)).toBe(MAP);
    // Nothing was refused, so nothing is said; with nothing selected the bar
    // says how this kind is worked on.
    expect(block().querySelector(".ce-mermaid-info")!.textContent).toBe("");
    key(canvas(block()), "Escape");
    expect(block().querySelector(".ce-mermaid-info")!.textContent).toMatch(/Tab adds one inside/);
  });

  test("a mind map: Tab adds an idea under the selected one, Shift+Enter the next beside it; Enter renames", async () => {
    const { block, editor } = await of(MAP);
    press(entity(block(), "idea:2"), "pointerdown");
    key(canvas(block()), "Tab");
    expect(sourceOf(editor)).toBe("mindmap\n  root((Topic))\n    Idea one\n      New idea\n    Idea two\n      Detail");
    expect(input(block())!.value).toBe("New idea");
    type(input(block())!, "Under one");
    expect(selected(block())).toEqual(["idea:3"]);
    // Enter renames, as in every kind of diagram.
    key(canvas(block()), "Enter");
    expect(input(block())!.value).toBe("Under one");
    key(input(block())!, "Escape");
    expect(sourceOf(editor)).toContain("      Under one\n    Idea two");
    // Shift+Enter on a selected idea: the next one, beside it. Tab in its
    // field: named, and one under it.
    key(canvas(block()), "Enter", { shiftKey: true });
    type(input(block())!, "Beside it", "Tab");
    type(input(block())!, "Deeper");
    expect(sourceOf(editor)).toBe(
      "mindmap\n  root((Topic))\n    Idea one\n      Under one\n      Beside it\n        Deeper\n    Idea two\n      Detail",
    );
    // Each step is one undo.
    editor.undo();
    expect(sourceOf(editor)).toContain("        New idea\n");
    editor.redo();
    // Shift+Enter in a name's field: named, and on to the next one beside it.
    press(entity(block(), "idea:5"), "pointerdown");
    key(canvas(block()), "F2");
    input(block())!.value = "Deepest";
    key(input(block())!, "Enter", { shiftKey: true });
    type(input(block())!, "Beside the deepest");
    expect(sourceOf(editor)).toContain("        Deepest\n        Beside the deepest\n    Idea two");
    editor.undo();
    editor.undo();
    editor.undo();
    expect(sourceOf(editor)).toContain("        New idea\n");
    // The + does what Tab does; the bar's button adds one under the root.
    press(entity(block(), "idea:2"), "pointerdown");
    click(plus(block()));
    expect(sourceOf(editor)).toContain("        New idea\n      New idea\n    Idea two");
    key(input(block())!, "Escape");
    click(block().querySelector('.ce-mermaid-bar [data-action="add"]')!);
    expect(sourceOf(editor)).toMatch(/      Detail\n    New idea$/);
  });

  test("a mind map: the idea grows as it is named; shape and Delete are edits of its lines", async () => {
    const { block, editor, changes } = await of(MAP);
    press(entity(block(), "idea:3"), "pointerdown");
    key(canvas(block()), "F2");
    const field = input(block())!;
    const before = changes.length;
    typing(field, "A second idea");
    expect(canvas(block()).textContent).toContain("A second idea");
    expect(input(block())).toBe(field);
    expect(sourceOf(editor)).toBe(MAP);
    key(field, "Enter");
    expect(sourceOf(editor)).toBe(MAP.replace("Idea two", "A second idea"));
    expect(changes.length).toBe(before + 1);
    expect(selected(block())).toEqual(["idea:3"]);

    click(block().querySelector('.ce-mermaid-entity [data-action="shape:hexagon"]')!);
    expect(sourceOf(editor)).toContain("    {{A second idea}}\n");
    expect(block().querySelector('[data-action="shape:hexagon"]')!.getAttribute("aria-pressed")).toBe("true");
    // With everything under it.
    key(canvas(block()), "Delete");
    expect(sourceOf(editor)).toBe("mindmap\n  root((Topic))\n    Idea one");
  });

  test("a mind map: ⌥↑ / ⌥↓ move an idea among its siblings, with what is under it", async () => {
    const { block, editor } = await of(MAP);
    press(entity(block(), "idea:3"), "pointerdown");
    key(canvas(block()), "ArrowUp", { altKey: true });
    expect(sourceOf(editor)).toBe("mindmap\n  root((Topic))\n    Idea two\n      Detail\n    Idea one");
    expect(selected(block())).toEqual(["idea:2"]);
    // At the top: nothing.
    key(canvas(block()), "ArrowUp", { altKey: true });
    expect(sourceOf(editor)).toBe("mindmap\n  root((Topic))\n    Idea two\n      Detail\n    Idea one");
    key(canvas(block()), "ArrowDown", { altKey: true });
    expect(sourceOf(editor)).toBe(MAP);
    editor.undo();
    expect(sourceOf(editor)).toContain("    Idea two\n      Detail\n    Idea one");
  });

  test("copy, cut and paste: the selected thing's words — a mind map's idea as an outline", async () => {
    const written: string[] = [];
    const clipboard = { writeText: (t: string) => (written.push(t), Promise.resolve()) };
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, get: () => clipboard });
    const { block, editor } = await of(MAP);
    press(entity(block(), "idea:3"), "pointerdown");
    key(canvas(block()), "c", { metaKey: true });
    expect(written).toEqual(["Idea two\n  Detail"]);
    // The bar has it too.
    click(block().querySelector('.ce-mermaid-entity [data-action="copyItem"]')!);
    expect(written).toHaveLength(2);
    // ⌘V: the browser's paste, into a field of the block's for that moment.
    press(entity(block(), "idea:2"), "pointerdown");
    key(canvas(block()), "v", { metaKey: true });
    const field = block().querySelector<HTMLTextAreaElement>(".ce-mmd-clip")!;
    expect(document.activeElement).toBe(field);
    const pasteIt = (into: Element, text: string): void => {
      const ev = new win.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event;
      Object.defineProperty(ev, "clipboardData", { value: { getData: () => text } });
      into.dispatchEvent(ev);
    };
    pasteIt(field, written[0]!);
    expect(sourceOf(editor)).toBe("mindmap\n  root((Topic))\n    Idea one\n      Idea two\n        Detail\n    Idea two\n      Detail");
    expect(selected(block())).toEqual(["idea:3"]);
    expect(document.activeElement).toBe(canvas(block()));
    // ⌘X: copied, and gone with what is under it.
    key(canvas(block()), "x", { metaKey: true });
    expect(written.at(-1)).toBe("Idea two\n  Detail");
    expect(sourceOf(editor)).toBe(MAP);
    delete (win.navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  test("paste in a kind with no outline: a new item a line, from the selection", async () => {
    const { block, editor } = await of(GANTT);
    press(entity(block(), "task:4"), "pointerdown");
    key(canvas(block()), "v", { metaKey: true });
    const field = block().querySelector<HTMLTextAreaElement>(".ce-mmd-clip")!;
    const ev = new win.Event("paste", { bubbles: true, cancelable: true }) as unknown as Event;
    Object.defineProperty(ev, "clipboardData", { value: { getData: () => "Review\nShip: v1" } });
    field.dispatchEvent(ev);
    expect(sourceOf(editor)).toContain("  Design :a1, 2026-01-05, 5d\n  Ship#58; v1 :1d\n  Review :1d\n  Implement :10d");
  });

  test("what is selected is followed when someone else adds a line above it", async () => {
    const { block, editor } = await of(MAP);
    press(entity(block(), "idea:3"), "pointerdown");
    expect(setSource(editor, MAP.replace("    Idea one", "    Idea one\n      From elsewhere"))).toBe(true);
    await tick(30);
    expect(selected(block())).toEqual(["idea:4"]);
    key(canvas(block()), "Delete");
    expect(sourceOf(editor)).toBe("mindmap\n  root((Topic))\n    Idea one\n      From elsewhere");
  });

  test("a name being typed lands on its idea though lines arrived above it meanwhile", async () => {
    const { block, editor } = await of(MAP);
    entity(block(), "idea:3").dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true }) as unknown as Event);
    const field = input(block())!;
    typing(field, "Renamed");
    setSource(editor, MAP.replace("    Idea one", "    Idea one\n      From elsewhere"));
    await tick(30);
    // The picture follows the next key over the newer source…
    typing(field, "Renamed here");
    expect(canvas(block()).textContent).toContain("From elsewhere");
    expect(canvas(block()).textContent).toContain("Renamed here");
    expect(canvas(block()).textContent).toContain("Idea one");
    key(field, "Enter");
    // …and the name is written to the idea it was opened on.
    expect(sourceOf(editor)).toBe(
      "mindmap\n  root((Topic))\n    Idea one\n      From elsewhere\n    Renamed here\n      Detail",
    );
  });

  test("the idea being renamed is removed elsewhere: its field goes, nothing is written", async () => {
    const { block, editor } = await of(MAP);
    entity(block(), "idea:4").dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true }) as unknown as Event);
    const field = input(block())!;
    typing(field, "Too late");
    const without = "mindmap\n  root((Topic))\n    Idea one\n    Idea two";
    setSource(editor, without);
    await tick(30);
    key(field, "Enter");
    await tick(30);
    expect(input(block())).toBeNull();
    expect(sourceOf(editor)).toBe(without);
    expect(canvas(block()).textContent).not.toContain("Too late");
  });

  test("a timeline: + on a period adds an event, Shift+Enter the next period; an event is its own", async () => {
    const { block, editor } = await of(TIMELINE);
    expect(block().dataset.interactive).toBe("true");
    press(entity(block(), "period:2"), "pointerdown");
    expect(actions(editor)).toContain("entity:delete");
    click(plus(block()));
    expect(sourceOf(editor)).toBe("timeline\n  title History\n  2024 : Idea\n       : New event\n  2025 : Prototype");
    type(input(block())!, "Sketches");
    expect(selected(block())).toEqual(["event:3:0"]);
    // An event has no + of its own (it would sit on the event under it);
    // Tab from it still adds the period's next.
    expect(plus(block()).hidden).toBe(true);
    key(canvas(block()), "Tab");
    type(input(block())!, "Name");
    expect(sourceOf(editor)).toContain("  2024 : Idea\n       : Sketches\n       : Name\n  2025");

    press(entity(block(), "period:2"), "pointerdown");
    key(canvas(block()), "Enter");
    expect(input(block())!.value).toBe("2024");
    key(input(block())!, "Escape");
    key(canvas(block()), "Enter", { shiftKey: true });
    type(input(block())!, "2024 H2", "Tab");
    type(input(block())!, "Beta");
    expect(sourceOf(editor)).toBe(
      "timeline\n  title History\n  2024 : Idea\n       : Sketches\n       : Name\n  2024 H2\n    : Beta\n  2025 : Prototype",
    );
    // The event on its period's own line: a click on it is not one on the
    // period it is drawn inside.
    press(entity(block(), "event:2:0"), "pointerdown");
    expect(selected(block())).toEqual(["event:2:0"]);
    key(canvas(block()), "Delete");
    expect(sourceOf(editor)).toContain("  2024\n       : Sketches\n");
    press(entity(block(), "title:1"), "pointerdown");
    key(canvas(block()), "F2");
    type(input(block())!, "Our story");
    expect(sourceOf(editor)).toContain("  title Our story\n");
    // A heading has no "next": Shift+Enter renames it, as Enter does.
    key(canvas(block()), "Enter", { shiftKey: true });
    expect(input(block())!.value).toBe("Our story");
  });

  test("a Gantt chart: a task's marks and its dates are in the bar", async () => {
    const { block, editor } = await of(GANTT);
    expect(block().dataset.interactive).toBe("true");
    press(entity(block(), "task:5"), "pointerdown");
    expect(actions(editor)).toEqual([
      "block:mode", "block:add", "block:copy", "block:download",
      "entity:edit", "entity:flags", "entity:start", "entity:length", "entity:copyItem", "entity:delete",
    ]);
    click(block().querySelector('.ce-mermaid-entity [data-action="flags:done"]')!);
    expect(sourceOf(editor)).toContain("  Implement :done, 10d");
    expect(block().querySelector('[data-action="flags:done"]')!.getAttribute("aria-pressed")).toBe("true");
    click(block().querySelector('.ce-mermaid-entity [data-action="flags:active"]')!);
    expect(sourceOf(editor)).toContain("  Implement :active, 10d");

    const field = (name: string): HTMLInputElement =>
      Array.from(block().querySelectorAll<HTMLInputElement>(".ce-mermaid-field-input")).find((i) => i.dataset.field === name)!;
    expect(field("start").value).toBe("");
    expect(field("length").value).toBe("10d");
    typing(field("length"), "2 weeks");
    key(field("length"), "Enter");
    expect(sourceOf(editor)).toContain("  Implement :active, 2w");
    expect(field("length").value).toBe("2w");
    // By the other task's name: it has an id, which is what is written.
    typing(field("start"), "after design");
    field("start").dispatchEvent(new win.FocusEvent("blur") as unknown as Event);
    expect(sourceOf(editor)).toContain("  Implement :active, after a1, 2w");
    expect(field("start").value).toBe("after a1");
    // One undo each.
    editor.undo();
    expect(sourceOf(editor)).toContain("  Implement :active, 2w");
    // A date the engine cannot read is not written, and the field says what
    // the diagram has.
    press(entity(block(), "task:5"), "pointerdown");
    typing(field("start"), "next tuesday");
    key(field("start"), "Enter");
    expect(sourceOf(editor)).toContain("  Implement :active, 2w");
    expect(field("start").value).toBe("");
    expect(block().querySelector(".ce-mermaid-info")!.textContent).toMatch(/not applied/);
  });

  test("a Gantt chart: a day is picked from a calendar — the host's, else the browser's", async () => {
    const asked: { label: string; value: string | null; pick(day: string): void }[] = [];
    const { block, editor } = await mount([{ id: "m1", type: "mermaid", source: GANTT }], {
      plugin: { pickDate: (request) => asked.push(request) },
    });
    press(entity(block(), "task:4"), "pointerdown");
    const start = mermaidActions(editor, "m1").find((a) => a.key === "start")!;
    expect(start.field!.date!.value).toBe("2026-01-05");
    // A length that is no date holds no day, and can still be given one.
    expect(mermaidActions(editor, "m1").find((a) => a.key === "length")!.field!.date!.value).toBeNull();
    const pick = (name: string): HTMLElement => block().querySelector(`[data-action="pick:${name}"]`)!;
    click(pick("start"));
    expect(asked).toHaveLength(1);
    expect([asked[0]!.label, asked[0]!.value]).toEqual(["Start", "2026-01-05"]);
    asked[0]!.pick("2026-02-03");
    expect(sourceOf(editor)).toContain("  Design :a1, 2026-02-03, 5d");
    expect(selected(block())).toEqual(["task:4"]);
    click(pick("length"));
    asked[1]!.pick("2026-02-10");
    expect(sourceOf(editor)).toContain("  Design :a1, 2026-02-03, 2026-02-10");
    expect(mermaidActions(editor, "m1").find((a) => a.key === "length")!.field!.date!.value).toBe("2026-02-10");
    // One undo each.
    editor.undo();
    expect(sourceOf(editor)).toContain("  Design :a1, 2026-02-03, 5d");

    // The host's calendar may take the focus — it is beside the document,
    // not in the block: the task stays selected, and its bar with it.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    click(pick("start"));
    outside.focus();
    block().dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    await tick(10);
    expect(selected(block())).toEqual(["task:4"]);
    asked[2]!.pick("2026-02-04");
    expect(sourceOf(editor)).toContain("  Design :a1, 2026-02-04, 5d");
    expect(block().querySelector('[data-action="pick:start"]')).not.toBeNull();
    // With nothing being picked, the focus elsewhere lets the selection go.
    block().dispatchEvent(new win.FocusEvent("focusout", { bubbles: true }) as unknown as Event);
    await tick(10);
    expect(selected(block())).toEqual([]);
    outside.remove();
    asked.length = 2;

    // A chart whose dates are written another way gets them written so…
    const other = await mount(
      [{ id: "m1", type: "mermaid", source: "gantt\n  dateFormat DD/MM/YYYY\n  A :05/01/2026, 5d" }],
      { plugin: { pickDate: (request) => asked.push(request) } },
    );
    press(entity(other.block(), "task:2"), "pointerdown");
    click(other.block().querySelector('[data-action="pick:start"]')!);
    expect(asked[2]!.value).toBe("2026-01-05");
    asked[2]!.pick("2026-03-09");
    expect(sourceOf(other.editor)).toBe("gantt\n  dateFormat DD/MM/YYYY\n  A :09/03/2026, 5d");
    // …and one whose dates say more than a day has no calendar: they are typed.
    const timed = await of("gantt\n  dateFormat YYYY-MM-DD HH:mm\n  A :2026-01-05 09:00, 5d");
    press(entity(timed.block(), "task:2"), "pointerdown");
    expect(timed.block().querySelector('[data-action="pick:start"]')).toBeNull();
    expect(timed.block().querySelector('.ce-mermaid-field-input[data-field="start"]')).not.toBeNull();

    // With no picker of the host's: the browser's, owned by a field of its own.
    const plain = await of(GANTT);
    press(entity(plain.block(), "task:5"), "pointerdown");
    click(plain.block().querySelector('[data-action="pick:start"]')!);
    const native = plain.block().querySelector<HTMLInputElement>(".ce-mermaid-native-date")!;
    expect(native.type).toBe("date");
    native.value = "2026-01-20";
    native.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    expect(sourceOf(plain.editor)).toContain("  Implement :2026-01-20, 10d");
    expect(plain.block().querySelector(".ce-mermaid-native-date")).toBeNull();
  });

  test("a Gantt chart: Tab adds the next task; a field being typed in survives the bar's redraw", async () => {
    const { block, editor, root } = await of(GANTT);
    press(entity(block(), "task:4"), "pointerdown");
    key(canvas(block()), "Tab");
    type(input(block())!, "Review");
    expect(sourceOf(editor)).toContain("  Design :a1, 2026-01-05, 5d\n  Review :1d\n  Implement :10d");
    expect(selected(block())).toEqual(["task:5"]);

    const length = (): HTMLInputElement =>
      Array.from(block().querySelectorAll<HTMLInputElement>(".ce-mermaid-field-input")).find((i) => i.dataset.field === "length")!;
    const first = length();
    first.focus();
    typing(first, "3");
    // Its keys are its own: the editor around it hears none of them.
    let reached = 0;
    root.querySelector("[data-creo-edit]")!.addEventListener("keydown", () => reached++);
    key(first, "a");
    expect(reached).toBe(0);
    // Someone else changes the diagram: the bar is drawn again.
    setSource(editor, sourceOf(editor).replace("title Plan", "title The plan"));
    await tick(30);
    const again = length();
    expect(again).not.toBe(first);
    expect(again.value).toBe("3");
    expect(document.activeElement).toBe(again);
    key(again, "Enter");
    expect(sourceOf(editor)).toContain("  Review :3d\n");
    // Escape gives the field back what the diagram has.
    typing(length(), "99");
    key(length(), "Escape");
    expect(length().value).toBe("3d");
    expect(sourceOf(editor)).toContain("  Review :3d\n");
  });

  test("a read-only editor edits none of them", async () => {
    for (const source of [MAP, TIMELINE, GANTT]) {
      const ro = await mount([{ id: "m1", type: "mermaid", source }], { editable: false });
      expect(ro.block().dataset.state).toBe("ready");
      expect(ro.block().dataset.interactive).toBeUndefined();
      expect(ro.block().querySelectorAll("[data-ce-entity]").length).toBe(0);
    }
  });
});
