// ---------------------------------------------------------------------------
// mdShortcutsPlugin — markdown typing shortcuts in WYSIWYG mode.
//
// Triggers fire on space (block-prefix patterns) or on the closing token of
// inline mark patterns. Each rule:
//   1. Matches a regex against the current block's text + caret position
//   2. Removes the matched markup characters (`# `, `**`, etc.)
//   3. Dispatches the corresponding command (setBlockType, toggleMark)
//
// Reuses the trigger system: each rule is a TriggerDef whose `match` is the
// trigger character (space, asterisk, backtick, ...) and whose `open()`
// inspects the block prefix and applies the rule synchronously, then
// closes — no UI rendered.
// ---------------------------------------------------------------------------

import { caret } from "../../controller/selection";
import { runsAt } from "../../plugin/runsAt";
import type {
  EditorPlugin,
  TriggerCtx,
  TriggerDef,
} from "../../plugin/types";
import type { MarkAttrs, MarkName } from "../../model/types";

export type RuleResult = "applied" | "skipped";

export type BlockRule = {
  /** Pattern matched against the prefix of the block's runs text — must
   *  capture the leading markup so we know how many chars to delete. */
  pattern: RegExp;
  apply(ctx: TriggerCtx): RuleResult;
};

/** The shipped block rules. Exported so a host can filter, reorder or extend
 *  them instead of shipping a second plugin beside this one. */
export const defaultBlockRules: BlockRule[] = [
  // Headings: `# ` … `###### `
  ...[1, 2, 3, 4, 5, 6].map((lvl) => ({
    pattern: new RegExp(`^${"#".repeat(lvl)} $`),
    apply(ctx: TriggerCtx): RuleResult {
      // Delete the `#`s and the trailing space, then setBlockType.
      const drop = lvl + 1;
      for (let i = 0; i < drop; i++) ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "setBlockType", payload: { type: `h${lvl}` } });
      return "applied";
    },
  })),
  // Unordered list: `- ` or `* `
  {
    pattern: /^[-*] $/,
    apply(ctx) {
      ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "toggleList", ordered: false });
      return "applied";
    },
  },
  // Ordered list: `1. `
  {
    pattern: /^1\. $/,
    apply(ctx) {
      ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "toggleList", ordered: true });
      return "applied";
    },
  },
  // Code block: ``` (followed by space)
  {
    pattern: /^``` $/,
    apply(ctx) {
      for (let i = 0; i < 4; i++) ctx.dispatch({ t: "deleteBackward" });
      ctx.dispatch({ t: "setBlockType", payload: { type: "code" } });
      return "applied";
    },
  },
];

/** Dispatch the given mark as toggle, by selecting the matched range and
 *  applying then collapsing back. Used for inline rules like `**foo**`. */
function applyInlineMark(
  ctx: TriggerCtx,
  mark: MarkName,
  attrs: MarkAttrs,
  matchLen: number,
  innerLen: number,
  delimLen: number,
): void {
  // Caret currently sits AFTER the closing delimiter. We want to:
  //  1. Delete the closing delimiter (delimLen chars)
  //  2. Select back from caret (after step 1) to (matchLen - delimLen) chars
  //     before — which is the start of the inner text
  //  3. Toggle mark on selection
  //  4. Collapse caret to end of inner
  const sel = ctx.selStore.get();
  if (sel.kind !== "caret") return;
  const at = sel.at;
  const lastIdx = at.path.length - 1;
  const off = at.path[lastIdx] ?? 0;
  // Delete the closing delimiter chars after the inner content.
  for (let i = 0; i < delimLen; i++) ctx.dispatch({ t: "deleteBackward" });
  // Now caret is at offset `off - delimLen`. We want to select the inner
  // run [off - matchLen, off - delimLen).
  const innerEnd = off - delimLen;
  const innerStart = innerEnd - innerLen;
  if (innerStart < 0) return;
  const path = [...at.path];
  path[lastIdx] = innerStart;
  const startA = { blockId: at.blockId, path, offset: innerStart };
  path[lastIdx] = innerEnd;
  const endA = { blockId: at.blockId, path: [...path], offset: innerEnd };
  ctx.selStore.set({ kind: "range", anchor: startA, focus: endA });
  ctx.dispatch({ t: "toggleMark", mark, attrs });
  // Delete the OPENING delimiter still sitting before the (now-marked) inner
  // text — place the caret at innerStart, then backspace delimLen chars.
  const newPath = [...at.path];
  newPath[lastIdx] = innerStart;
  ctx.selStore.set(caret({ blockId: at.blockId, path: newPath, offset: innerStart }));
  for (let i = 0; i < delimLen; i++) ctx.dispatch({ t: "deleteBackward" });
  // Caret now at innerStart - delimLen + innerLen (after marked text).
  const finalOff = innerStart - delimLen + innerLen;
  const finalPath = [...at.path];
  finalPath[lastIdx] = finalOff;
  ctx.selStore.set(
    caret({ blockId: at.blockId, path: finalPath, offset: finalOff }),
  );
}

export type InlineRule = {
  /** Closing trigger char that should fire the rule. */
  closer: string;
  /** Pattern matched against the run text up to and INCLUDING the just-
   *  inserted `closer`. The first capture group is the inner text. */
  pattern: RegExp;
  delimLen: number;
  mark: MarkName;
  /** Attrs applied with the mark. Omit for the boolean marks. */
  attrs?: MarkAttrs;
};

/** The shipped inline rules — see `defaultBlockRules`. */
export const defaultInlineRules: InlineRule[] = [
  // **bold**
  { closer: "*", pattern: /\*\*([^*\n]+)\*\*$/, delimLen: 2, mark: "b" },
  // __bold__
  { closer: "_", pattern: /__([^_\n]+)__$/, delimLen: 2, mark: "b" },
  // *italic* — match only after we've seen the closing single asterisk and
  // there isn't already a ** wrap around it.
  { closer: "*", pattern: /(?<!\*)\*([^*\n]+)\*$/, delimLen: 1, mark: "i" },
  // _italic_
  { closer: "_", pattern: /(?<!_)_([^_\n]+)_$/, delimLen: 1, mark: "i" },
  // ~~strike~~
  { closer: "~", pattern: /~~([^~\n]+)~~$/, delimLen: 2, mark: "s" },
  // `code`
  { closer: "`", pattern: /`([^`\n]+)`$/, delimLen: 1, mark: "code" },
];

function getBlockPrefixUpToCaret(ctx: TriggerCtx): string | null {
  const sel = ctx.selStore.get();
  if (sel.kind !== "caret") return null;
  const at = sel.at;
  const block = ctx.docStore.get().byId.get(at.blockId);
  if (!block) return null;
  const rc = runsAt(block, at);
  if (!rc) return null;
  const off = at.path[at.path.length - 1] ?? 0;
  let s = "";
  let acc = 0;
  for (const r of rc.runs) {
    if (acc + r.text.length >= off) {
      s += r.text.slice(0, off - acc);
      break;
    }
    s += r.text;
    acc += r.text.length;
  }
  return s;
}

function makeSpaceTrigger(rules: readonly BlockRule[]): TriggerDef {
  return {
    match: " ",
    open(ctx) {
      const prefix = getBlockPrefixUpToCaret(ctx);
      if (prefix === null) return null;
      for (const rule of rules) {
        if (rule.pattern.test(prefix)) {
          rule.apply(ctx);
          break;
        }
      }
      // Return null — no UI to open, manager stays inactive so subsequent
      // typing can fire other rules.
      return null;
    },
  };
}

function makeInlineTrigger(
  closer: string,
  rules: readonly InlineRule[],
): TriggerDef {
  return {
    match: closer,
    open(ctx) {
      const prefix = getBlockPrefixUpToCaret(ctx);
      if (prefix === null) return null;
      for (const rule of rules) {
        if (rule.closer !== closer) continue;
        const m = rule.pattern.exec(prefix);
        if (!m) continue;
        const inner = m[1] ?? "";
        if (inner.length === 0) continue;
        applyInlineMark(
          ctx,
          rule.mark,
          rule.attrs ?? null,
          m[0]!.length,
          inner.length,
          rule.delimLen,
        );
        break;
      }
      return null;
    },
  };
}


export type MdShortcutsOptions = {
  /**
   * Replace the block-prefix rules outright. Defaults to
   * `defaultBlockRules`; pass `[...defaultBlockRules, myRule]` to extend, or
   * a filtered copy to drop the ones you don't want.
   */
  blockRules?: BlockRule[];
  /** Same, for the inline mark rules. Defaults to `defaultInlineRules`. */
  inlineRules?: InlineRule[];
  /**
   * Rule patterns to drop from whichever set is in use, matched by their
   * `pattern.source`. Sugar for the common "everything except `1. `" case,
   * so a host doesn't have to reproduce the default array to remove one
   * entry from it.
   */
  disable?: (string | RegExp)[];
};

export function mdShortcutsPlugin(
  opts: MdShortcutsOptions = {},
): EditorPlugin {
  const disabled = new Set(
    (opts.disable ?? []).map((d) => (typeof d === "string" ? d : d.source)),
  );
  const keep = <T extends { pattern: RegExp }>(rules: T[]): T[] =>
    disabled.size === 0 ? rules : rules.filter((r) => !disabled.has(r.pattern.source));

  const blocks = keep(opts.blockRules ?? defaultBlockRules);
  const inline = keep(opts.inlineRules ?? defaultInlineRules);
  // One trigger per distinct closing character — registering a trigger for a
  // closer no rule uses would intercept the keystroke for nothing.
  const closers = [...new Set(inline.map((r) => r.closer))];

  return {
    name: "md-shortcuts",
    triggers: [
      ...(blocks.length ? [makeSpaceTrigger(blocks)] : []),
      ...closers.map((c) => makeInlineTrigger(c, inline)),
    ],
  };
}
