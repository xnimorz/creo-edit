import { expect, test } from "@playwright/test";
import { EditorHarness } from "./helpers";

/**
 * Mobile-emulation suite.
 *
 * Playwright device profiles (iPhone 13, Pixel 7) set viewport size,
 * device-pixel-ratio, touch + coarse pointer, and a mobile UA. They do NOT
 * spin up an actual virtual keyboard, so soft-keyboard behaviour is tested
 * structurally rather than visually.
 *
 * IMPORTANT — what this suite deliberately does NOT test any more. The editor
 * used to ship a hidden `<textarea>`, a `.creo-caret` overlay, `.creo-handle`
 * drag handles and a `.creo-mobile-toolbar`. All four are gone: the editor is
 * a controlled contentEditable, so native selection handles, the OS
 * long-press menu, IME and autocorrect are delivered by the BROWSER. Tests
 * that asserted our replacements would now be testing code that shouldn't
 * exist. What's left is the part the editor still owns — coarse-pointer
 * detection, visual-viewport tracking, and the input pipeline behaving the
 * same under touch as under a mouse.
 */

test.describe("Mobile — contentEditable setup", () => {
  test("the editor root is the editable surface (no hidden input)", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await expect(h.editor).toHaveAttribute("contenteditable", "true");
    // The old architecture's hidden textarea must not come back — a stray one
    // would silently steal focus and swallow the keyboard.
    await expect(page.locator("textarea[data-creo-input]")).toHaveCount(0);
  });

  test("spellcheck is disabled on the editable root", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await expect(h.editor).toHaveAttribute("spellcheck", "false");
  });

  test("no editor-drawn selection UI is mounted", async ({ page }) => {
    // Selection handles and the long-press menu are the browser's job now.
    // This asserts the deliberate absence, so re-introducing an overlay is a
    // conscious decision rather than an accident.
    const h = await EditorHarness.open(page);
    await h.buildDoc([{ type: "p", runs: [{ text: "hello" }] }]);
    await h.setSelection({
      kind: "range",
      anchor: { blockId: "tb0", path: [0], offset: 0 },
      focus: { blockId: "tb0", path: [4], offset: 4 },
    });
    await expect(page.locator(".creo-handle")).toHaveCount(0);
    await expect(page.locator(".creo-mobile-toolbar")).toHaveCount(0);
    await expect(page.locator(".creo-caret")).toHaveCount(0);
    // …and the browser is representing the range itself.
    expect(await h.nativeSelectedText()).toBe("hell");
  });

  test("the device really is a coarse pointer", async ({ page }) => {
    // Guards the emulation itself: if this were false, every assertion below
    // would be silently testing the desktop path.
    await EditorHarness.open(page);
    const coarse = await page.evaluate(
      () => window.matchMedia("(pointer: coarse)").matches,
    );
    expect(coarse).toBe(true);
  });
});

test.describe("Mobile — tap to focus and type", () => {
  test("tapping the editor focuses it and typed text lands", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await h.editor.tap();
    await h.expectFocused();
    // Playwright's tap doesn't raise a soft keyboard in headless emulation,
    // so drive the same `beforeinput` the keyboard would produce.
    await h.inputText("hi");
    await expect(h.paragraphs()).toContainText("hi");
  });

  test("tapping into a specific block puts the caret in that block", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await h.buildDoc([
      { type: "p", runs: [{ text: "first" }] },
      { type: "p", runs: [{ text: "second" }] },
    ]);
    await h.editor.locator('p[data-block-id="tb1"]').tap();
    await h.expectSelection((s) => s.at.blockId).toBe("tb1");
  });
});

test.describe("Mobile — composition (Gboard / QuickType)", () => {
  test("a swiped word commits as a single insertion", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await h.editor.tap();
    await h.expectFocused();
    await h.composition("hello");
    await expect(h.paragraphs()).toContainText("hello");
    const json = await h.toJSON();
    const len = json.blocks
      .filter((b) => b.type === "p")
      .flatMap((b) => b.runs ?? [])
      .reduce((n, r) => n + r.text.length, 0);
    expect(len).toBe(5);
  });
});

test.describe("Mobile — visual viewport tracking", () => {
  test("editor root exposes --creo-vv-height and --creo-vv-top", async ({
    page,
  }) => {
    // These custom properties are the editor's contract with host pages for
    // positioning floating UI above the soft keyboard.
    const h = await EditorHarness.open(page);
    const vars = await h.editor.evaluate((el) => ({
      height: (el as HTMLElement).style.getPropertyValue("--creo-vv-height"),
      top: (el as HTMLElement).style.getPropertyValue("--creo-vv-top"),
      hasApi: typeof window.visualViewport !== "undefined",
    }));
    // Mobile emulation always provides visualViewport; if a profile ever
    // stops doing so, the editor no-ops rather than throwing.
    if (!vars.hasApi) test.skip();
    expect(vars.height).toMatch(/^\d+(\.\d+)?px$/);
    expect(vars.top).toMatch(/^\d+(\.\d+)?px$/);
  });

  test("--creo-vv-height tracks the visual viewport height", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    const reported = await h.editor.evaluate((el) =>
      parseFloat(
        (el as HTMLElement).style.getPropertyValue("--creo-vv-height") || "0",
      ),
    );
    const actual = await page.evaluate(
      () => window.visualViewport?.height ?? 0,
    );
    expect(Math.abs(reported - actual)).toBeLessThan(1);
  });
});

test.describe("Mobile — editing still works under touch", () => {
  test("Enter splits and Backspace merges", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await h.editor.tap();
    await h.expectFocused();
    await h.inputText("ab");
    await h.beforeInput("insertParagraph");
    await expect(h.paragraphs()).toHaveCount(2);
    await h.beforeInput("deleteContentBackward");
    await expect(h.paragraphs()).toHaveCount(1);
    await expect(h.paragraphs().first()).toHaveText("ab");
  });

  test("autocorrect-style replacement rewrites the target range", async ({
    page,
  }) => {
    // iOS sends `insertReplacementText` with target ranges rather than a
    // plain insert. Without a caret in the block there'd be nothing to
    // replace, so seed one first.
    const h = await EditorHarness.open(page);
    await h.buildDoc([{ type: "p", runs: [{ text: "teh" }] }]);
    await h.caretAt("tb0", 3);
    await h.beforeInput("insertReplacementText", "the");
    await expect(h.paragraphs().first()).toContainText("the");
  });
});
