// ---------------------------------------------------------------------------
// CalendarView — non-editable atomic block. Renders one row per day,
// labelled "Wed, Apr 30" style. The current calendar date (in the local
// timezone) gets a `is-today` class so consumers can highlight it.
//
// `contenteditable="false"` on the outer element makes the browser skip
// the caret over the block; combined with isAtomic the editor treats
// caret hits inside the calendar as side 0 / side 1 edges.
// ---------------------------------------------------------------------------

import { _, div, span, view } from "creo";
import type { CalendarBlock, DateMarkerBlock } from "../../model/types";

const DAY_NAMES_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function todayIso(): string {
  const d = new Date();
  return formatIso(d);
}

function formatIso(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseIso(s: string): Date {
  // Treat the ISO date as a *local* date — using `new Date(s)` would
  // interpret it as UTC midnight which can shift the day by one in some
  // timezones.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export const CalendarView = view<{ block: CalendarBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    const start = parseIso(b.date);
    const today = todayIso();
    div(
      {
        "data-block-id": b.id,
        "data-block-kind": "calendar",
        // Atomic island — the browser places the caret around the block,
        // not inside it.
        contenteditable: "false",
        class: "ce-block ce-calendar",
      },
      () => {
        // Header line: month + year of the anchor day. Helps when the
        // calendar shows a span (e.g. last week of April + first of May).
        div({ class: "ce-calendar-header" }, () => {
          const m = MONTH_NAMES_SHORT[start.getMonth()];
          span({}, `${m ?? ""} ${start.getFullYear()}`);
        });
        // One row per day. Plain div per row; no `data-side` markers
        // needed because the generic atomicCodec falls back to "halves
        // of the block" hit-testing.
        for (let i = 0; i < b.days; i++) {
          const d = addDays(start, i);
          const iso = formatIso(d);
          const isToday = iso === today;
          const cls = isToday
            ? "ce-calendar-row is-today"
            : "ce-calendar-row";
          div({ class: cls, key: iso, "data-iso": iso }, () => {
            span({ class: "ce-calendar-dow" }, () => {
              const long = DAY_NAMES_LONG[d.getDay()];
              const short = DAY_NAMES_SHORT[d.getDay()];
              span({ "aria-hidden": "true" }, short ?? "");
              span({ class: "ce-sr-only" }, long ?? "");
            });
            span({ class: "ce-calendar-date" }, () => {
              const m = MONTH_NAMES_SHORT[d.getMonth()];
              span({}, `${m ?? ""} ${d.getDate()}`);
            });
          });
        }
        void _;
      },
    );
  },
}));

/**
 * DateMarkerView — slim non-editable atomic block that renders a single
 * "Wednesday, 2 Sep." line. Used as a separator block in journal /
 * planner UX where the user writes editable paragraphs between days.
 */
export const DateMarkerView = view<{ block: DateMarkerBlock }>(({ props }) => ({
  shouldUpdate(next) {
    return next.block !== props().block;
  },
  render() {
    const b = props().block;
    const d = parseIso(b.date);
    const today = todayIso();
    const dow = DAY_NAMES_LONG[d.getDay()] ?? "";
    const month = MONTH_NAMES_SHORT[d.getMonth()] ?? "";
    const label = `${dow}, ${d.getDate()} ${month}.`;
    const cls =
      b.date === today ? "ce-block ce-date-marker is-today" : "ce-block ce-date-marker";
    div(
      {
        "data-block-id": b.id,
        "data-block-kind": "date-marker",
        "data-iso": b.date,
        contenteditable: "false",
        class: cls,
      },
      () => {
        span({}, label);
        void _;
      },
    );
  },
}));

// Re-exports useful for plugin consumers building related UI.
export const calendarHelpers = {
  todayIso,
  formatIso,
  parseIso,
  addDays,
};
