import { expect, type Locator, type Page } from "@playwright/test";

/** Shape of the editor's `Selection`, as read across the page boundary. */
export type SelectionShape = {
  kind: "caret" | "range";
  at: { blockId: string; path: number[]; offset: number };
  anchor: { blockId: string; path: number[]; offset: number };
  focus: { blockId: string; path: number[]; offset: number };
};

/**
 * Editor handle — wraps a Page with editor-specific helpers so tests don't
 * have to know about `.creo-edit` / `[data-creo-edit]` internals.
 *
 * The editor is a CONTROLLED contentEditable: the browser owns the caret,
 * selection rendering and IME, while every `beforeinput` is intercepted and
 * translated into an editor command. So the harness drives the editor root
 * directly — there is no hidden input to focus, and no overlay to measure.
 * Caret geometry comes from `window.getSelection()`.
 */
export class EditorHarness {
  /** Set after open() — true when the page's `navigator.platform` looks Mac-ish. */
  isMacEmulated = false;

  constructor(public readonly page: Page) {}

  static async open(page: Page, query = ""): Promise<EditorHarness> {
    await page.goto(`/${query}`);
    const h = new EditorHarness(page);
    await h.editor.waitFor();
    h.isMacEmulated = await page.evaluate(() => {
      const p = navigator.platform || "";
      const ua = navigator.userAgent || "";
      return /Mac|iPhone|iPod|iPad/i.test(p) || /Mac|iPhone|iPod|iPad/i.test(ua);
    });
    await h.reset();
    return h;
  }

  get editor(): Locator {
    return this.page.locator(".creo-edit");
  }

  /**
   * Click into the editor to focus it AND place the caret at the click point
   * (mirrors a real user click). The browser owns the caret, so "focused"
   * means the contentEditable root is `document.activeElement`.
   */
  async focus(): Promise<void> {
    await this.editor.click();
    await this.expectFocused();
  }

  async expectFocused(): Promise<void> {
    await expect
      .poll(() =>
        this.page.evaluate(() =>
          document.activeElement?.hasAttribute("data-creo-edit") === true
        ),
      )
      .toBe(true);
  }

  /**
   * Focus the editor root WITHOUT disturbing the model selection.
   *
   * Order matters: focusing a contentEditable makes the browser place a
   * native caret, which fires `selectionchange` and would overwrite
   * `selStore`. So focus FIRST, then (re)assert the model selection, then
   * wait a frame for the editor's selStore → native Range sync to land.
   */
  async focusKeepingSelection(): Promise<void> {
    const sel = await this.page.evaluate(() => {
      const e = (window as unknown as {
        __editor?: { selStore: { get(): unknown } };
      }).__editor;
      return e?.selStore.get() ?? null;
    });
    await this.page.evaluate(() => {
      (document.querySelector("[data-creo-edit]") as HTMLElement).focus();
    });
    if (sel) await this.setSelection(sel);
    await this.expectFocused();
  }

  /** Write a Selection into selStore and wait for the native Range to catch up. */
  async setSelection(sel: unknown): Promise<void> {
    await this.page.evaluate((sel) => {
      const e = (window as unknown as {
        __editor?: { selStore: { set(s: unknown): void } };
      }).__editor;
      e?.selStore.set(sel);
    }, sel);
    await this.frame();
  }

  /** Focus the editor and put the caret at `offset` of block `blockId`. */
  async caretAt(blockId: string, offset: number, path?: number[]): Promise<void> {
    await this.page.evaluate(() => {
      (document.querySelector("[data-creo-edit]") as HTMLElement).focus();
    });
    await this.setSelection({
      kind: "caret",
      at: { blockId, path: path ?? [offset], offset },
    });
    await this.expectFocused();
  }

  /** Wait one animation frame — the editor syncs native selection on rAF
   *  after every doc mutation, so tests that read geometry need this. */
  async frame(): Promise<void> {
    await this.page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
  }

  /** Replace the current document with a single empty paragraph. */
  async reset(): Promise<void> {
    await this.page.evaluate(() => {
      const e = (window as unknown as {
        __editor?: {
          docStore: { set: (d: unknown) => void };
          selStore: { set: (s: unknown) => void };
        };
      }).__editor;
      if (!e) return;
      // Build a single-empty-paragraph DocState directly. Going through
      // setDocFromHTML('<p></p>') is wrong: the parser drops empty
      // structural tags by design (so they don't pollute pasted content).
      const id = `t_${Math.random().toString(36).slice(2, 9)}`;
      const block = { id, index: "U", type: "p", runs: [] };
      const byId = new Map([[id, block]]);
      e.docStore.set({ byId, order: [id] });
      e.selStore.set({ kind: "caret", at: { blockId: id, path: [0], offset: 0 } });
    });
    await this.frame();
  }

  /**
   * Replace the document with `blocks`, assigning ids `tb0`, `tb1`, … and
   * fractional indices in order, then WAIT for the renderer to catch up.
   *
   * The wait is the point. The example app runs creo's default async
   * scheduler, so writing `docStore` only queues a render — a test that
   * measured `boundingBox()` straight afterwards would sometimes get the
   * previous document's geometry and click the wrong place. Polling the
   * mounted block count is the cheapest reliable barrier.
   */
  async buildDoc(blocks: unknown[]): Promise<void> {
    await this.page.evaluate((blocks) => {
      const e = (window as {
        __editor?: {
          docStore: { set(d: unknown): void };
          selStore: { set(s: unknown): void };
        };
      }).__editor!;
      const order: string[] = [];
      const byId = new Map<string, unknown>();
      blocks.forEach((b, i) => {
        const id = `tb${i}`;
        const idx = String.fromCharCode(65 + i);
        byId.set(id, { ...(b as { type: string }), id, index: idx });
        order.push(id);
      });
      e.docStore.set({ byId, order });
      e.selStore.set({
        kind: "caret",
        at: { blockId: order[0]!, path: [0], offset: 0 },
      });
    }, blocks);
    // Every top-level block element carries data-block-kind (cells share
    // their parent's data-block-id, so this counts blocks, not cells).
    await expect
      .poll(() =>
        this.page.locator("[data-creo-edit] [data-block-kind]").count(),
      )
      .toBe(blocks.length);
    await this.frame();
  }

  /** Read the current document as serialized JSON. */
  async toJSON(): Promise<{ blocks: { type: string; runs?: { text: string; marks?: string[] }[] }[] }> {
    return await this.page.evaluate(() => {
      const e = (window as unknown as {
        __editor?: { toJSON: () => unknown };
      }).__editor;
      return e?.toJSON() as never;
    });
  }

  /** Current model selection. */
  async selection(): Promise<Record<string, never>> {
    return await this.page.evaluate(() => {
      const e = (window as unknown as {
        __editor?: { selStore: { get(): unknown } };
      }).__editor;
      return e!.selStore.get() as never;
    });
  }

  /**
   * Poll a projection of the model selection until it matches.
   *
   * Pointer input and native caret motion reach `selStore` through an async
   * `selectionchange` — the browser fires it after the event handler returns,
   * so a one-shot read straight after `mouse.click()` is a race that passes
   * or fails depending on machine load. Always assert through this.
   *
   *   await h.expectSelection((s) => s.at.blockId).toBe("tb2");
   */
  expectSelection<T>(pick: (sel: SelectionShape) => T) {
    return expect.poll(async () => {
      try {
        return pick((await this.selection()) as unknown as SelectionShape);
      } catch {
        // Projection reached into a branch the selection isn't in yet
        // (e.g. `.anchor` while it's still a caret) — keep polling.
        return undefined as unknown as T;
      }
    });
  }

  /** All paragraph DOM nodes inside the editor. */
  paragraphs(): Locator {
    return this.editor.locator("p[data-block-id]");
  }

  async mode(): Promise<string> {
    return await this.page.evaluate(
      () =>
        (window as { __editor?: { getMode(): string } }).__editor!.getMode(),
    );
  }

  async setMode(mode: "wysiwyg" | "md"): Promise<void> {
    await this.page.evaluate((mode) => {
      (window as { __editor?: { setMode(m: string): void } }).__editor!.setMode(
        mode,
      );
    }, mode);
    await this.frame();
  }

  /** Type a string. Real keystrokes → real `beforeinput` → editor commands. */
  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text);
    await this.frame();
  }

  /** Press a chord like "Meta+B" / "Control+B". `mod` is the platform mod key. */
  async chord(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.frame();
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await this.frame();
  }

  /**
   * The mod key for EDITOR chords (Cmd+B, Cmd+Alt+1, …). Mirrors the editor's
   * own `isMac()` heuristic by reading the page's navigator — Playwright's
   * "Desktop Chrome" profile emulates Windows regardless of host OS, and the
   * editor's keymap matcher reads that same emulated navigator.
   */
  get mod(): "Meta" | "Control" {
    return this.isMacEmulated ? "Meta" : "Control";
  }

  /**
   * Whether the browser process is really running on macOS.
   *
   * This is a DIFFERENT question from `isMacEmulated`, and the distinction
   * matters: word / line / doc caret motion is delegated to the browser, and
   * the browser applies the semantics of the OS it actually runs on — not of
   * the UA it is emulating. So a Chromium on macOS wearing a Windows UA
   * word-jumps with Alt+Arrow while the editor's chords still match Control.
   * Use `nav()` below rather than hardcoding either.
   */
  static get hostIsMac(): boolean {
    return process.platform === "darwin";
  }

  /**
   * Press a logical caret motion, mapped to the host OS's real key binding.
   */
  async nav(
    motion:
      | "wordLeft"
      | "wordRight"
      | "lineStart"
      | "lineEnd"
      | "docStart"
      | "docEnd",
    opts: { extend?: boolean } = {},
  ): Promise<void> {
    const mac = EditorHarness.hostIsMac;
    const keys: Record<typeof motion, string> = {
      wordLeft: mac ? "Alt+ArrowLeft" : "Control+ArrowLeft",
      wordRight: mac ? "Alt+ArrowRight" : "Control+ArrowRight",
      lineStart: mac ? "Meta+ArrowLeft" : "Home",
      lineEnd: mac ? "Meta+ArrowRight" : "End",
      docStart: mac ? "Meta+ArrowUp" : "Control+Home",
      docEnd: mac ? "Meta+ArrowDown" : "Control+End",
    };
    const key = keys[motion];
    await this.press(opts.extend ? key.replace(/^/, "Shift+") : key);
  }

  /**
   * Synthesize a `beforeinput` the way the browser would. The editor's whole
   * input pipeline hangs off this event, so it's the right seam for
   * simulating input the keyboard API can't produce (specific inputTypes,
   * IME output, autocorrect replacement).
   */
  async beforeInput(inputType: string, data?: string): Promise<void> {
    await this.page.evaluate(
      ({ inputType, data }) => {
        const root = document.querySelector("[data-creo-edit]") as HTMLElement;
        root.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType,
            data: data ?? null,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { inputType, data },
    );
    await this.frame();
  }

  /** Type `text` one `beforeinput` at a time — one command per character,
   *  matching what a real keyboard produces. */
  async inputText(text: string): Promise<void> {
    for (const c of text) await this.beforeInput("insertText", c);
  }

  /**
   * Synthesize a paste. The editor listens at DOCUMENT level (so the OS
   * right-click → Paste reaches it) and gates on the native selection being
   * inside the root, so the caller must have focused the editor first.
   */
  async pasteHTML(html: string, plain = ""): Promise<void> {
    await this.page.evaluate(
      ({ html, plain }) => {
        const root = document.querySelector("[data-creo-edit]") as HTMLElement | null;
        if (!root) throw new Error("no editor root");
        const dt = new DataTransfer();
        if (html) dt.setData("text/html", html);
        if (plain) dt.setData("text/plain", plain);
        const ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", {
          value: dt,
          configurable: true,
        });
        root.dispatchEvent(ev);
      },
      { html, plain },
    );
    await this.frame();
  }

  async pastePlain(plain: string, withShift = false): Promise<void> {
    if (withShift) {
      // The shift-tracker listens for keydown/keyup on the editor root
      // (capture phase), because ClipboardEvent doesn't carry shiftKey.
      await this.page.evaluate((plain) => {
        const root = document.querySelector("[data-creo-edit]") as HTMLElement | null;
        if (!root) throw new Error("no editor root");
        root.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Shift",
            shiftKey: true,
            bubbles: true,
          }),
        );
        const dt = new DataTransfer();
        dt.setData("text/html", "<h1>SHOULD-NOT-APPEAR</h1>");
        dt.setData("text/plain", plain);
        const ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", {
          value: dt,
          configurable: true,
        });
        root.dispatchEvent(ev);
      }, plain);
      await this.frame();
      return;
    }
    await this.pasteHTML("", plain);
  }

  /**
   * Synthesize an IME composition.
   *
   * Under contentEditable the browser is allowed to write into the DOM
   * during a composition, and the editor reconciles on `compositionend` by
   * diffing the affected scope's visible text against a pre-composition
   * snapshot. So a faithful simulation must actually mutate the DOM the way
   * an IME would — firing the events alone would diff to zero and commit
   * nothing.
   */
  async composition(commit: string): Promise<void> {
    await this.page.evaluate((commit) => {
      const root = document.querySelector("[data-creo-edit]") as HTMLElement;
      root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      // Write the committed text at the caret, exactly as the IME would.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(commit));
        range.collapse(false);
      }
      root.dispatchEvent(
        new CompositionEvent("compositionend", { data: commit, bubbles: true }),
      );
    }, commit);
    await this.frame();
  }

  /** Issue a typed editor command via the exposed handle. */
  async dispatch(cmd: unknown): Promise<void> {
    await this.page.evaluate((cmd) => {
      const e = (window as unknown as {
        __editor?: { dispatch: (c: unknown) => void };
      }).__editor;
      e?.dispatch(cmd);
    }, cmd);
    await this.frame();
  }

  async undo(): Promise<void> {
    await this.page.evaluate(() => {
      const e = (window as unknown as { __editor?: { undo: () => void } }).__editor;
      e?.undo();
    });
    await this.frame();
  }

  async redo(): Promise<void> {
    await this.page.evaluate(() => {
      const e = (window as unknown as { __editor?: { redo: () => void } }).__editor;
      e?.redo();
    });
    await this.frame();
  }

  // -------------------------------------------------------------------------
  // Native selection geometry — replaces the old `.creo-caret` /
  // `.creo-selection-rect` overlay probes. The browser renders the caret now,
  // so its position is read off the live Range.
  // -------------------------------------------------------------------------

  /** Bounding rect of the collapsed caret (or of the selected range). */
  async caretRect(): Promise<{ left: number; top: number; width: number; height: number } | null> {
    return await this.page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      // A collapsed range at a line start can report an all-zero rect in
      // WebKit; fall back to the client rect list.
      if (r.width === 0 && r.height === 0) {
        const rects = sel.getRangeAt(0).getClientRects();
        const f = rects[0];
        if (f) return { left: f.left, top: f.top, width: f.width, height: f.height };
      }
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
  }

  /** Number of visual line boxes the current selection spans. */
  async selectionRectCount(): Promise<number> {
    return await this.page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return 0;
      return sel.getRangeAt(0).getClientRects().length;
    });
  }

  /** The text the browser considers selected. */
  async nativeSelectedText(): Promise<string> {
    return await this.page.evaluate(() => window.getSelection()?.toString() ?? "");
  }
}
