// ---------------------------------------------------------------------------
// horizontalRulePlugin — a thematic break, `{ type: "hr" }`. First-party but
// opt-in (not in `defaultPlugins`):
//
//   import { horizontalRulePlugin } from "creo-edit";
//   createEditor({ plugins: [horizontalRulePlugin()] });
//
// An atomic block, like the calendar: the caret sits before or after it,
// never inside, and Backspace / Delete on it removes it.
//
// Markdown: `---`. HTML: `<hr>`. Typing `---` as the whole of a paragraph
// puts a rule there and leaves the caret on the emptied line below it (turn
// off with `{ shortcut: false }`).
// ---------------------------------------------------------------------------

import { div, hr, view, type PublicView } from "creo";
import { insertBlocks } from "../../commands/insertCommands";
import { anchorOffset, caret, caretAt, isCaret } from "../../controller/selection";
import { findPos, insertManyAt, newBlockId, updateBlock } from "../../model/doc";
import { recordChange, recordTextChange } from "../../model/changes";
import type { Block, BlockSpec, HorizontalRuleBlock, ParagraphBlock } from "../../model/types";
import type {
  BlockDef,
  CommandCtx,
  CommandDef,
  EditorPlugin,
  TriggerDef,
} from "../../plugin/types";
import type { SlashItem } from "../slash/items";

export const HorizontalRuleView = view<{ block: HorizontalRuleBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    // A box around the line, so the rule has a height to click and a caret
    // side on either edge; `<hr>` itself can hold no children.
    div(
      {
        "data-block-id": b.id,
        "data-block-kind": "hr",
        contenteditable: "false",
        class: "ce-block ce-hr",
      },
      () => {
        hr({});
      },
    );
  },
}));

const hrDef: BlockDef<HorizontalRuleBlock> = {
  type: "hr",
  view: HorizontalRuleView as PublicView<{ block: HorizontalRuleBlock; key?: string }, void>,
  isTextBearing: false,
  isAtomic: true,
  htmlCodec: {
    matchHTML: ["hr"],
    parseHTML() {
      return { id: newBlockId(), type: "hr" };
    },
    serializeHTML() {
      return "<hr>";
    },
  },
  serializeCodec: {
    serialize(b) {
      return { id: b.id, type: "hr" };
    },
    deserialize(_s, id) {
      return { id, type: "hr" } as BlockSpec;
    },
  },
  markdownCodec: {
    serialize() {
      return "---";
    },
    parse(lines, at) {
      return /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[at]!)
        ? { block: { type: "hr" }, end: at + 1 }
        : null;
    },
  },
};

/**
 * The caret's paragraph, if all it says is `---` and the caret is after it:
 * the rule goes in above, and the paragraph is emptied to type on.
 */
function fromParagraph(ctx: CommandCtx): boolean {
  const sel = ctx.selStore.get();
  if (!isCaret(sel) || sel.at.path.length !== 1) return false;
  const doc = ctx.docStore.get();
  const block = doc.byId.get(sel.at.blockId);
  if (!block || block.type !== "p") return false;
  const text = block.runs.map((r) => r.text).join("");
  if (text !== "---" || anchorOffset(sel.at) !== text.length) return false;

  const emptied = updateBlock(doc, { ...(block as ParagraphBlock), runs: [] } as Block);
  recordTextChange(sel.at, 0, text.length, 0);
  const pos = findPos(emptied, block.id);
  const rule: BlockSpec = { id: newBlockId(), type: "hr" };
  ctx.docStore.set(insertManyAt(emptied, pos, [rule]));
  recordChange({ kind: "insertBlock", blockId: rule.id, index: pos });
  ctx.selStore.set(caret(caretAt(block.id, 0)));
  return true;
}

const commands: CommandDef<unknown>[] = [
  {
    t: "hr.insert",
    run: (ctx) => insertBlocks({ docStore: ctx.docStore, selStore: ctx.selStore }, [{ id: newBlockId(), type: "hr" }]),
  },
  { t: "hr.fromParagraph", run: (ctx) => fromParagraph(ctx) },
];

/** `---` typed as the whole of a paragraph. */
const shortcut: TriggerDef = {
  match: "-",
  open(ctx) {
    ctx.dispatch("hr.fromParagraph");
    return null;
  },
};

/** Slash-menu item — append to your slash items to offer a rule at `/`. */
export const horizontalRuleSlashItem: SlashItem = {
  id: "hr",
  title: "Divider",
  description: "A horizontal rule",
  keywords: ["divider", "rule", "hr", "line", "separator"],
  run: (ctx) => ctx.dispatch({ t: "hr.insert" }),
};

export type HorizontalRuleOptions = {
  /** Turn a paragraph that reads `---` into a rule as the third dash is typed. Default `true`. */
  shortcut?: boolean;
};

export function horizontalRulePlugin(opts: HorizontalRuleOptions = {}): EditorPlugin {
  return {
    name: "hr",
    blocks: [hrDef as BlockDef<Block>],
    commands,
    triggers: opts.shortcut === false ? [] : [shortcut],
  };
}
