import { expect, test, type Page } from "@playwright/test";

/**
 * The rail plugin in a real browser, where it can measure: which tick is lit
 * as the document scrolls, where a jump leaves the block, where the rail sits.
 *
 * `?doc=outline&rail=1` opens a long document with a tick per heading (an h1
 * and twelve h2s); `&scroller=1` puts it in a box of its own that scrolls.
 */

const ticks = (page: Page) => page.locator(".creo-rail__tick");
const lit = (page: Page): Promise<string | null> =>
  page.locator(".creo-rail__tick.is-active").getAttribute("aria-label");
const topOf = (page: Page, text: string): Promise<number> =>
  page.locator("[data-block-id]", { hasText: new RegExp(`^${text}$`) }).evaluate((el) => el.getBoundingClientRect().top);

for (const where of ["page", "scroller"] as const) {
  test.describe(`the rail, scrolling the ${where}`, () => {
    const url = `/?doc=outline&rail=1${where === "scroller" ? "&scroller=1" : ""}`;
    const scrollTop = (page: Page): Promise<number> =>
      page.evaluate((inBox) => (inBox ? document.querySelector(".scroller")!.scrollTop : window.scrollY), where === "scroller");

    test("a tick per heading, the first lit at the top", async ({ page }) => {
      await page.goto(url);
      await expect(ticks(page)).toHaveCount(13);
      expect(await lit(page)).toBe("Outline");
    });

    test("a click puts the heading just below the top and lights its tick", async ({ page }) => {
      await page.goto(url);
      await ticks(page).nth(6).click();
      await expect.poll(() => lit(page)).toBe("Section 6");
      await expect
        .poll(async () => {
          const top = await topOf(page, "Section 6");
          const view = where === "scroller"
            ? await page.locator(".scroller").evaluate((el) => el.getBoundingClientRect().top)
            : 0;
          return Math.round(top - view);
        })
        .toBe(16);
      expect(await scrollTop(page)).toBeGreaterThan(0);
    });

    test("scrolling by hand moves the light, and the end lights the last", async ({ page }) => {
      await page.goto(url);
      await page.evaluate((inBox) => {
        const target = document.querySelector<HTMLElement>("[data-block-id]:nth-child(1)")!;
        void target;
        const heading = Array.from(document.querySelectorAll("[data-block-id]")).find((el) => el.textContent === "Section 3")!;
        const box = inBox ? document.querySelector(".scroller")! : document.scrollingElement!;
        box.scrollTop += heading.getBoundingClientRect().top - (inBox ? box.getBoundingClientRect().top : 0) - 10;
      }, where === "scroller");
      await expect.poll(() => lit(page)).toBe("Section 3");

      await page.evaluate((inBox) => {
        const box = inBox ? document.querySelector(".scroller")! : document.scrollingElement!;
        box.scrollTop = box.scrollHeight;
      }, where === "scroller");
      await expect.poll(() => lit(page)).toBe("Section 12");
    });

    test("hovering a tick shows the heading and the first line under it, beside the rail", async ({ page }) => {
      await page.goto(url);
      await ticks(page).nth(2).hover();
      const card = page.locator(".creo-rail__card");
      await expect(card).toBeVisible();
      await expect(card.locator(".creo-rail__label")).toHaveText("Section 2");
      await expect(card.locator(".creo-rail__detail")).toHaveText(/^Section 2, paragraph 1\./);
      const rail = await page.locator(".creo-rail__ticks").boundingBox();
      const box = await card.boundingBox();
      expect(box!.x).toBeGreaterThan(rail!.x + rail!.width - 1);
    });
  });
}

test("the rail stays put over a box that scrolls, at its left edge", async ({ page }) => {
  await page.goto("/?doc=outline&rail=1&scroller=1");
  const box = await page.locator(".scroller").boundingBox();
  const before = await page.locator(".creo-rail__ticks").boundingBox();
  expect(before!.x).toBeGreaterThanOrEqual(box!.x);
  expect(before!.x).toBeLessThan(box!.x + 12);
  expect(before!.y).toBeGreaterThan(box!.y);
  expect(before!.y + before!.height).toBeLessThan(box!.y + box!.height);
  await page.locator(".scroller").evaluate((el) => (el.scrollTop = 1500));
  const after = await page.locator(".creo-rail__ticks").boundingBox();
  expect(after).toEqual(before);
});

test("a press on a tick leaves the caret in the document", async ({ page }) => {
  await page.goto("/?doc=outline&rail=1");
  await page.locator("[data-block-id]", { hasText: /^Section 1, paragraph 2\./ }).click();
  await ticks(page).nth(4).click();
  const focusInEditor = await page.evaluate(() => document.activeElement?.closest("[data-creo-edit]") !== null);
  expect(focusInEditor).toBe(true);
});
