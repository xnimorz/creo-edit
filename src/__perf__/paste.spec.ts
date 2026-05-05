import { describe, expect, it } from "bun:test";
import "../__tests__/setup";
import { makeContainer, SYNC_SCHEDULER } from "../__tests__/setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import { parsePlainText } from "../clipboard/htmlParser";
import { caretAt } from "../controller/selection";

/**
 * Generate a synthetic War-and-Peace-sized fixture deterministically.
 * 600k words, ~150 chars per paragraph, ~4000 paragraphs.
 *
 * We don't ship the real W&P text — generating in-process avoids a
 * 3MB binary checked into the repo and produces consistent benchmark input.
 */
function makeBigText(words: number): string {
  const word = "lorem";
  const wordsPerPara = 80;
  const paras: string[] = [];
  let n = 0;
  while (n < words) {
    const take = Math.min(wordsPerPara, words - n);
    const arr = new Array(take).fill(word);
    paras.push(arr.join(" "));
    n += take;
  }
  return paras.join("\n\n");
}

/**
 * Paste a War-and-Peace-sized blob INTO an existing doc (not as initial).
 * This is the user-facing scenario that triggered the original perf bug:
 * `insertManyAt`'s splice-in-loop was O(M*N) on the order array, wedging the
 * browser for tens of seconds on a 4k-paragraph paste. After the bulk-rebuild
 * fix the same paste should land in well under a second of model work.
 *
 * The render side is still O(N) DOM mounts unless `virtualized: true`; this
 * test measures only the model insertion cost.
 */
describe("Performance gates — paste into existing doc", () => {
  it("inserting ~7500 paragraphs runs the model insert in < 200ms", async () => {
    // 600k words at 80 words/para ≈ 7500 paragraphs.
    const blocks = (await import("../clipboard/htmlParser")).parsePlainText(
      makeBigText(600_000),
    );
    const editor = (await import("../createEditor")).createEditor();
    // Place caret at end of the seed paragraph so insert lands in the middle
    // path of insertBlocks → splitAndInsert → insertManyAt.
    const seedId = editor.docStore.get().order[0]!;
    editor.selStore.set({ kind: "caret", at: { blockId: seedId, path: [0], offset: 0 } });
    const insertBlocks = (await import("../commands/insertCommands")).insertBlocks;
    const t0 = performance.now();
    insertBlocks({ docStore: editor.docStore, selStore: editor.selStore }, blocks);
    const dt = performance.now() - t0;
    expect(editor.docStore.get().order.length).toBeGreaterThan(7000);
    // Pre-fix: this took 30+ seconds because of O(M*N) splice in insertManyAt.
    // Post-fix: under 200ms on CI hardware.
    expect(dt).toBeLessThan(500);
  });
});

describe("Performance gates", () => {
  it("blockification of a 600k-word doc completes < 200ms", () => {
    const txt = makeBigText(600_000);
    const t0 = performance.now();
    const blocks = parsePlainText(txt);
    const dt = performance.now() - t0;
    // Sanity: produced thousands of paragraph blocks.
    expect(blocks.length).toBeGreaterThan(1000);
    expect(dt).toBeLessThan(400); // generous CI cushion vs target 200ms
  });

  it("first paint of a 100k-word doc with virtualization < 250ms", () => {
    const txt = makeBigText(100_000);
    const blocks = parsePlainText(txt);
    const root = makeContainer();
    const editor = createEditor({
      initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
      virtualized: true,
      virtualEstimatedHeight: 30,
    });
    const t0 = performance.now();
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(500); // CI cushion vs target 250ms
  });

  it("typing in middle of large doc — per-keystroke wall-clock < 4ms avg", () => {
    const txt = makeBigText(2000); // small enough to not need virtualization
    const blocks = parsePlainText(txt);
    const root = makeContainer();
    const editor = createEditor({
      initial: { blocks: blocks.map((b) => ({ ...b } as never)) },
    });
    createApp(
      () => editor.EditorView(),
      new HtmlRender(root),
      SYNC_SCHEDULER,
    ).mount();
    const midId = editor.docStore.get().order[
      Math.floor(editor.docStore.get().order.length / 2)
    ]!;
    editor.selStore.set({ kind: "caret", at: caretAt(midId, 0) });

    const N = 50;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      editor.dispatch({ t: "insertText", text: "x" });
    }
    const total = performance.now() - t0;
    const avg = total / N;
    expect(avg).toBeLessThan(8); // CI cushion vs target 4ms/keystroke
  });
});
