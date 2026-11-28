import { expect, test, type Page } from "@playwright/test";

/**
 * The mermaid block in a real browser: real layout, real focus, real Pele.
 *
 * What only a browser can show: that a field inside the block keeps its
 * typing, that the editor does not pull the focus back out of it after a
 * visual edit, that a drag from a connect dot lands on the node under the
 * pointer, and that `Mod+Z` on the canvas reaches the editor's history.
 *
 * `?doc=diagram` opens the example on a document holding one flowchart:
 *   A[Start] --> B{Works?};  B -->|Yes| C[Ship it];  B -->|No| D[Fix it];  D --> B
 */

const open = async (page: Page, extra = ""): Promise<void> => {
  await page.goto(`/?doc=diagram${extra}`);
  await page.locator(".ce-mermaid-canvas > svg").waitFor();
};
const ready = (page: Page) => page.locator(".ce-mermaid[data-interactive]").waitFor();
const source = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const root = document.querySelector("[data-creo-edit]") as unknown as {
      __creoEdit: { toJSON(): { blocks: { type: string; source?: string }[] } };
    };
    return root.__creoEdit.toJSON().blocks.find((b) => b.type === "mermaid")?.source ?? "";
  });
const node = (page: Page, id: string) =>
  page.locator(`.ce-mermaid [data-ce-entity="node:${id}"]`).first();
const label = (page: Page) => page.locator(".ce-mmd-input");

/**
 * The mod key for the EDITOR's chords. The editor decides Cmd-vs-Ctrl from
 * the platform the page reports, which under device emulation is not the
 * machine the test runs on — so ask the page, as `EditorHarness.mod` does.
 */
const editorMod = (page: Page): Promise<"Meta" | "Control"> =>
  page.evaluate(() =>
    /Mac|iPhone|iPod|iPad/i.test(navigator.platform || "") ||
    /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent || "")
      ? "Meta"
      : "Control",
  );

/** Click ON an edge's line. Its bounding box is mostly empty space. */
async function clickEdge(page: Page, entity: string): Promise<void> {
  const at = await page.evaluate((id) => {
    const g = Array.from(document.querySelectorAll(".ce-mermaid .pele-edge")).find(
      (n) => n.getAttribute("data-ce-entity") === id,
    )!;
    const hit = g.querySelector(".ce-mmd-hit") as SVGGeometryElement;
    const p = hit.getPointAtLength(hit.getTotalLength() / 2);
    const m = hit.getScreenCTM()!;
    return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
  }, entity);
  await page.mouse.click(at.x, at.y);
}

/** Type into the open label field and commit. */
async function rename(page: Page, text: string, commit = "Enter"): Promise<void> {
  await label(page).waitFor();
  await page.keyboard.type(text);
  await page.keyboard.press(commit);
}

test.describe("Mermaid block — visual editing", () => {
  test("select, then + adds a connected step that is ready to type", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "C").click();
    await expect(page.locator(".ce-mmd-box")).toBeVisible();
    await page.locator(".ce-mmd-plus").click();
    await rename(page, "Celebrate");
    await expect(label(page)).toHaveCount(0);
    const src = await source(page);
    expect(src).toContain("[Celebrate]");
    expect(src).toMatch(/C --> \w+/);
    await expect(page.locator(".ce-mermaid-canvas")).toContainText("Celebrate");
  });

  test("the node grows with its name as it is typed; the field is never bigger than the node", async ({ page }) => {
    await open(page);
    await ready(page);
    const before = await source(page);
    await node(page, "C").dblclick();
    await label(page).waitFor();
    // The field against the node it is editing: same box, same centre.
    const fit = () =>
      page.evaluate(() => {
        const f = document.querySelector(".ce-mmd-input")!.getBoundingClientRect();
        const n = document.querySelector(".ce-mermaid .pele-node.ce-mmd-selected")!.getBoundingClientRect();
        return {
          node: Math.round(n.width),
          extraWidth: Math.round(f.width - n.width),
          extraHeight: Math.round(f.height - n.height),
          offCentre: Math.round(Math.abs(f.left + f.width / 2 - (n.left + n.width / 2))),
        };
      });
    const opened = await fit();
    expect(opened.extraWidth).toBeLessThanOrEqual(2);

    await page.keyboard.type("A considerably longer name");
    const typed = await fit();
    // The NODE got wider — the picture is following the typing…
    expect(typed.node).toBeGreaterThan(opened.node + 40);
    // …and the field is still the node, not a box laid over its neighbours.
    expect(typed.extraWidth).toBeLessThanOrEqual(4);
    expect(typed.extraHeight).toBeLessThanOrEqual(4);
    expect(typed.offCentre).toBeLessThanOrEqual(1);
    // (One word of it: a name this long is wrapped onto two lines.)
    await expect(page.locator(".ce-mermaid-canvas")).toContainText("considerably");
    // Nothing is written until the name is committed.
    expect(await source(page)).toBe(before);

    await page.keyboard.press("Escape");
    await expect(page.locator(".ce-mermaid-canvas")).not.toContainText("considerably");
    expect(await source(page)).toBe(before);
  });

  test("Tab chains steps without touching the mouse", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "C").click();
    await page.keyboard.press("Tab");
    await rename(page, "One", "Tab");
    await rename(page, "Two");
    const src = await source(page);
    expect(src).toContain("[One]");
    expect(src).toContain("[Two]");
  });

  test("double-click renames; typing over a selected node renames too", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "A").dblclick();
    await rename(page, "Begin");
    expect(await source(page)).toContain("A[Begin]");
    await node(page, "D").click();
    await page.keyboard.type("Repair");
    await page.keyboard.press("Enter");
    expect(await source(page)).toContain("D[Repair]");
  });

  test("dragging a connect dot onto another node connects them", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "A").click();
    const dot = (await page.locator(".ce-mmd-dot-right").boundingBox())!;
    const to = (await node(page, "C").boundingBox())!;
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(await source(page)).toContain("A --> C");
  });

  test("the bar acts on the selection: shape, line, delete — and Mod+Z undoes", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "A").click();
    await page.locator('.ce-mermaid-bar [data-action="shape:stadium"]').click();
    expect(await source(page)).toContain("A([Start])");

    // A is still selected, and its + sits on the middle of the short edge
    // leaving it. Let go of A first.
    await page.keyboard.press("Escape");
    await clickEdge(page, "edge:A->B#0");
    await page.locator('.ce-mermaid-bar [data-action="line:dotted"]').click();
    expect(await source(page)).toContain("-.->");

    await node(page, "D").click();
    await page.keyboard.press("Delete");
    expect(await source(page)).not.toContain("Fix it");
    // The canvas has the focus, not the editor's text — the key still has to
    // reach the editor's history.
    await page.keyboard.press(`${await editorMod(page)}+z`);
    await expect.poll(() => source(page)).toContain("Fix it");
  });

  test("Delete on a selected node removes the node, never the block", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "D").click();
    await page.keyboard.press("Backspace");
    await expect(page.locator(".ce-mermaid")).toHaveCount(1);
    expect(await source(page)).not.toContain("Fix it");
  });
});

test.describe("Mermaid block — Code mode", () => {
  test("the picture follows the typing; the document changes once, on leaving", async ({ page }) => {
    await open(page);
    await ready(page);
    const before = await source(page);
    await page.locator(".ce-mermaid").hover();
    await page.locator('.ce-mermaid-seg[data-mode="code"]').click();
    const field = page.locator(".ce-mermaid-source");
    await expect(field).toBeFocused();
    await field.fill("flowchart TD\n  X[Typed] --> Y[In code]");
    await expect(page.locator(".ce-mermaid-canvas")).toContainText("Typed");
    expect(await source(page)).toBe(before);
    await page.locator('.ce-mermaid-seg[data-mode="diagram"]').click();
    await expect.poll(() => source(page)).toContain("X[Typed]");
    // One edit session, one undo step.
    await page.locator(".ce-block", { hasText: "Text after the diagram." }).click();
    await page.keyboard.press(`${await editorMod(page)}+z`);
    await expect.poll(() => source(page)).toBe(before);
  });

  test("broken source shows the error, keeps the last picture, and Escape discards it", async ({ page }) => {
    await open(page);
    await ready(page);
    const before = await source(page);
    await page.locator(".ce-mermaid").hover();
    await page.locator('.ce-mermaid-seg[data-mode="code"]').click();
    const field = page.locator(".ce-mermaid-source");
    await field.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(t.value.length, t.value.length));
    await page.keyboard.type("\n  B --> --> ???");
    await expect(page.locator(".ce-mermaid")).toHaveAttribute("data-state", "error");
    await expect(page.locator(".ce-mermaid-canvas > svg")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ce-mermaid")).toHaveAttribute("data-mode", "diagram");
    await expect(page.locator(".ce-mermaid")).toHaveAttribute("data-state", "ready");
    expect(await source(page)).toBe(before);
  });
});

test.describe("Mermaid block — in the document", () => {
  test("the toolbar inserts an empty block; a starter makes it a diagram", async ({ page }) => {
    await page.goto("/");
    await page.locator(".ce-block").last().click();
    await page.locator(".toolbar button", { hasText: "Diagram" }).click();
    await expect(page.locator(".ce-mermaid")).toHaveAttribute("data-state", "empty");
    await page.locator('.ce-mermaid-template[data-template="sequence"]').click();
    await expect(page.locator(".ce-mermaid[data-interactive] .ce-mermaid-canvas > svg")).toHaveCount(1);
    expect(await source(page)).toMatch(/^sequenceDiagram/);
  });

  test("text around the diagram is still editable after working in it", async ({ page }) => {
    await open(page);
    await ready(page);
    await node(page, "C").click();
    await page.keyboard.press("Tab");
    await rename(page, "Next");
    const after = page.locator(".ce-block", { hasText: "Text after the diagram." });
    await after.click();
    // The browser moves its selection at once but tells the editor a moment
    // later (`selectionchange`); a key pressed in between would act on the
    // caret the editor still has. Wait for the editor's own caret.
    const id = await after.getAttribute("data-block-id");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector("[data-creo-edit]") as unknown as {
            __creoEdit: { selStore: { get(): { kind: string; at?: { blockId: string } } } };
          };
          return root.__creoEdit.selStore.get().at?.blockId ?? null;
        }),
      )
      .toBe(id);
    await page.keyboard.press("End");
    await page.keyboard.type(" OK");
    await expect(after).toHaveText("Text after the diagram. OK");
  });

  test("read-only: drawn, nothing to edit by hand, source shown read-only", async ({ page }) => {
    await open(page, "&editable=false");
    await page.waitForTimeout(300);
    await expect(page.locator(".ce-mermaid")).not.toHaveAttribute("data-interactive", "true");
    await expect(page.locator("[data-ce-entity]")).toHaveCount(0);
    await page.locator(".ce-mermaid").hover();
    await page.locator('.ce-mermaid-seg[data-mode="code"]').click();
    await expect(page.locator(".ce-mermaid-source")).toHaveJSProperty("readOnly", true);
  });

  test("virtualized: draws and edits the same", async ({ page }) => {
    await open(page, "&virtualized=1");
    await ready(page);
    await node(page, "C").click();
    await page.keyboard.press("Tab");
    await rename(page, "V");
    expect(await source(page)).toContain("[V]");
  });
});

// A mind map, a timeline and a Gantt chart are not graphs: nothing to
// connect, and a thing in the source is known by its line. What needs a
// browser here is where things ARE — which side of an idea its + goes, that
// a period's frame is the period's and not its events', that a press on an
// event inside a period is the event's — and typing in a field in the bar.
// `&diagram=<kind>` opens the example on that kind (src/app.ts).
test.describe("Mermaid block — mind maps, timelines and Gantt charts", () => {
  const openKind = async (page: Page, kind: string): Promise<void> => {
    await open(page, `&diagram=${kind}`);
    await ready(page);
  };
  const thing = (page: Page, id: string) => page.locator(`.ce-mermaid [data-ce-entity="${id}"]`).first();
  /** Press on the shape of one drawn around others, clear of its words. */
  const pressOwn = (page: Page, id: string) =>
    page.locator(`.ce-mermaid [data-ce-entity="${id}"] > rect`).first().click({ position: { x: 6, y: 6 } });
  const selected = (page: Page): Promise<string[]> =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".ce-mermaid .ce-mmd-selected")).map((n) => n.getAttribute("data-ce-entity") ?? ""),
    );
  const centre = async (locator: ReturnType<Page["locator"]>): Promise<{ x: number; y: number }> => {
    const b = (await locator.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const plus = (page: Page) => page.locator(".ce-mmd-plus");
  const field = (page: Page, name: string) => page.locator(`.ce-mermaid-field-input[data-field="${name}"]`);

  test("mind map: the + is on the side an idea grows to; Tab goes under, Enter beside", async ({ page }) => {
    await openKind(page, "mindmap");
    const root = await centre(thing(page, "idea:1"));
    // An idea right of the root grows right, one left of it left; the root
    // itself, down — its branches leave it sideways.
    for (const id of ["idea:2", "idea:6", "idea:5"]) {
      await thing(page, id).click();
      const idea = await centre(thing(page, id));
      const at = await centre(plus(page));
      expect(Math.sign(at.x - idea.x)).toBe(Math.sign(idea.x - root.x));
    }
    await thing(page, "idea:1").click();
    expect((await centre(plus(page))).y).toBeGreaterThan(root.y + 20);
    await expect(page.locator(".ce-mmd-dot:visible")).toHaveCount(0);

    await thing(page, "idea:6").click();
    await page.keyboard.press("Tab");
    await rename(page, "Launch party");
    await page.keyboard.press("Enter");
    await rename(page, "Retro", "Tab");
    await rename(page, "Notes");
    expect(await source(page)).toBe(
      "mindmap\n  root((Project))\n    Plan\n      Scope\n      Budget\n    Build\n    Ship\n      Launch party\n      Retro\n        Notes",
    );
    // The field took the keys; the editor's caret did not move into the map.
    await expect(page.locator(".ce-mermaid-canvas")).toBeFocused();
    const mod = await editorMod(page);
    await page.keyboard.press(`${mod}+z`);
    expect(await source(page)).toContain("        New idea");
  });

  test("mind map: a leaf's name is typed in a field as wide as the words", async ({ page }) => {
    await openKind(page, "mindmap");
    await thing(page, "idea:3").dblclick();
    await label(page).waitFor();
    await page.keyboard.type("A much longer scope");
    // Bare words have no box of their own to give the field its padding:
    // it must still hold them on one line, as the map draws them.
    const box = (await label(page).boundingBox())!;
    expect(box.height).toBeLessThan(40);
    await page.keyboard.press("Enter");
    expect(await source(page)).toContain("      A much longer scope\n");
    await page.locator('.ce-mermaid-entity [data-action="shape:hexagon"]').click();
    expect(await source(page)).toContain("      {{A much longer scope}}\n");
    await page.keyboard.press("Delete");
    expect(await source(page)).not.toContain("scope");
  });

  test("timeline: a period's frame is its own; a press on its event is the event's", async ({ page }) => {
    await openKind(page, "timeline");
    await pressOwn(page, "period:3");
    expect(await selected(page)).toEqual(["period:3"]);
    const frame = (await page.locator(".ce-mmd-box").boundingBox())!;
    const first = (await thing(page, "event:3:0").boundingBox())!;
    // Round the period, not round the events drawn under it.
    expect(frame.y + frame.height).toBeLessThan(first.y);

    await plus(page).click();
    await rename(page, "Hiring");
    expect(await source(page)).toContain("  2019 : Idea\n       : Prototype\n       : Hiring\n  2021");
    expect(await selected(page)).toEqual(["event:5:0"]);
    await expect(plus(page)).toBeHidden();

    await thing(page, "event:4:0").click();
    expect(await selected(page)).toEqual(["event:4:0"]);
    await page.keyboard.press("Delete");
    expect(await source(page)).toContain("  2019 : Idea\n       : Hiring\n  2021");

    await pressOwn(page, "section:2");
    expect(await selected(page)).toEqual(["section:2"]);
    await page.keyboard.press("F2");
    await rename(page, "Before");
    expect(await source(page)).toContain("  section Before\n");
    await pressOwn(page, "period:5");
    await page.keyboard.press("Enter");
    await rename(page, "2022");
    expect(await source(page)).toContain("  2021 : Launch\n  2022\n  section Later");
  });

  test("Gantt: a task's marks and dates are typed in the bar, and the chart follows", async ({ page }) => {
    await openKind(page, "gantt");
    await thing(page, "task:5").click();
    const before = (await thing(page, "task:5").locator("rect").boundingBox())!;
    await expect(field(page, "start")).toHaveValue("after d1");
    await field(page, "length").fill("3 weeks");
    await field(page, "length").press("Enter");
    expect(await source(page)).toContain("  Implement :after d1, 3w\n");
    await expect(field(page, "length")).toHaveValue("3w");
    const after = (await thing(page, "task:5").locator("rect").boundingBox())!;
    expect(after.width).not.toBe(before.width);

    // A button of the bar pressed while a field is being typed in: the mark
    // is written, the field keeps its text and the keyboard…
    await field(page, "start").fill("2026-01-14");
    await page.locator('.ce-mermaid-entity [data-action="flags:active"]').click();
    expect(await source(page)).toContain("  Implement :active, after d1, 3w\n");
    await expect(page.locator('[data-action="flags:active"]')).toHaveAttribute("aria-pressed", "true");
    await expect(field(page, "start")).toHaveValue("2026-01-14");
    await expect(field(page, "start")).toBeFocused();
    expect(await selected(page)).toEqual(["task:5"]);
    // …and leaving it writes it, as Enter does.
    await page.keyboard.press("Tab");
    await expect.poll(() => source(page)).toContain("  Implement :active, 2026-01-14, 3w\n");
    await expect(field(page, "length")).toBeFocused();
    expect(await selected(page)).toEqual(["task:5"]);

    // A start nobody can read is not written.
    await field(page, "start").fill("someday");
    await field(page, "start").press("Enter");
    expect(await source(page)).toContain("  Implement :active, 2026-01-14, 3w\n");
    await expect(field(page, "start")).toHaveValue("2026-01-14");
    await expect(page.locator(".ce-mermaid-info")).toContainText("not applied");

    // The + is beside the bar, where the next task is not.
    const bar = (await thing(page, "task:5").locator("rect").boundingBox())!;
    expect((await centre(plus(page))).x).toBeGreaterThan(bar.x + bar.width);
    await plus(page).click();
    await rename(page, "Review");
    expect(await source(page)).toContain("  Implement :active, 2026-01-14, 3w\n  Review :1d\n  section Ship");
    const mod = await editorMod(page);
    await page.keyboard.press(`${mod}+z`);
    await page.keyboard.press(`${mod}+z`);
    expect(await source(page)).not.toContain("Review");
  });

  test("text around the diagram is still editable after working in one", async ({ page }) => {
    await openKind(page, "gantt");
    await thing(page, "task:4").click();
    await field(page, "length").fill("6d");
    await field(page, "length").press("Enter");
    const after = page.locator("[data-creo-edit] p").last();
    await after.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" OK");
    await expect(after).toHaveText("Text after the diagram. OK");
    expect(await source(page)).toContain("  Design :d1, 2026-01-05, 6d\n");
  });
});
