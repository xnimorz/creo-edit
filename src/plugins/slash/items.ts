// ---------------------------------------------------------------------------
// Default slash menu items — building blocks every editor ships with.
// Plugin authors extend by passing their own items to `slashCommandsPlugin`.
// ---------------------------------------------------------------------------

import type { CommandCtx } from "../../plugin/types";
import type { DispatchableCommand } from "../../createEditor";

export type SlashItem = {
  id: string;
  title: string;
  description?: string;
  /** Lowercase keywords used by the default fuzzy filter. */
  keywords?: string[];
  /**
   * Run the action. The slash menu has already removed the trigger char(s)
   * from the document by the time this fires, and the caret is back where
   * the trigger was — this fn just dispatches whatever should happen.
   */
  run(ctx: CommandCtx & { dispatch: (cmd: DispatchableCommand) => void }): void;
};

export const defaultSlashItems: SlashItem[] = [
  {
    id: "p",
    title: "Paragraph",
    description: "Plain body text",
    keywords: ["paragraph", "text", "body", "p"],
    run: (ctx) => ctx.dispatch({ t: "setBlockType", payload: { type: "p" } }),
  },
  {
    id: "h1",
    title: "Heading 1",
    keywords: ["heading", "h1", "title"],
    run: (ctx) => ctx.dispatch({ t: "setBlockType", payload: { type: "h1" } }),
  },
  {
    id: "h2",
    title: "Heading 2",
    keywords: ["heading", "h2", "subtitle"],
    run: (ctx) => ctx.dispatch({ t: "setBlockType", payload: { type: "h2" } }),
  },
  {
    id: "h3",
    title: "Heading 3",
    keywords: ["heading", "h3"],
    run: (ctx) => ctx.dispatch({ t: "setBlockType", payload: { type: "h3" } }),
  },
  {
    id: "ul",
    title: "Bulleted list",
    keywords: ["bullet", "list", "ul", "unordered"],
    run: (ctx) => ctx.dispatch({ t: "toggleList", ordered: false }),
  },
  {
    id: "ol",
    title: "Numbered list",
    keywords: ["numbered", "ordered", "ol", "list"],
    run: (ctx) => ctx.dispatch({ t: "toggleList", ordered: true }),
  },
  {
    id: "code",
    title: "Code block",
    keywords: ["code", "pre", "snippet"],
    run: (ctx) => ctx.dispatch({ t: "setBlockType", payload: { type: "code" } }),
  },
  {
    id: "table",
    title: "Table",
    description: "2 × 2 grid you can grow with Tab",
    keywords: ["table", "grid"],
    run: (ctx) => ctx.dispatch({ t: "insertTable", rows: 2, cols: 2 }),
  },
  {
    id: "columns",
    title: "Columns",
    description: "Side-by-side layout",
    keywords: ["columns", "layout", "split"],
    run: (ctx) => ctx.dispatch({ t: "insertColumns", cols: 2 }),
  },
];

/** Default fuzzy filter — case-insensitive substring match against title +
 *  keywords. Plugins can pass a custom matcher via slashCommandsPlugin opts. */
export function defaultFilter(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    if (it.title.toLowerCase().includes(q)) return true;
    if (it.keywords) {
      for (const k of it.keywords) if (k.includes(q)) return true;
    }
    return false;
  });
}
