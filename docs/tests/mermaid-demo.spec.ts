import { expect, test, type Page } from "@playwright/test";

/**
 * The docs' "Mermaid diagrams" demo (/#/mermaid-demo): the plugin wired into
 * the docs site from its source, and the toolbar's calls into its API.
 *
 * The first diagram on the page is the flowchart
 *   A[Write it] --> B{Reviewed?};  B -->|Yes| C[Ship it];  B -->|No| D[Fix it];  D --> B
 */

const open = async (page: Page): Promise<void> => {
  await page.goto("/#/mermaid-demo");
  await page.locator(".mermaid-demo .ce-mermaid[data-interactive]").first().waitFor();
};
const flowchart = (page: Page) => page.locator(".mermaid-demo .ce-mermaid").first();
const node = (page: Page, id: string) =>
  flowchart(page).locator(`[data-ce-entity="node:${id}"]`).first();
const markdown = (page: Page) => page.locator(".mermaid-demo-md");

/** Add a step after C through the block's own + button, and name it. */
async function addAfterC(page: Page, name: string): Promise<void> {
  await node(page, "C").click();
  await flowchart(page).locator(".ce-mmd-plus").click();
  await page.locator(".ce-mmd-input").waitFor();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(page.locator(".ce-mmd-input")).toHaveCount(0);
}

test.describe("Mermaid diagrams demo", () => {
  test("every diagram on the page is drawn, and the panel shows the source", async ({ page }) => {
    await open(page);
    await expect(page.locator(".mermaid-demo .ce-mermaid-canvas > svg")).toHaveCount(4);
    await expect(markdown(page)).toContainText("```mermaid\nflowchart TD");
    await expect(markdown(page)).toContainText("stateDiagram-v2");
  });

  test("an edit in the picture reaches the markdown, and undo takes it back", async ({ page }) => {
    await open(page);
    await addAfterC(page, "Celebrate");
    // Without nodeId the new node takes the next free id.
    await expect(markdown(page)).toContainText("E[Celebrate]");
    await expect(markdown(page)).toContainText("C --> E");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(markdown(page)).not.toContainText("Celebrate");
  });

  test("“Unique node ids” names a new node through options.nodeId", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Unique node ids" }).click();
    await addAfterC(page, "Celebrate");
    await expect(markdown(page)).toContainText("[Celebrate]");
    const md = (await markdown(page).textContent()) ?? "";
    const id = /\b(n[a-z0-9]+)\[Celebrate\]/.exec(md)?.[1];
    expect(id).toBeTruthy();
    expect(md).toContain(`C --> ${id}`);
    expect(md).not.toContain("E[Celebrate]");
  });

  test("“All as code” switches every block without touching the document", async ({ page }) => {
    await open(page);
    const before = await markdown(page).textContent();
    await page.getByRole("button", { name: "All as code" }).click();
    await expect(page.locator('.mermaid-demo .ce-mermaid[data-mode="code"]')).toHaveCount(4);
    await page.getByRole("button", { name: "All as diagrams" }).click();
    await expect(page.locator('.mermaid-demo .ce-mermaid[data-mode="diagram"]')).toHaveCount(4);
    expect(await markdown(page).textContent()).toBe(before);
  });

  test("Insert diagram adds a block that opens on the starter picker", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Insert diagram" }).click();
    await expect(page.locator(".mermaid-demo .ce-mermaid")).toHaveCount(5);
    await expect(page.locator('.mermaid-demo .ce-mermaid[data-state="empty"]')).toHaveCount(1);
  });
});
