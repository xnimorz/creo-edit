import { afterEach, describe, expect, it } from "bun:test";
import "./setup";
import { clearDom, makeContainer, SYNC_SCHEDULER } from "./setup";
import { createApp, HtmlRender } from "creo";

import { createEditor } from "../createEditor";
import type { Block, CodeBlock } from "../model/types";
import type { DecorationDef, EditorPlugin } from "../plugin/types";

afterEach(() => {
  clearDom();
});

const flush = () => new Promise((r) => queueMicrotask(() => r(undefined)));

/** Gutter line numbers — the motivating case: one decoration per code line. */
function lineNumberPlugin(
  extra: Partial<DecorationDef> = {},
): EditorPlugin {
  const def: DecorationDef = {
    id: "line-numbers",
    layer: "left",
    match: (b: Block) => b.type === "code",
    targets: (_b, blockEl) =>
      Array.from(blockEl.querySelectorAll<HTMLElement>(".ce-code-line")),
    mount(_block, _target, host, _handle, index) {
      host.textContent = String(index + 1);
    },
    ...extra,
  };
  return { name: "line-numbers", decorations: [def] };
}

function mount(plugins: EditorPlugin[], code: string) {
  const container = makeContainer();
  const editor = createEditor({
    initial: {
      blocks: [
        { type: "p", runs: [{ text: "intro" }] },
        { type: "code", runs: [{ text: code }] },
      ],
    },
    plugins,
  });
  createApp(
    () => editor.EditorView(),
    new HtmlRender(container),
    SYNC_SCHEDULER,
  ).mount();
  return { container, editor };
}

function decoTexts(): string[] {
  const layer = document.querySelector(".ce-decorations")!;
  return Array.from(layer.querySelectorAll(".ce-deco-line-numbers")).map(
    (el) => el.textContent ?? "",
  );
}

describe("sub-block decoration targets", () => {
  it("mounts one decoration per target, not per block", async () => {
    mount([lineNumberPlugin()], "one\ntwo\nthree");
    await flush();
    expect(decoTexts()).toEqual(["1", "2", "3"]);
  });

  it("tags each mounted element with its target index", async () => {
    mount([lineNumberPlugin()], "a\nb");
    await flush();
    const layer = document.querySelector(".ce-decorations")!;
    const els = Array.from(
      layer.querySelectorAll<HTMLElement>(".ce-deco-line-numbers"),
    );
    expect(els.map((e) => e.dataset.targetIndex)).toEqual(["0", "1"]);
  });

  it("adds and removes decorations as lines come and go", async () => {
    const { editor } = mount([lineNumberPlugin()], "a\nb\nc");
    await flush();
    expect(decoTexts().length).toBe(3);

    const doc = editor.docStore.get();
    const codeId = doc.order[1]!;
    const code = doc.byId.get(codeId) as CodeBlock;
    editor.docStore.set({
      byId: new Map(doc.byId).set(codeId, { ...code, runs: [{ text: "a\nb" }] }),
      order: doc.order,
    });
    await flush();
    expect(decoTexts()).toEqual(["1", "2"]);
  });

  it("omitting targets keeps the per-block behaviour", async () => {
    const perBlock: EditorPlugin = {
      name: "per-block",
      decorations: [
        {
          id: "badge",
          layer: "right",
          match: (b: Block) => b.type === "code",
          mount(block, target, host) {
            // `target` is the block element itself when targets is omitted.
            host.dataset.same = String(
              target.getAttribute("data-block-id") === block.id,
            );
          },
        },
      ],
    };
    mount([perBlock], "a\nb\nc");
    await flush();
    const els = document.querySelectorAll<HTMLElement>(".ce-deco-badge");
    expect(els.length).toBe(1);
    expect(els[0]!.dataset.same).toBe("true");
    // No targets() means no data-target-index attribute is emitted.
    expect(els[0]!.dataset.targetIndex).toBeUndefined();
  });

  it("survives a targets() that throws", async () => {
    mount(
      [
        lineNumberPlugin({
          targets: () => {
            throw new Error("boom");
          },
        }),
      ],
      "a\nb",
    );
    await flush();
    expect(decoTexts()).toEqual([]);
    // Layer is still alive for other decorations.
    expect(document.querySelector(".ce-decorations")).toBeTruthy();
  });

  it("uniformTargets measures only the first target per frame", async () => {
    // Count layout reads on the line elements with and without the hint,
    // over an identical document. The absolute number depends on how many
    // reposition frames run; the ratio is the thing under test.
    const run = async (uniform: boolean): Promise<number> => {
      let measured = 0;
      mount(
        [
          lineNumberPlugin({
            ...(uniform ? { uniformTargets: true } : {}),
            targets: (_b, blockEl) => {
              const els = Array.from(
                blockEl.querySelectorAll<HTMLElement>(".ce-code-line"),
              );
              for (const el of els) {
                const orig = el.getBoundingClientRect.bind(el);
                el.getBoundingClientRect = () => {
                  measured++;
                  return orig();
                };
              }
              return els;
            },
          }),
        ],
        "a\nb\nc\nd",
      );
      await flush();
      expect(decoTexts()).toEqual(["1", "2", "3", "4"]);
      clearDom();
      return measured;
    };

    const withHint = await run(true);
    const withoutHint = await run(false);
    // Four lines: the plain path measures every one, the hinted path only
    // the first — so the hinted count is a quarter of the plain count.
    expect(withoutHint).toBe(withHint * 4);
  });

  it("slotWidth controls the reserved gutter width", async () => {
    mount([lineNumberPlugin({ slotWidth: 40 })], "a\nb");
    await flush();
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(".ce-deco-line-numbers"),
    );
    expect(els.length).toBe(2);
    for (const el of els) {
      expect(el.style.width).toBe("40px");
      expect(el.style.left).toBe("-40px");
    }
  });
});
