import { expect, test, type Page } from "@playwright/test";
import { EditorHarness, type SelectionShape } from "./helpers";

/**
 * Coverage for the six follow-up features:
 *  1. Mouse support — drag-select, double-click word, triple-click block
 *  2. Cmd/Ctrl + Arrow — word, line edge, doc edge
 *  3. Visual-line ArrowUp/Down respects column geometry
 *  4. Mode option — regular vs mono
 *  5. Arrows inside tables (left/right within cells, up/down across rows)
 *  6. Multi-column block — render + edit + Tab navigation
 */

/**
 * Shim kept so the specs below read unchanged — the implementation (and the
 * render barrier that makes mouse-position assertions deterministic) lives on
 * the harness.
 */
async function buildDoc(page: Page, blocks: unknown[]) {
  await new EditorHarness(page).buildDoc(blocks);
}

// ---------------------------------------------------------------------------
// 1. Mouse support
// ---------------------------------------------------------------------------

test.describe("Mouse — drag select + double/triple click", () => {
  test("dragging the mouse extends the selection", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [{ type: "p", runs: [{ text: "hello world" }] }]);
    // Find the rendered span — drag from position of "h" to position of "d".
    const span = h.editor.locator("p span[data-run-index]");
    const box = await span.boundingBox();
    expect(box).not.toBeNull();
    // Press near the start, drag to near the end.
    const startX = box!.x + 4;
    const endX = box!.x + box!.width - 4;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(endX, y, { steps: 8 });
    await page.mouse.up();
    await h.expectSelection((s) => s.kind).toBe("range");
  });

  test("double-click selects the word under the pointer", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [{ type: "p", runs: [{ text: "hello world" }] }]);
    const span = h.editor.locator("p span[data-run-index]");
    const box = await span.boundingBox();
    expect(box).not.toBeNull();
    // Click somewhere inside "world" (right half of the span).
    await page.mouse.dblclick(box!.x + box!.width * 0.75, box!.y + box!.height / 2);
    await h.expectSelection((s) => s.kind).toBe("range");
    // The selected range should cover at least 4 chars (the word "world"
    // is 5; allow some hit-testing slack).
    const sel = (await h.selection()) as unknown as SelectionShape;
    expect(Math.abs(sel.focus.offset - sel.anchor.offset)).toBeGreaterThanOrEqual(4);
  });

  test("click on an empty paragraph between filled ones lands the caret AND accepts typed text", async ({
    page,
  }) => {
    // Regression for a class of "click puts cursor but typing is ignored"
    // bugs we hit while building the journal/non-editable-blocks demo.
    // Three paragraphs: filled / empty / filled. Click into the empty
    // middle paragraph and type — the typed character must land in THAT
    // paragraph, not in the previously-focused block.
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "before" }] },
      { type: "p", runs: [] },
      { type: "p", runs: [{ text: "after" }] },
    ]);
    // Move the editor's caret to the END of the doc first so the test
    // doesn't trivially pass by happening to start with the caret already
    // in the empty middle block.
    await h.dispatch({
      t: "moveCursor",
      to: { blockId: "tb2", path: ["after".length], offset: "after".length },
    });
    // Click into the middle (empty) paragraph.
    const empty = h.editor.locator('p[data-block-id="tb1"]');
    const box = await empty.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    // Wait for the click to reach the model BEFORE typing. The browser
    // delivers `selectionchange` after the click handler returns, so typing
    // immediately would race the caret move and land the character in
    // whichever block the caret was in a moment ago.
    await h.expectSelection((s) => s.at.blockId).toBe("tb1");
    // Type a single character.
    await h.type("X");
    const json = await h.toJSON();
    expect(json.blocks[0]!.runs?.[0]?.text).toBe("before");
    // The typed text MUST land in the middle (clicked) paragraph.
    expect(json.blocks[1]!.runs?.[0]?.text).toBe("X");
    // The trailing paragraph stays untouched.
    expect(json.blocks[2]!.runs?.[0]?.text).toBe("after");
  });

  test("triple-click selects the entire block", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [{ type: "p", runs: [{ text: "the quick brown fox" }] }]);
    const span = h.editor.locator("p span[data-run-index]");
    const box = await span.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    // `clickCount: 3` sets the detail counter the browser uses to recognise a
    // triple-click. Three separate `click()` calls each start a fresh count.
    await page.mouse.click(x, y, { clickCount: 3 });
    await h.expectSelection((s) => s.kind).toBe("range");
    const sel = (await h.selection()) as unknown as SelectionShape;
    expect(sel.anchor.offset).toBe(0);
    expect(sel.focus.offset).toBe("the quick brown fox".length);
  });
});

// ---------------------------------------------------------------------------
// 2. Cmd/Ctrl + Arrow chords
// ---------------------------------------------------------------------------

test.describe("Word + line + doc nav chords", () => {
  // These motions are delegated to the BROWSER (the editor deliberately
  // doesn't reimplement word boundaries or line edges), so `h.nav` maps them
  // to the host OS's real bindings — which is not the same thing as the
  // emulated navigator the editor's own chord matcher reads.
  test("word-jump skips over a word in one keypress", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await h.focus();
    await h.type("hello world stuff");
    await h.nav("lineStart");
    await h.nav("wordRight");
    const sel = (await h.selection()) as unknown as { at: { offset: number } };
    // After jumping one word from offset 0, we land at the END of "hello"
    // = offset 5.
    expect(sel.at.offset).toBe(5);
  });

  test("line-edge chord jumps to end of block", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await h.focus();
    await h.type("the whole line");
    await h.nav("lineStart");
    await h.nav("lineEnd");
    const sel = (await h.selection()) as unknown as { at: { offset: number } };
    expect(sel.at.offset).toBe("the whole line".length);
  });

  test("doc-edge chord jumps to the end of the document", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "first" }] },
      { type: "p", runs: [{ text: "second" }] },
      { type: "p", runs: [{ text: "third" }] },
    ]);
    await h.focusKeepingSelection();
    await h.nav("docEnd");
    const sel = (await h.selection()) as unknown as {
      at: { blockId: string; offset: number };
    };
    expect(sel.at.blockId).toBe("tb2");
    expect(sel.at.offset).toBe("third".length);
  });
});

// ---------------------------------------------------------------------------
// 3. Visual-line Up/Down
// ---------------------------------------------------------------------------

test.describe("Visual-line Up/Down", () => {
  test("ArrowDown across mixed-size blocks doesn't jump by character offset", async ({
    page,
  }) => {
    // h1 + paragraph: caret somewhere inside the h1, ArrowDown should land
    // at a position whose horizontal X is close to the source X — not the
    // same character offset (the heading is much larger).
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "h1", runs: [{ text: "Welcome to Creo" }] },
      { type: "p", runs: [{ text: "This is a normal paragraph below." }] },
    ]);
    // Place caret after "Welcome to" (offset 10 in the h1).
    await h.caretAt("tb0", 10);
    // The browser paints the caret, so its position comes off the live
    // Range rather than an overlay div.
    const before = await h.caretRect();
    expect(before).not.toBeNull();
    expect(before!.left).toBeGreaterThan(0);
    await h.press("ArrowDown");
    const sel = (await h.selection()) as unknown as {
      at: { blockId: string; offset: number };
    };
    const after = await h.caretRect();
    expect(sel.at.blockId).toBe("tb1");
    // Visual-line nav target should NOT be a pure character-offset copy of
    // the source — the h1 font is larger, so the same pixel column maps to
    // MORE characters in the smaller paragraph font. Plain block-jump would
    // have produced offset 10; visual-line nav should overshoot.
    expect(sel.at.offset).toBeGreaterThan(10);
    // The new caret X should be within ~40px of the goal column.
    expect(Math.abs((after?.left ?? 0) - before!.left)).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------------------
// 4. Mode (wysiwyg / md)
//
// The old cosmetic "regular | mono" flag is gone — a host that wants a
// monospaced editor adds its own CSS class. The mode now selects between the
// rich-text view and a raw markdown source view.
// ---------------------------------------------------------------------------

test.describe("Editor mode", () => {
  test("default editor is wysiwyg mode", async ({ page }) => {
    const h = await EditorHarness.open(page);
    const cls = await h.editor.evaluate((el) => el.className);
    expect(cls).toContain("creo-edit-wysiwyg");
    expect(cls).not.toContain("creo-edit-md");
    expect(await h.mode()).toBe("wysiwyg");
  });

  test("?mode=md opens the editor in markdown mode", async ({ page }) => {
    const h = await EditorHarness.open(page, "?mode=md");
    const cls = await h.editor.evaluate((el) => el.className);
    expect(cls).toContain("creo-edit-md");
    expect(cls).not.toContain("creo-edit-wysiwyg");
    expect(await h.mode()).toBe("md");
  });

  test("setMode toggles the class at runtime", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await h.setMode("md");
    await expect(h.editor).toHaveClass(/creo-edit-md/);
    await h.setMode("wysiwyg");
    await expect(h.editor).toHaveClass(/creo-edit-wysiwyg/);
  });
});

// ---------------------------------------------------------------------------
// 4b. Read-only editors — `editable: false` must hold at BOTH the
// contenteditable attribute and the command dispatcher, because dispatch()
// is public and the attribute alone wouldn't stop a plugin or the host.
// ---------------------------------------------------------------------------

test.describe("Read-only", () => {
  test("?editable=false renders contenteditable=false and refuses typing", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page, "?editable=false");
    await expect(h.editor).toHaveAttribute("contenteditable", "false");
    await buildDoc(page, [{ type: "p", runs: [{ text: "frozen" }] }]);
    await h.editor.click();
    await page.keyboard.type("XYZ");
    const json = await h.toJSON();
    expect(json.blocks[0]!.runs?.[0]?.text).toBe("frozen");
  });

  test("dispatch is refused too, and reports false", async ({ page }) => {
    const h = await EditorHarness.open(page, "?editable=false");
    await buildDoc(page, [{ type: "p", runs: [{ text: "frozen" }] }]);
    const applied = await page.evaluate(() =>
      (window as { __editor?: { dispatch(c: unknown): boolean } }).__editor!
        .dispatch({ t: "insertText", text: "X" }),
    );
    expect(applied).toBe(false);
    const json = await h.toJSON();
    expect(json.blocks[0]!.runs?.[0]?.text).toBe("frozen");
  });

  test("setEditable(true) re-enables input without recreating the editor", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page, "?editable=false");
    await buildDoc(page, [{ type: "p", runs: [{ text: "" }] }]);
    await page.evaluate(() =>
      (window as { __editor?: { setEditable(v: boolean): void } }).__editor!
        .setEditable(true),
    );
    await expect(h.editor).toHaveAttribute("contenteditable", "true");
    await h.caretAt("tb0", 0);
    await h.type("now editable");
    const json = await h.toJSON();
    expect(json.blocks[0]!.runs?.[0]?.text).toBe("now editable");
  });
});

// ---------------------------------------------------------------------------
// 5. Arrows in tables
// ---------------------------------------------------------------------------

test.describe("Tables — arrow navigation", () => {
  test("ArrowDown navigates from row 0 to row 1 in the same column", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      {
        type: "table",
        rows: 2,
        cols: 3,
        cells: [
          [[{ text: "a" }], [{ text: "b" }], [{ text: "c" }]],
          [[{ text: "d" }], [{ text: "e" }], [{ text: "f" }]],
        ],
      },
    ]);
    await h.caretAt("tb0", 0, [0, 1, 0]);
    await h.press("ArrowDown");
    const sel = (await h.selection()) as unknown as SelectionShape;
    const at = sel.at;
    expect(at.path[0]).toBe(1);
    expect(at.path[1]).toBe(1);
  });

  test("ArrowRight at end of a cell jumps into the next cell", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      {
        type: "table",
        rows: 1,
        cols: 2,
        cells: [[[{ text: "abc" }], [{ text: "xyz" }]]],
      },
    ]);
    await h.caretAt("tb0", 3, [0, 0, 3]);
    await h.press("ArrowRight");
    const sel = (await h.selection()) as unknown as SelectionShape;
    const at = sel.at;
    expect(at.path).toEqual([0, 1, 0]);
  });

  test("ArrowUp from row 0 exits the table", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "before" }] },
      {
        type: "table",
        rows: 1,
        cols: 2,
        cells: [[[{ text: "a" }], [{ text: "b" }]]],
      },
    ]);
    await h.caretAt("tb1", 0, [0, 0, 0]);
    await h.press("ArrowUp");
    const sel = (await h.selection()) as unknown as SelectionShape;
    const at = sel.at;
    expect(at.blockId).toBe("tb0");
  });
});

// ---------------------------------------------------------------------------
// 6. Multi-column block
// ---------------------------------------------------------------------------

test.describe("Multi-column block", () => {
  test("insertColumns command renders an N-column grid", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await h.focusKeepingSelection();
    await h.dispatch({ t: "insertColumns", cols: 3 });
    const cols = h.editor.locator(".ce-columns .ce-col[data-col]");
    await expect(cols).toHaveCount(3);
  });

  test("typing in column 0 doesn't bleed into other columns", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "columns", cols: 2, cells: [[], []] },
    ]);
    await h.caretAt("tb0", 0, [0, 0]);
    await h.type("LEFT");
    const json = (await page.evaluate(() =>
      (window as { __editor?: { toJSON(): unknown } } ).__editor!.toJSON(),
    )) as { blocks: { type: string; cells?: { text: string }[][] }[] };
    const block = json.blocks[0]!;
    expect(block.type).toBe("columns");
    expect(block.cells![0]![0]!.text).toBe("LEFT");
    expect(block.cells![1]!.length).toBe(0);
  });

  test("ArrowRight at end of col 0 jumps to col 1", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "columns", cols: 2, cells: [[{ text: "abc" }], [{ text: "xyz" }]] },
    ]);
    await h.caretAt("tb0", 3, [0, 3]);
    await h.press("ArrowRight");
    const sel = (await h.selection()) as unknown as SelectionShape;
    const at = sel.at;
    expect(at.path).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// Click past end of line — standard editor UX. caretFromPoint returns
// nothing when the pointer isn't over a text node, so without the
// fallback in pointToAnchor a click in the right margin of a line would
// silently do nothing.
// ---------------------------------------------------------------------------

test.describe("Click past end of line", () => {
  test("clicking far right of a heading places caret at end of heading", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "h2", runs: [{ text: "Try these" }] },
      { type: "p", runs: [{ text: "more stuff" }] },
    ]);
    const heading = h.editor.locator("h2[data-block-id]");
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    // Click 200px past the rendered end of the heading text but inside
    // the editor's horizontal extent.
    const editorBox = await h.editor.boundingBox();
    expect(editorBox).not.toBeNull();
    const x = Math.min(editorBox!.x + editorBox!.width - 4, box!.x + box!.width + 200);
    const y = box!.y + box!.height / 2;
    await page.mouse.click(x, y);
    await h.expectSelection((s) => s.at.blockId).toBe("tb0");
    await h.expectSelection((s) => s.at.offset).toBe("Try these".length);
  });

  test("clicking below all content lands caret at end of last block", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "h1", runs: [{ text: "Top" }] },
      { type: "p", runs: [{ text: "middle" }] },
      { type: "p", runs: [{ text: "tail content" }] },
    ]);
    const editorBox = await h.editor.boundingBox();
    expect(editorBox).not.toBeNull();
    // Click in the bottom padding zone (below the last block but inside
    // the editor's bounding box).
    const x = editorBox!.x + 60;
    const y = editorBox!.y + editorBox!.height - 8;
    await page.mouse.click(x, y);
    await h.expectSelection((s) => s.at.blockId).toBe("tb2");
    await h.expectSelection((s) => s.at.offset).toBe("tail content".length);
  });

  test("clicking far left of a paragraph lands caret at start of line", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "narrow line" }] },
    ]);
    const para = h.editor.locator("p[data-block-id]");
    const box = await para.boundingBox();
    expect(box).not.toBeNull();
    // Click way to the left of the paragraph but on its line.
    await page.mouse.click(Math.max(0, box!.x - 80), box!.y + box!.height / 2);
    await h.expectSelection((s) => s.at.blockId).toBe("tb0");
    await h.expectSelection((s) => s.at.offset).toBe(0);
  });

  test("clicking far right of a MIDDLE row lands caret at end of that row", async ({
    page,
  }) => {
    // Clicking past end-of-line has to resolve to end-of-THAT-row, not to
    // the start of it and not to a neighbouring block. First/last rows can
    // pass by accident (there's only one direction to snap), so this pins
    // the middle row specifically.
    //
    // Note the click y is inside the row's own box. The browser owns
    // hit-testing now, and a point in the GAP between two blocks is
    // legitimately ambiguous — asserting a specific winner there would be
    // testing Chromium's tie-breaking, not the editor.
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "first row" }] },
      { type: "h2", runs: [{ text: "second row title" }] },
      { type: "p", runs: [{ text: "third row" }] },
    ]);
    const editorBox = await h.editor.boundingBox();
    expect(editorBox).not.toBeNull();
    const h2 = h.editor.locator("h2[data-block-id]");
    const box = await h2.boundingBox();
    expect(box).not.toBeNull();
    const x = editorBox!.x + editorBox!.width - 6;
    const y = box!.y + box!.height / 2;
    await page.mouse.click(x, y);
    await h.expectSelection((s) => s.at.blockId).toBe("tb1");
    await h.expectSelection((s) => s.at.offset).toBe("second row title".length);
  });

  test("clicking on the list bullet lands caret at start of li (not end)", async ({
    page,
  }) => {
    // Regression: caretFromPoint hits the <li> element (not a text node)
    // when the user clicks on the CSS `::marker` bullet. The previous
    // offsetWithinBlock walked all text and returned the FULL length,
    // planting the caret at end-of-line instead of start-of-line.
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "li", ordered: false, depth: 0, runs: [{ text: "bullet item" }] },
    ]);
    const li = h.editor.locator("li[data-block-id]");
    const box = await li.boundingBox();
    expect(box).not.toBeNull();
    // Click 12px to the left of the li's text — that's where the bullet
    // dot sits, inside the <ul>'s padding.
    await page.mouse.click(box!.x - 12, box!.y + box!.height / 2);
    await h.expectSelection((s) => s.at.blockId).toBe("tb0");
    await h.expectSelection((s) => s.at.offset).toBe(0);
  });
});

test.describe("Range replace on type", () => {
  test("typing a character with a cross-block range replaces the range", async ({
    page,
  }) => {
    // Regression: insertText returned false for cross-block ranges,
    // silently dropping keystrokes. Backspace worked because the input
    // pipeline chained through mergeBackward; insertText didn't.
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "one" }] },
      { type: "p", runs: [{ text: "two" }] },
      { type: "p", runs: [{ text: "three" }] },
    ]);
    // Range covering "ne" of first p, all of second p, and "th" of third p.
    await h.setSelection({
      kind: "range",
      anchor: { blockId: "tb0", path: [1], offset: 1 },
      focus: { blockId: "tb2", path: [2], offset: 2 },
    });
    await h.focusKeepingSelection();
    await h.beforeInput("insertText", "X");
    const state = await page.evaluate(() => {
      const e = (window as { __editor?: { docStore: { get(): { order: string[]; byId: Map<string, { runs: { text: string }[] }> } }; selStore: { get(): unknown } } }).__editor!;
      const doc = e.docStore.get();
      return {
        order: doc.order,
        text: doc.order.map(id => doc.byId.get(id)!.runs.map(r => r.text).join("")),
        sel: e.selStore.get(),
      };
    });
    // The three blocks collapsed into one whose text is the head + X + tail.
    expect(state.order).toHaveLength(1);
    expect(state.text[0]).toBe("oXree");
    const at = (state.sel as { at: { offset: number } }).at;
    expect(at.offset).toBe(2);
  });
});

test.describe("Caret in nested cells (table / columns)", () => {
  test("caret lands in the actual table cell after typing into it", async ({
    page,
  }) => {
    // Regression: the caret used to be measured against the OUTER block
    // element (the <table>) at offset 0, so it stayed glued to cell [0][0]
    // no matter where the user actually typed. The anchor codec now drills
    // into the matching <td data-cell="r:c">.
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      {
        type: "table",
        rows: 2,
        cols: 3,
        cells: [
          [[], [], []],
          [[], [], []],
        ],
      },
    ]);
    await h.caretAt("tb0", 0, [0, 2, 0]);
    await h.inputText("abc");
    // The text landed in cell [0][2]…
    const cellText = await page
      .locator('td[data-cell="0:2"]')
      .textContent();
    expect(cellText).toContain("abc");
    // …and the browser's caret is inside that cell's box, not cell [0][0]'s.
    const caret = await h.caretRect();
    expect(caret).not.toBeNull();
    const td = (await page.locator('td[data-cell="0:2"]').boundingBox())!;
    expect(caret!.left).toBeGreaterThanOrEqual(td.x - 2);
    expect(caret!.left).toBeLessThanOrEqual(td.x + td.width + 2);
  });

  test("caret lands in the actual columns cell after typing into it", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "columns", cols: 3, cells: [[], [], []] },
    ]);
    await h.caretAt("tb0", 0, [2, 0]);
    await h.inputText("RIGHT");
    const colText = await page.locator('[data-col="2"]').textContent();
    expect(colText).toContain("RIGHT");
    const caret = await h.caretRect();
    expect(caret).not.toBeNull();
    const col = (await page.locator('[data-col="2"]').boundingBox())!;
    expect(caret!.left).toBeGreaterThanOrEqual(col.x - 2);
    expect(caret!.left).toBeLessThanOrEqual(col.x + col.width + 2);
  });
});

test.describe("Trailing whitespace", () => {
  test("typing space at end of line advances the visible caret", async ({
    page,
  }) => {
    // Regression: the default `white-space: normal` collapsed trailing
    // whitespace, so `Range.getBoundingClientRect()` returned the same
    // x-position regardless of how many spaces sat at end-of-line. The
    // model offset advanced; the visual caret didn't. Editor felt frozen
    // when the user pressed space at end of a row.
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "p", runs: [{ text: "hello" }] },
    ]);
    // Caret at end of "hello".
    await h.caretAt("tb0", 5);
    const before = await h.caretRect();
    expect(before).not.toBeNull();
    expect(before!.left).toBeGreaterThan(0);
    await h.inputText("   ");
    const after = await h.caretRect();
    // Caret must have visibly advanced.
    expect(after!.left).toBeGreaterThan(before!.left + 4);
    // Model has all 8 chars.
    const len = await page.evaluate(() => {
      const e = (window as { __editor?: { docStore: { get(): { byId: Map<string, { runs: { text: string }[] }> } } } }).__editor!;
      const b = e.docStore.get().byId.get("tb0")!;
      return b.runs.reduce((n, r) => n + r.text.length, 0);
    });
    expect(len).toBe(8);
    // CSS sanity-check: editor descendants inherit pre-wrap.
    const ws = await h.editor.locator("p[data-block-id]").evaluate((el) =>
      getComputedStyle(el).whiteSpace,
    );
    expect(ws).toBe("pre-wrap");
  });
});

test.describe("Cursor styling", () => {
  test("editor root shows the I-beam (cursor: text)", async ({ page }) => {
    const h = await EditorHarness.open(page);
    const cur = await h.editor.evaluate((el) => getComputedStyle(el).cursor);
    expect(cur).toBe("text");
  });

  test("image blocks override to default cursor (not I-beam)", async ({
    page,
  }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "img", src: "https://example.com/x.png" },
    ]);
    const cur = await h.editor
      .locator("div.ce-img")
      .evaluate((el) => getComputedStyle(el).cursor);
    expect(cur).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Regression: pressing Enter twice between a heading and a list visually
// duplicated everything below the heading. Repro from a real session: caret
// at end of an h2, two splitBlock dispatches in a row. The doc model was
// always correct (two empty paragraphs inserted in the right place); the
// rendered DOM was wrong because the engine's reconcileKeyed Phase 3
// dropped the tail-synced views from view.children, so the new paragraphs
// got appended to the parent instead of inserted before the list.
// ---------------------------------------------------------------------------

test.describe("Regression: Enter-Enter at end of heading", () => {
  test("DOM order matches model after two splits", async ({ page }) => {
    const h = await EditorHarness.open(page);
    await buildDoc(page, [
      { type: "h1", runs: [{ text: "Title" }] },
      { type: "p", runs: [{ text: "intro" }] },
      { type: "h2", runs: [{ text: "Try these" }] },
      { type: "li", ordered: false, depth: 0, runs: [{ text: "alpha" }] },
      { type: "li", ordered: false, depth: 0, runs: [{ text: "beta" }] },
      { type: "li", ordered: false, depth: 0, runs: [{ text: "gamma" }] },
      { type: "p", runs: [{ text: "tail" }] },
    ]);
    // Place caret at end of the h2 (block tb2, offset = "Try these".length).
    await h.caretAt("tb2", 9, [9]);
    // Enter twice — same as user pressing Return twice.
    await h.dispatch({ t: "splitBlock" });
    await h.dispatch({ t: "splitBlock" });
    // Read the rendered block IDs in DOM order.
    const domOrder = await page.evaluate(() => {
      const editor = document.querySelector(".creo-edit")!;
      const out: string[] = [];
      const walk = (node: Element) => {
        const id = node.getAttribute("data-block-id");
        // Only record top-level block elements (skip overlays / textareas /
        // span run-children inside a block).
        if (id && /\bce-block\b/.test(node.className)) out.push(id);
        for (const child of Array.from(node.children)) walk(child);
      };
      walk(editor);
      return out;
    });
    // Read the model order for comparison.
    const modelOrder = await page.evaluate(() => {
      const e = (window as { __editor?: { docStore: { get(): { order: string[] } } } }).__editor!;
      return e.docStore.get().order;
    });
    // The two new paragraphs MUST be inserted between the h2 and the first
    // list item — same as the model.
    expect(domOrder).toEqual(modelOrder);
    // Sanity: the heading still occurs exactly once (no section duplicate).
    const headings = await page.locator(".creo-edit h2[data-block-id]").count();
    expect(headings).toBe(1);
  });
});
