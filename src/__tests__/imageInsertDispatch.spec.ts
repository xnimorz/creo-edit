import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor, type EditorOptions } from "../createEditor";
import type { DocChange } from "../model/changes";

// Pasted and dropped images used to be written straight into `docStore` once
// their upload settled, bypassing `dispatch`: no undo step, no `onChange`, no
// read-only gate at the moment the image actually arrived, writes into a
// destroyed editor, and a rejected upload escaped as an unhandled rejection.

afterEach(() => {
  clearDom();
});

function ensureObjectURL() {
  const u = (globalThis as { URL?: { createObjectURL?: unknown } }).URL;
  if (u && typeof u.createObjectURL !== "function") {
    (u as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL =
      (b: Blob) => `blob:dummy/${b.size}`;
  }
}

function mount(opts: EditorOptions = {}) {
  ensureObjectURL();
  const root = makeContainer();
  const editor = createEditor(opts);
  createApp(() => editor.EditorView(), new HtmlRender(root), SYNC_SCHEDULER).mount();
  const ta = root.querySelector("[data-creo-edit]") as HTMLElement;
  return { editor, ta };
}

function imageFile(name: string): File {
  return new File([new Blob(["bytes"], { type: "image/png" })], name, { type: "image/png" });
}

function transferOf(files: File[]): DataTransfer {
  const dt = new DataTransfer();
  const list: Record<number | string | symbol, unknown> = {
    length: files.length,
    [Symbol.iterator]: function* () {
      yield* files;
    },
  };
  files.forEach((f, i) => (list[i] = f));
  Object.defineProperty(dt, "files", { value: list, configurable: true });
  return dt;
}

function paste(ta: HTMLElement, files: File[]) {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: transferOf(files), configurable: true });
  ta.dispatchEvent(ev);
}

function drop(ta: HTMLElement, files: File[]) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: transferOf(files), configurable: true });
  ta.dispatchEvent(ev);
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function imageSrcs(editor: ReturnType<typeof createEditor>): string[] {
  const doc = editor.docStore.get();
  const out: string[] = [];
  for (const id of doc.order) {
    const b = doc.byId.get(id)!;
    if (b.type === "img") out.push((b as { src: string }).src);
  }
  return out;
}

/** A hand-settled upload, so a test can change editor state mid-flight. */
function deferredUpload() {
  const pending: (() => void)[] = [];
  const upload = (f: File) =>
    new Promise<string>((resolve) => pending.push(() => resolve(`cdn://${f.name}`)));
  return { upload, resolveAll: () => pending.splice(0).forEach((r) => r()) };
}

for (const [via, send] of [
  ["paste", paste],
  ["drop", drop],
] as const) {
  describe(`image ${via} inserts through dispatch`, () => {
    it("is one undo step", async () => {
      const { editor, ta } = mount();
      send(ta, [imageFile("a.png")]);
      await settle();
      expect(imageSrcs(editor)).toHaveLength(1);
      editor.undo();
      expect(imageSrcs(editor)).toHaveLength(0);
    });

    it("emits an insertBlock change", async () => {
      const { editor, ta } = mount();
      const batches: DocChange[][] = [];
      editor.onChange((c) => batches.push(c));
      send(ta, [imageFile("a.png")]);
      await settle();
      const kinds = batches.flat().map((c) => c.kind);
      expect(kinds).toContain("insertBlock");
    });

    it("is refused when the editor went read-only during the upload", async () => {
      const d = deferredUpload();
      const { editor, ta } = mount({ uploadImage: d.upload });
      send(ta, [imageFile("a.png")]);
      editor.setEditable(false);
      d.resolveAll();
      await settle();
      expect(imageSrcs(editor)).toHaveLength(0);
    });

    it("does nothing when the editor was destroyed during the upload", async () => {
      const d = deferredUpload();
      const { editor, ta } = mount({ uploadImage: d.upload });
      send(ta, [imageFile("a.png")]);
      editor.destroy();
      d.resolveAll();
      await settle();
      expect(imageSrcs(editor)).toHaveLength(0);
    });

    it("a rejected upload is reported, not unhandled, and the other files still land", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      const errors: unknown[][] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => errors.push(args);
      try {
        const { editor, ta } = mount({
          uploadImage: async (f) => {
            if (f.name === "bad.png") throw new Error("upload refused");
            return `cdn://${f.name}`;
          },
        });
        send(ta, [imageFile("bad.png"), imageFile("good.png")]);
        await settle();
        expect(unhandled).toHaveLength(0);
        expect(imageSrcs(editor)).toEqual(["cdn://good.png"]);
        expect(String(errors[0]?.[0])).toContain("creo-edit: image upload failed");
      } finally {
        console.error = origError;
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });
}
