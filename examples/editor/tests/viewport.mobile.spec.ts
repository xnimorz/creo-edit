import { expect, test, type Page } from "@playwright/test";

/**
 * Caret-above-keyboard scrolling (`input/mobile.ts`), against `viewport.html`:
 * a 600px scroller with eight clipped read-only tiles (`?mode=home`) or one
 * 80-paragraph editor whose paragraph 40 is ~1300px tall (`?mode=doc`).
 *
 * `setViewportSize` stands in for the keyboard opening; a synthetic
 * `visualViewport` scroll event stands in for an iOS pan.
 */

const WIDTH = 390;
const TALL = 700;
const SHORT = 400;

async function open(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: TALL });
  await page.goto(`/viewport.html?${query}`);
  await page.locator("[data-creo-edit]").first().waitFor();
  await frames(page);
}

/** Two animation frames: selection sync, then the reveal. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
}

async function scrollTo(page: Page, top: number): Promise<number> {
  const got = await page.evaluate((top) => {
    const sc = document.getElementById("scroller")!;
    sc.scrollTop = top;
    return sc.scrollTop;
  }, top);
  await frames(page);
  return got;
}

const scrollTop = (page: Page) =>
  page.evaluate(() => document.getElementById("scroller")!.scrollTop);

async function panViewport(page: Page): Promise<void> {
  await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("scroll")));
  await frames(page);
}

async function openKeyboard(page: Page): Promise<void> {
  await page.setViewportSize({ width: WIDTH, height: SHORT });
  await frames(page);
}

/** Focus the (single) editor and put the caret at `offset` of block `n`. */
async function caretIn(page: Page, n: number, offset = 0): Promise<void> {
  await page.evaluate(
    ({ n, offset }) => {
      const e = (window as unknown as {
        __editors: {
          docStore: { get(): { order: string[] } };
          selStore: { set(s: unknown): void };
        }[];
      }).__editors[0];
      (document.querySelector("[data-creo-edit]") as HTMLElement).focus();
      const blockId = e.docStore.get().order[n];
      e.selStore.set({ kind: "caret", at: { blockId, path: [offset], offset } });
    },
    { n, offset },
  );
  await frames(page);
}

/** The native caret's rect, in client coordinates. */
const caretRect = (page: Page) =>
  page.evaluate(() => {
    const r = window.getSelection()!.getRangeAt(0).getClientRects()[0];
    return { top: r.top, bottom: r.bottom };
  });

test.beforeEach(async ({ page }) => {
  // Instant scrolling, so tests don't wait on an animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.describe("visualViewport — no unrequested scrolling", () => {
  test("home: a viewport pan with nothing focused leaves the list alone", async ({ page }) => {
    await open(page, "mode=home");
    expect(await scrollTo(page, 700)).toBe(700);
    await panViewport(page);
    expect(await scrollTop(page)).toBe(700);
  });

  test("home: the keyboard opening for another field leaves the list alone", async ({ page }) => {
    await open(page, "mode=home");
    await page.locator("#field").focus();
    expect(await scrollTo(page, 700)).toBe(700);
    await openKeyboard(page);
    expect(await scrollTop(page)).toBe(700);
  });

  test("doc: a viewport pan does not undo the user's scroll", async ({ page }) => {
    await open(page, "mode=doc");
    await caretIn(page, 0);
    expect(await scrollTo(page, 1200)).toBe(1200);
    await panViewport(page);
    expect(await scrollTop(page)).toBe(1200);
  });

  test("doc: a blurred editor's stale caret does not pull the page back", async ({ page }) => {
    await open(page, "mode=doc");
    await caretIn(page, 0);
    await page.locator("#field").focus();
    expect(await scrollTo(page, 1200)).toBe(1200);
    await openKeyboard(page);
    expect(await scrollTop(page)).toBe(1200);
  });

  test("doc: scrolling through a block taller than the screen is not pulled back", async ({ page }) => {
    await open(page, "mode=doc");
    await caretIn(page, 40);
    for (const top of [1326, 1626, 1926]) {
      const at = await scrollTo(page, top);
      await panViewport(page);
      expect(await scrollTop(page)).toBe(at);
    }
  });

  test("mounting does not scroll to the default caret at the end", async ({ page }) => {
    await open(page, "mode=doc");
    expect(await scrollTop(page)).toBe(0);
  });
});

test.describe("visualViewport — keeps the focused caret above the keyboard", () => {
  test("a caret the keyboard covers is scrolled up just far enough", async ({ page }) => {
    await open(page, "mode=doc");
    // A paragraph visible now but covered once the viewport is 400px.
    const n = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll("[data-block-kind]")];
      return blocks.findIndex((b) => b.getBoundingClientRect().top > 480);
    });
    await caretIn(page, n);
    const before = await caretRect(page);
    expect(before.top).toBeGreaterThan(SHORT);
    await openKeyboard(page);
    const after = await caretRect(page);
    expect(after.bottom).toBeLessThanOrEqual(SHORT);
    // Minimal scroll: the caret stays near the bottom, not the upper third.
    expect(after.top).toBeGreaterThan(SHORT / 2);
  });

  test("a caret deep inside a tall block is revealed, not the block's top", async ({ page }) => {
    await open(page, "mode=doc");
    // Mid-block.
    await caretIn(page, 40, 2000);
    await page.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getClientRects()[0];
      const sc = document.getElementById("scroller")!;
      // Caret at y ≈ 500: visible now, covered after the shrink.
      sc.scrollTop += r.top - 500;
    });
    await frames(page);
    const before = await caretRect(page);
    expect(before.top).toBeGreaterThan(SHORT);
    await openKeyboard(page);
    const after = await caretRect(page);
    expect(after.top).toBeGreaterThanOrEqual(0);
    expect(after.bottom).toBeLessThanOrEqual(SHORT);
  });

  test("without reduced motion the reveal animates to the same place", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await open(page, "mode=doc");
    const n = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll("[data-block-kind]")];
      return blocks.findIndex((b) => b.getBoundingClientRect().top > 480);
    });
    await caretIn(page, n);
    await openKeyboard(page);
    await expect.poll(async () => (await caretRect(page)).bottom).toBeLessThanOrEqual(SHORT);
    expect((await caretRect(page)).top).toBeGreaterThan(SHORT / 2);
  });

  test("a caret already above the keyboard is left where it is", async ({ page }) => {
    await open(page, "mode=doc");
    await caretIn(page, 2);
    const before = await scrollTop(page);
    await openKeyboard(page);
    expect(await scrollTop(page)).toBe(before);
  });

  test("a keyboard animating in over several resizes still lands the caret", async ({ page }) => {
    // Android resizes in steps while the keyboard animates.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await open(page, "mode=doc");
    const n = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll("[data-block-kind]")];
      return blocks.findIndex((b) => b.getBoundingClientRect().top > 560);
    });
    await caretIn(page, n);
    for (const height of [640, 560, 480, SHORT]) {
      await page.setViewportSize({ width: WIDTH, height });
    }
    await expect.poll(async () => (await caretRect(page)).bottom).toBeLessThanOrEqual(SHORT);
  });

  test("a caret the user scrolled away from stays put when the keyboard grows", async ({ page }) => {
    // E.g. the QuickType bar appearing after the user scrolled away.
    await open(page, "mode=doc");
    await caretIn(page, 0);
    expect(await scrollTo(page, 1200)).toBe(1200);
    await openKeyboard(page);
    expect(await scrollTop(page)).toBe(1200);
  });

  test("the keyboard closing never scrolls", async ({ page }) => {
    await page.setViewportSize({ width: WIDTH, height: SHORT });
    await page.goto("/viewport.html?mode=doc");
    await page.locator("[data-creo-edit]").waitFor();
    await caretIn(page, 0);
    expect(await scrollTo(page, 1200)).toBe(1200);
    await page.setViewportSize({ width: WIDTH, height: TALL });
    await frames(page);
    expect(await scrollTop(page)).toBe(1200);
  });

  test("keepCaretVisible: false opts out", async ({ page }) => {
    await open(page, "mode=doc&keep=0");
    const n = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll("[data-block-kind]")];
      return blocks.findIndex((b) => b.getBoundingClientRect().top > 480);
    });
    await caretIn(page, n);
    await openKeyboard(page);
    expect(await scrollTop(page)).toBe(0);
  });
});
