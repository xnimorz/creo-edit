// ---------------------------------------------------------------------------
// Commands — every change to the document goes through one of these, so each
// emits its `DocChange` and is one undo step.
//
// Switching a block between Diagram and Code is deliberately NOT a command:
// the dispatcher snapshots for undo before running anything, so a command
// that changes no document would still leave an empty undo step behind. The
// mode lives in the runtime (`mermaidController(editor).setMode`).
// ---------------------------------------------------------------------------

import {
  findPos,
  insertManyAt,
  isTextBearing,
  newBlockId,
  runsLength,
  updateBlock,
  type Block,
  type BlockId,
  type BlockSpec,
  type CommandCtx,
  type CommandDef,
  type InlineRun,
} from "../../index";
import { asMermaid, mermaidSpec } from "./block";
import { runtimeOf } from "./runtime";
import { MERMAID_TYPE, type MermaidBlock, type MermaidMode } from "./types";

// A note on how these are written. The dispatcher snapshots the document for
// undo BEFORE it runs a command — every command, including one dispatched
// from inside another. So a command built out of nested dispatches
// (`insertBlocks`, then `moveCursor`) leaves one undo entry per dispatch, and
// the user presses Mod+Z three times to take one insert back. These commands
// therefore write the stores themselves and record their own change: one
// dispatch, one undo step.
//
// The same snapshot is why `mermaid.setSource` with an unchanged source
// returns `false` but cannot avoid the empty undo entry the dispatcher has
// already pushed. Callers should not dispatch a source that has not changed;
// the block's own UI checks first.

export type MermaidInsertPayload = {
  /** Source for the new diagram. Omitted or empty = the starter picker. */
  source?: string;
  /** Mode the new block opens in. */
  mode?: MermaidMode;
};

const caretBlockId = (ctx: CommandCtx): BlockId | null => {
  const sel = ctx.selStore.get();
  return sel.kind === "caret" ? sel.at.blockId : sel.focus.blockId;
};

/** Put the caret beside an atomic block: side 0 is before it, 1 after. */
const besideAtomic = (ctx: CommandCtx, id: BlockId, side: 0 | 1): void => {
  ctx.selStore.set({ kind: "caret", at: { blockId: id, path: [side], offset: side } });
};

/** Swap a block for another of a different type, keeping id and position. */
function replaceInPlace(ctx: CommandCtx, old: Block, spec: BlockSpec): void {
  const next = { ...spec, id: old.id, index: old.index } as unknown as Block;
  ctx.docStore.set(updateBlock(ctx.docStore.get(), next));
  // The block's inside is something else entirely now; an anchor into the
  // old content has nowhere to map.
  ctx.change({ kind: "resetBlock", blockId: old.id });
}

function insert(ctx: CommandCtx, p: MermaidInsertPayload): boolean {
  const doc = ctx.docStore.get();
  const at = caretBlockId(ctx);
  const cur = at ? doc.byId.get(at) : undefined;
  const source = typeof p.source === "string" ? p.source : "";
  let id: BlockId;

  // An empty paragraph under the caret is what a slash menu leaves behind
  // once it has removed its own trigger text. Turn it into the diagram
  // rather than leaving a blank line above it.
  const emptyParagraph =
    !!cur &&
    cur.type === "p" &&
    isTextBearing(cur) &&
    runsLength((cur as unknown as { runs: InlineRun[] }).runs) === 0;

  if (emptyParagraph) {
    id = cur.id;
    replaceInPlace(ctx, cur, mermaidSpec(source, id));
  } else {
    id = newBlockId();
    const pos = cur ? findPos(doc, cur.id) : -1;
    const index = pos >= 0 ? pos + 1 : doc.order.length;
    ctx.docStore.set(insertManyAt(doc, index, [mermaidSpec(source, id)]));
    ctx.change({ kind: "insertBlock", blockId: id, index });
  }

  besideAtomic(ctx, id, 1);
  const rt = runtimeOf(ctx.editor);
  if (rt) {
    rt.intents.set(id, { focus: true, ...(p.mode ? { mode: p.mode } : {}) });
  }
  return true;
}

function setSource(
  ctx: CommandCtx,
  p: { blockId?: BlockId; source?: string },
): boolean {
  if (!p || typeof p.blockId !== "string" || typeof p.source !== "string") return false;
  const doc = ctx.docStore.get();
  const block = asMermaid(doc.byId.get(p.blockId));
  if (!block || block.source === p.source) return false;
  const next: MermaidBlock = { ...block, source: p.source };
  ctx.docStore.set(updateBlock(doc, next as unknown as Block));
  // No character an anchor could point at moved — the caret only ever sits
  // beside this block — so this is an attribute change, not a reset.
  ctx.change({ kind: "blockAttrs", blockId: block.id, type: MERMAID_TYPE });
  return true;
}

function fromCode(ctx: CommandCtx, p: { blockId?: BlockId }): boolean {
  const id = p?.blockId ?? caretBlockId(ctx);
  const block = id ? ctx.docStore.get().byId.get(id) : undefined;
  if (!block || block.type !== "code") return false;
  const source = block.runs.map((r) => r.text).join("");
  replaceInPlace(ctx, block, mermaidSpec(source, block.id));
  besideAtomic(ctx, block.id, 1);
  return true;
}

function toCode(ctx: CommandCtx, p: { blockId?: BlockId }): boolean {
  const id = p?.blockId ?? caretBlockId(ctx);
  const raw = id ? ctx.docStore.get().byId.get(id) : undefined;
  const block = asMermaid(raw);
  if (!block || !raw) return false;
  replaceInPlace(ctx, raw, {
    id: block.id,
    type: "code",
    lang: "mermaid",
    runs: block.source ? [{ text: block.source }] : [],
  } as BlockSpec);
  ctx.selStore.set({ kind: "caret", at: { blockId: block.id, path: [0], offset: 0 } });
  return true;
}

export const mermaidCommands: CommandDef<unknown>[] = [
  { t: "mermaid.insert", run: (ctx, p) => insert(ctx, (p ?? {}) as MermaidInsertPayload) },
  { t: "mermaid.setSource", run: (ctx, p) => setSource(ctx, (p ?? {}) as { blockId?: BlockId; source?: string }) },
  { t: "mermaid.fromCode", run: (ctx, p) => fromCode(ctx, (p ?? {}) as { blockId?: BlockId }) },
  { t: "mermaid.toCode", run: (ctx, p) => toCode(ctx, (p ?? {}) as { blockId?: BlockId }) },
];
