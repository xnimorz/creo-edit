// ---------------------------------------------------------------------------
// blockquotePlugin — a quoted line, `{ type: "blockquote", runs }`.
// First-party but opt-in (not in `defaultPlugins`):
//
//   import { blockquotePlugin } from "creo-edit";
//   createEditor({ plugins: [blockquotePlugin()] });
//
// The editor is row-based, so a quotation is a run of consecutive
// blockquote blocks, one per line, the way a list is a run of `li` blocks.
// Editing follows lists too: Enter continues the quote, Enter on an empty
// quoted line ends it, and Backspace at the start of a line unquotes it.
//
// Markdown: `> text`. HTML: `<blockquote>`. Typing `> ` at the start of a
// paragraph quotes it (turn off with `{ shortcut: false }`).
// ---------------------------------------------------------------------------

import { blockquote, view, type PublicView } from "creo";
import { collectRuns, runsToHtml } from "../../clipboard/inlineHtml";
import {
  setBlockType,
  splitBlock,
} from "../../commands/structuralCommands";
import { anchorOffset, isCaret } from "../../controller/selection";
import { isTextBearing, runsLength } from "../../model/blockText";
import { newBlockId } from "../../model/doc";
import {
  deserializeRun,
  serializeRun,
  type SerializedRun,
} from "../../model/runSerialize";
import type { Block, BlockquoteBlock, BlockSpec } from "../../model/types";
import { runsToMarkdown } from "../../markdown/serialize";
import { defaultTextCodec } from "../../plugin/anchorCodec";
import type {
  BlockDef,
  CommandCtx,
  CommandDef,
  EditorPlugin,
  KeymapDef,
  TriggerDef,
} from "../../plugin/types";
import { InlineRunsView } from "../../render/InlineRunsView";
import type { SlashItem } from "../slash/items";

export const BlockquoteView = view<{ block: BlockquoteBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    blockquote(
      { "data-block-id": b.id, "data-block-kind": "blockquote", class: "ce-block ce-blockquote" },
      () => {
        InlineRunsView({ runs: b.runs });
      },
    );
  },
}));

const blockquoteDef: BlockDef<BlockquoteBlock> = {
  type: "blockquote",
  view: BlockquoteView as PublicView<{ block: BlockquoteBlock; key?: string }, void>,
  isTextBearing: true,
  anchorCodec: defaultTextCodec,
  htmlCodec: {
    matchHTML: ["blockquote"],
    parseHTML(el, ctx) {
      return { id: newBlockId(), type: "blockquote", runs: collectRuns(el, ctx.marks) };
    },
    serializeHTML(b) {
      return `<blockquote>${runsToHtml((b as BlockquoteBlock).runs)}</blockquote>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const q = b as BlockquoteBlock;
      return { id: q.id, type: "blockquote", runs: q.runs.map(serializeRun) };
    },
    deserialize(s, id) {
      const sb = s as { runs?: SerializedRun[] };
      return { id, type: "blockquote", runs: (sb.runs ?? []).map(deserializeRun) } as BlockSpec;
    },
  },
  markdownCodec: {
    serialize(block) {
      const text = runsToMarkdown((block["runs"] as SerializedRun[] | undefined) ?? []);
      return text.length > 0 ? `> ${text}` : ">";
    },
  },
};

/** The quoted block the caret sits in, with the caret's offset; null for anything else. */
function caretQuote(ctx: CommandCtx): { block: BlockquoteBlock; off: number } | null {
  const sel = ctx.selStore.get();
  if (!isCaret(sel)) return null;
  const block = ctx.docStore.get().byId.get(sel.at.blockId);
  if (!block || block.type !== "blockquote") return null;
  return { block: block as BlockquoteBlock, off: anchorOffset(sel.at) };
}

/** Enter: an empty quoted line leaves the quote; any other splits into another quoted line. */
function enter(ctx: CommandCtx): boolean {
  const at = caretQuote(ctx);
  if (!at) return false;
  if (runsLength(at.block.runs) === 0) return setBlockType(ctx, { type: "p" });
  if (!splitBlock(ctx)) return false;
  // `splitBlock` makes the second half a paragraph, and puts the caret in it.
  return setBlockType(ctx, { type: "blockquote" });
}

/** Quotes the caret's block, or unquotes it if it already is one. */
function toggle(ctx: CommandCtx): boolean {
  const sel = ctx.selStore.get();
  const id = isCaret(sel) ? sel.at.blockId : sel.anchor.blockId;
  const block = ctx.docStore.get().byId.get(id);
  if (!block || !isTextBearing(block as Block)) return false;
  return setBlockType(ctx, { type: block.type === "blockquote" ? "p" : "blockquote" });
}

const commands: CommandDef<unknown>[] = [
  { t: "blockquote.toggle", run: (ctx) => toggle(ctx) },
  { t: "blockquote.enter", run: (ctx) => enter(ctx) },
  {
    t: "blockquote.unquote",
    run: (ctx) => {
      const at = caretQuote(ctx);
      return at !== null && setBlockType(ctx, { type: "p" });
    },
  },
  // What the keys run. The keymap calls a command without the dispatcher —
  // so with no undo step and no change batch — so these only re-enter it.
  { t: "blockquote.enterKey", run: (ctx) => ctx.dispatch("blockquote.enter") },
  { t: "blockquote.backspaceKey", run: (ctx) => ctx.dispatch("blockquote.unquote") },
];

const keymap: KeymapDef[] = [
  {
    chord: "Enter",
    when: (ctx) => caretQuote(ctx) !== null,
    command: { t: "blockquote.enterKey" },
  },
  {
    chord: "Backspace",
    when: (ctx) => caretQuote(ctx)?.off === 0,
    command: { t: "blockquote.backspaceKey" },
  },
];

/** `> ` typed at the very start of a paragraph. */
const shortcut: TriggerDef = {
  match: " ",
  open(ctx) {
    const sel = ctx.selStore.get();
    if (!isCaret(sel) || sel.at.path.length !== 1 || anchorOffset(sel.at) !== 2) return null;
    const block = ctx.docStore.get().byId.get(sel.at.blockId);
    if (!block || block.type !== "p") return null;
    const head = block.runs.map((r) => r.text).join("").slice(0, 2);
    if (head !== "> ") return null;
    ctx.dispatch({ t: "deleteBackward" });
    ctx.dispatch({ t: "deleteBackward" });
    ctx.dispatch({ t: "setBlockType", payload: { type: "blockquote" } });
    return null;
  },
};

/** Slash-menu item — append to your slash items to offer quoting at `/`. */
export const blockquoteSlashItem: SlashItem = {
  id: "blockquote",
  title: "Quote",
  description: "Quote this line",
  keywords: ["quote", "blockquote", "citation"],
  run: (ctx) => ctx.dispatch({ t: "blockquote.toggle" }),
};

export type BlockquoteOptions = {
  /** Turn a paragraph into a quote when `> ` is typed at its start. Default `true`. */
  shortcut?: boolean;
};

export function blockquotePlugin(opts: BlockquoteOptions = {}): EditorPlugin {
  return {
    name: "blockquote",
    blocks: [blockquoteDef as BlockDef<Block>],
    commands,
    keymap,
    triggers: opts.shortcut === false ? [] : [shortcut],
  };
}
