// ---------------------------------------------------------------------------
// Timelines.
//
//   timeline
//     title History
//     section Early
//     2019 : Idea
//          : Prototype
//     2021 : Launch : Mobile app
//
// A period is a line; what happened in it follows a `: ` — on its line, or on
// lines of their own that start with one. So a period owns several lines, and
// an event is a stretch of one. Sections are a line each, over the periods
// written after them; removing one removes the heading, not the periods.
//
// What is added is added as a line of its own (an event as `: New event`
// under its period), never tacked onto a line that is there: two people
// adding an event to one period at once then add two lines.
// ---------------------------------------------------------------------------

import type { DiagramKit, Entities, Entity, VisimerResult } from "./kits";
import {
  decodeLabel,
  encodeLabel,
  headerOf,
  lineAfter,
  lineOfId,
  linesOf,
  oneLine,
  removeLines,
  statements,
  tagNamed,
  trimmedSpan,
  type Compiled,
  type Line,
  type TextEdit,
  type TextOp,
} from "./textkit";

const NEW_EVENT = "New event";

type Named = { line: number; label: string; start: number; end: number };

export type TimelineEvent = {
  line: number;
  /** Which of its line's events it is. */
  index: number;
  label: string;
  /** Its words. */
  start: number;
  end: number;
  /** Where what is before it on its line ends: removing it removes from
   *  here, its colon included. */
  cut: number;
};

export type Period = Named & {
  indent: string;
  /** Column of the colon its first event follows, or -1. */
  colon: number;
  /** Its own line and the lines of events under it. */
  lines: number[];
  events: TimelineEvent[];
};

export type Timeline = {
  title: Named | null;
  sections: Named[];
  periods: Period[];
};

/** Offsets in `text` of each colon that starts an event: one followed by a
 *  space, or ending the line. A colon inside words (`10:30`) is words. */
function separators(text: string, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i < text.length; i++) {
    if (text[i] === ":" && (i + 1 === text.length || /\s/.test(text[i + 1]!))) out.push(i);
  }
  return out;
}

/** The events on `line`, from its colon at `first` on. `cut`: where what is
 *  before the first of them ends. */
function readEvents(line: Line, first: number, cut: number): TimelineEvent[] {
  const text = line.text;
  // A period's own colon starts an event whatever follows it.
  const at = [first, ...separators(text, first + 1)];
  const out: TimelineEvent[] = [];
  let before = cut;
  at.forEach((colon, i) => {
    const until = at[i + 1] ?? text.length;
    const words = text.slice(colon + 1, until);
    // A colon the line ends with starts nothing.
    if (i === at.length - 1 && words.trim() === "") return;
    const span = trimmedSpan(words, line.start + colon + 1);
    out.push({
      line: line.index,
      index: out.length,
      label: decodeLabel(words.trim()),
      start: span.start,
      end: span.end,
      cut: before,
    });
    before = span.end;
  });
  return out;
}

function named(line: Line, keyword: number): Named | null {
  const rest = line.text.slice(line.indent.length + keyword);
  const span = trimmedSpan(rest, line.start + line.indent.length + keyword);
  if (span.end === span.start) return null;
  return { line: line.index, label: decodeLabel(rest.trim()), ...span };
}

export function readTimeline(result: VisimerResult): Timeline {
  const out: Timeline = { title: null, sections: [], periods: [] };
  for (const line of statements(result)) {
    const text = line.text.trim();
    const at = line.start + line.indent.length;
    if (/^(accTitle|accDescr)\s*[:{]/i.test(text)) continue;
    if (/^title(\s|$)/i.test(text)) {
      out.title = named(line, 5) ?? out.title;
      continue;
    }
    if (/^section(\s|$)/i.test(text)) {
      const section = named(line, 7);
      if (section) out.sections.push(section);
      continue;
    }
    if (text.startsWith(":")) {
      // More of the period before it — also past a section's heading.
      const period = out.periods[out.periods.length - 1];
      if (!period) continue;
      period.lines.push(line.index);
      period.events.push(...readEvents(line, line.indent.length, at));
      continue;
    }
    const colon = line.text.indexOf(":", line.indent.length);
    const name = colon < 0 ? line.text.slice(line.indent.length) : line.text.slice(line.indent.length, colon);
    const span = trimmedSpan(name, at);
    out.periods.push({
      line: line.index,
      label: decodeLabel(name.trim()),
      ...span,
      indent: line.indent,
      colon,
      lines: [line.index],
      events: colon < 0 ? [] : readEvents(line, colon, span.end),
    });
  }
  return out;
}

const periodId = (line: number): string => `period:${line}`;
const eventId = (line: number, index: number): string => `event:${line}:${index}`;

/** The period an entity is, or is an event of. */
function periodOf(t: Timeline, entity: Entity): Period | null {
  const line = lineOfId(entity.id);
  if (entity.sub === "period") return t.periods.find((p) => p.line === line) ?? null;
  return t.periods.find((p) => p.events.some((e) => eventOf(e, entity))) ?? null;
}

const eventOf = (e: TimelineEvent, entity: Entity): boolean =>
  entity.id === eventId(e.line, e.index);

/** What a period's or a section's name cannot hold: a colon ends it. */
const NAME_CHARS = ":#;";

/** An event's words: a colon in them is words unless a space follows it. */
function eventWords(label: string): string {
  return encodeLabel(label, "#;").replace(/:(?=\s|$)/g, "#58;");
}

function addEvent(result: VisimerResult, to: Entity): Compiled | null {
  const period = periodOf(readTimeline(result), to);
  const lines = linesOf(result);
  const last = period && lines[period.lines[period.lines.length - 1]!];
  if (!period || !last) return null;
  // Under the colon of the line before, as a timeline is written by hand.
  const pad =
    last.index !== period.line
      ? last.indent
      : period.colon > period.indent.length
        ? period.indent + " ".repeat(period.colon - period.indent.length)
        : `${period.indent}  `;
  return {
    edits: [lineAfter(last, `${pad}: ${eventWords(NEW_EVENT)}`)],
    created: [eventId(last.index + 1, 0)],
  };
}

function addPeriod(result: VisimerResult, label: string, after: Entity | null): Compiled | null {
  const t = readTimeline(result);
  const lines = linesOf(result);
  const words = encodeLabel(oneLine(label), NAME_CHARS);
  if (!words) return null;
  const sibling = after ? periodOf(t, after) : null;
  if (after && !sibling) return null;
  let at: Line | undefined;
  let indent: string;
  if (sibling) {
    at = lines[sibling.lines[sibling.lines.length - 1]!];
    indent = sibling.indent;
  } else {
    const all = statements(result);
    const header = headerOf(result);
    at = all[all.length - 1] ?? header ?? undefined;
    indent = t.periods[t.periods.length - 1]?.indent ?? `${header?.indent ?? ""}  `;
  }
  if (!at) return null;
  return { edits: [lineAfter(at, `${indent}${words}`)], created: [periodId(at.index + 1)] };
}

function rename(result: VisimerResult, entity: Entity, label: string): Compiled | null {
  const t = readTimeline(result);
  const text = oneLine(label);
  if (!text) return null;
  const line = lineOfId(entity.id);
  let span: { start: number; end: number } | null = null;
  let words = encodeLabel(text, NAME_CHARS);
  if (entity.sub === "title") {
    span = t.title && t.title.line === line ? t.title : null;
    words = encodeLabel(text, "#;");
  } else if (entity.sub === "section") {
    span = t.sections.find((s) => s.line === line) ?? null;
  } else if (entity.sub === "period") {
    span = t.periods.find((p) => p.line === line) ?? null;
  } else {
    for (const p of t.periods) span = p.events.find((e) => eventOf(e, entity)) ?? span;
    words = eventWords(text);
  }
  if (!span) return null;
  // Words right after a colon need the space that makes it one.
  const code = typeof result.code === "string" ? result.code : "";
  const tight = entity.sub === "event" && code[span.start - 1] === ":";
  return { edits: [{ start: span.start, end: span.end, text: tight ? ` ${words}` : words }] };
}

function remove(result: VisimerResult, entity: Entity): Compiled | null {
  const t = readTimeline(result);
  const line = lineOfId(entity.id);
  if (line === null) return null;
  const whole = (from: number, to: number): TextEdit[] => {
    const edit = removeLines(result, from, to);
    return edit ? [edit] : [];
  };
  let edits: TextEdit[] = [];
  if (entity.sub === "title" || entity.sub === "section") {
    edits = whole(line, line);
  } else if (entity.sub === "period") {
    const period = t.periods.find((p) => p.line === line);
    if (!period) return null;
    // Its lines, run by run: a section's heading can stand between them.
    let from = period.lines[0]!;
    let to = from;
    for (const next of period.lines.slice(1)) {
      if (next === to + 1) {
        to = next;
        continue;
      }
      edits.push(...whole(from, to));
      from = to = next;
    }
    edits.push(...whole(from, to));
  } else {
    const period = periodOf(t, entity);
    const event = period?.events.find((e) => eventOf(e, entity));
    if (!period || !event) return null;
    const alone = period.events.filter((e) => e.line === event.line).length === 1;
    edits =
      alone && event.line !== period.line
        ? whole(event.line, event.line)
        : [{ start: event.cut, end: event.end, text: "" }];
  }
  return edits.length > 0 ? { edits } : null;
}

function entities(result: VisimerResult): Entities {
  const t = readTimeline(result);
  const nodes: Entity[] = [];
  for (const p of t.periods) {
    const id = periodId(p.line);
    nodes.push({ id, kind: "node", ref: id, domId: "", label: p.label, sub: "period" });
    for (const e of p.events) {
      const eid = eventId(e.line, e.index);
      nodes.push({ id: eid, kind: "node", ref: eid, domId: "", label: e.label, sub: "event" });
    }
  }
  const group = (n: Named, sub: string): Entity => ({
    id: `${sub}:${n.line}`,
    kind: "group",
    ref: `${sub}:${n.line}`,
    domId: "",
    label: n.label,
    sub,
  });
  return {
    nodes,
    edges: [],
    groups: [...(t.title ? [group(t.title, "title")] : []), ...t.sections.map((s) => group(s, "section"))],
  };
}

export const timeline: DiagramKit = {
  type: "timeline",
  item: "period",
  newLabel: "New period",
  hint: "tree",
  positional: true,
  nodeSelector: ".pele-period, .pele-event",
  edgeSelector: ".pele-none",
  edgeOrder: "dom",
  entities,
  direction: () => null,
  // From a period or one of its events: an event of that period. From
  // nothing: the next period.
  add: (label, _id, from): TextOp => (r) => (from ? addEvent(r, from) : addPeriod(r, label, null)),
  addAfter: (e, label): TextOp | null =>
    e.sub === "period" ? (r) => addPeriod(r, label, e) : e.sub === "event" ? (r) => addEvent(r, e) : null,
  // An event's + would sit on the event under it; its period has one.
  addLabel: (e) => (e.sub === "period" ? "Add an event" : null),
  rename: (e, label): TextOp => (r) => rename(r, e, label),
  remove: (e): TextOp => (r) => remove(r, e),
  // Pele tags a period with its words (two can share them) and an event
  // with nothing, but draws each event inside its period, in order.
  correlate(svg, ents, tag) {
    const periods = Array.from(svg.querySelectorAll(".pele-period"));
    const written = ents.nodes.filter((n) => n.sub === "period");
    if (periods.length === written.length) {
      let at = -1;
      const events: Entity[][] = [];
      for (const n of ents.nodes) {
        if (n.sub === "period") events[++at] = [];
        else events[at]?.push(n);
      }
      written.forEach((p, i) => {
        tag(periods[i]!, p);
        const drawn = Array.from(periods[i]!.querySelectorAll(".pele-event"));
        if (drawn.length === events[i]!.length) events[i]!.forEach((e, k) => tag(drawn[k]!, e));
      });
    }
    tagNamed(
      Array.from(svg.querySelectorAll(".pele-section")),
      ents.groups.filter((g) => g.sub === "section"),
      tag,
    );
    const title = ents.groups.find((g) => g.sub === "title");
    const drawnTitle = svg.querySelector(".pele-title");
    if (title && drawnTitle) tag(drawnTitle, title);
  },
  side: () => "bottom",
};
