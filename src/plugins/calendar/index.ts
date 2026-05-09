// ---------------------------------------------------------------------------
// calendarPlugin — example "non-editable" plugin block. Demonstrates the
// `isAtomic` BlockDef contract: a block whose only valid caret positions
// are before / after the block, never inside.
//
// Consumers opt in:
//   import { calendarPlugin } from "creo-edit";
//   createEditor({ plugins: [calendarPlugin()] });
//
// Insert a calendar via the typed command shape:
//   editor.dispatch({
//     t: "calendar.insert",
//     payload: { date: "2026-05-08", days: 7 },
//   });
//
// The plugin also ships a slash-menu item (`calendarSlashItem`) that hosts
// can append to their slash items list.
// ---------------------------------------------------------------------------

import { newBlockId } from "../../model/doc";
import { insertBlocks } from "../../commands/insertCommands";
import type {
  Block,
  BlockSpec,
  CalendarBlock,
  DateMarkerBlock,
} from "../../model/types";
import type {
  BlockDef,
  CommandCtx,
  CommandDef,
  EditorPlugin,
} from "../../plugin/types";
import { CalendarView, DateMarkerView, calendarHelpers } from "./view";
import type { SlashItem } from "../slash/items";
import type { PublicView } from "creo";

type CalendarInsertPayload = { date?: string; days?: number };

function clampDays(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(31, Math.floor(n)));
}

function normalizedDate(s: unknown): string {
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return calendarHelpers.todayIso();
}

function runInsert(ctx: CommandCtx, p: CalendarInsertPayload | undefined): boolean {
  const date = normalizedDate(p?.date);
  const days = clampDays(p?.days);
  const block: BlockSpec = {
    id: newBlockId(),
    type: "calendar",
    date,
    days,
  };
  return insertBlocks(
    { docStore: ctx.docStore, selStore: ctx.selStore },
    [block],
  );
}

const calendarDef: BlockDef<CalendarBlock> = {
  type: "calendar",
  view: CalendarView as PublicView<{ block: CalendarBlock; key?: string }, void>,
  isTextBearing: false,
  isAtomic: true,
  // anchorCodec omitted — Registry.install falls back to atomicCodec for
  // isAtomic blocks without an explicit codec.
  htmlCodec: {
    matchHTML: ["div"],
    parseHTML(el) {
      // Only claim <div> elements that explicitly identify themselves as a
      // calendar block — avoids collision with arbitrary divs.
      if (el.getAttribute("data-block-kind") !== "calendar") return null;
      const date = normalizedDate(el.getAttribute("data-date"));
      const days = clampDays(Number(el.getAttribute("data-days")));
      return { id: newBlockId(), type: "calendar", date, days };
    },
    serializeHTML(b) {
      const cb = b as CalendarBlock;
      return `<div data-block-kind="calendar" data-date="${cb.date}" data-days="${cb.days}"></div>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const cb = b as CalendarBlock;
      return { id: cb.id, type: "calendar", date: cb.date, days: cb.days };
    },
    deserialize(s, id) {
      const sb = s as { date?: string; days?: number };
      return {
        id,
        type: "calendar",
        date: normalizedDate(sb.date),
        days: clampDays(sb.days),
      } as BlockSpec;
    },
  },
};

function runDateMarkerInsert(ctx: CommandCtx, p: { date?: string } | undefined): boolean {
  const date = normalizedDate(p?.date);
  const block: BlockSpec = {
    id: newBlockId(),
    type: "date-marker",
    date,
  };
  return insertBlocks(
    { docStore: ctx.docStore, selStore: ctx.selStore },
    [block],
  );
}

const dateMarkerDef: BlockDef<DateMarkerBlock> = {
  type: "date-marker",
  view: DateMarkerView as PublicView<{ block: DateMarkerBlock; key?: string }, void>,
  isTextBearing: false,
  isAtomic: true,
  htmlCodec: {
    matchHTML: ["div"],
    parseHTML(el) {
      if (el.getAttribute("data-block-kind") !== "date-marker") return null;
      const date = normalizedDate(el.getAttribute("data-date"));
      return { id: newBlockId(), type: "date-marker", date };
    },
    serializeHTML(b) {
      const dm = b as DateMarkerBlock;
      return `<div data-block-kind="date-marker" data-date="${dm.date}"></div>`;
    },
  },
  serializeCodec: {
    serialize(b) {
      const dm = b as DateMarkerBlock;
      return { id: dm.id, type: "date-marker", date: dm.date };
    },
    deserialize(s, id) {
      const sb = s as { date?: string };
      return {
        id,
        type: "date-marker",
        date: normalizedDate(sb.date),
      } as BlockSpec;
    },
  },
};

const calendarCommands: CommandDef<unknown>[] = [
  {
    t: "calendar.insert",
    run: (ctx, p) => runInsert(ctx, (p ?? {}) as CalendarInsertPayload),
  },
  {
    t: "dateMarker.insert",
    run: (ctx, p) => runDateMarkerInsert(ctx, (p ?? {}) as { date?: string }),
  },
];

/** Slash-menu item — append to your slash items array to expose calendar
 *  insertion at the `/` trigger. */
export const calendarSlashItem: SlashItem = {
  id: "calendar",
  title: "Calendar",
  description: "Insert a non-editable calendar block",
  keywords: ["calendar", "date", "schedule", "week"],
  run: (ctx) => ctx.dispatch({ t: "calendar.insert", payload: {} }),
};

export function calendarPlugin(): EditorPlugin {
  return {
    name: "calendar",
    blocks: [
      calendarDef as BlockDef<Block>,
      dateMarkerDef as BlockDef<Block>,
    ],
    commands: calendarCommands,
  };
}

export { CalendarView, DateMarkerView, calendarHelpers } from "./view";
