// ---------------------------------------------------------------------------
// Gantt charts.
//
//   gantt
//     title Release
//     dateFormat YYYY-MM-DD
//     section Build
//     Design    :done, d1, 2026-01-05, 5d
//     Implement :active, after d1, 10d
//     Test      :3d
//
// A task is a line: its name, a colon, then up to three things after any
// marks (`done`, `active`, `crit`, `milestone`) — and HOW MANY there are says
// what they are:
//
//   one     when it ends (a length, or a date); it starts where the task
//           before it ends
//   two     when it starts, when it ends
//   three   its id, when it starts, when it ends
//
// So a task has an id only together with a start, and "after the one before"
// is said by leaving the start out — which a task with an id cannot do. Both
// show in `setStart`: naming the task another comes after may have to give it
// an id, and a start with it.
//
// Every edit here changes one of those things and leaves the rest of the line
// as it is written: two people setting one task's start and its length at
// once both keep theirs.
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

export const GANTT_FLAGS = [
  { key: "active", label: "Active" },
  { key: "done", label: "Done" },
  { key: "crit", label: "Critical" },
  { key: "milestone", label: "Milestone" },
] as const;

export const GANTT_FIELDS = [
  {
    key: "start",
    label: "Start",
    placeholder: "after previous",
    hint: "A date, or “after” and another task's name. Empty: after the task before it.",
  },
  {
    key: "length",
    label: "Length",
    placeholder: "1d",
    hint: "How long it takes — 5d, 2w, 12h — or the date it ends.",
  },
] as const;

/** Words before a task's values that mark it, not time it. */
const MARKS = ["active", "done", "crit", "milestone", "vert"];

/** Lines that set the chart up. */
const SETTING =
  /^(dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|weekend|displayMode|inclusiveEndDates|topAxis|click)(\s|$)/i;

type Span = { start: number; end: number };
type Token = Span & { text: string };
type Named = Span & { line: number; label: string };

export type Task = Named & {
  indent: string;
  /** Where its values start: after the colon. */
  metaStart: number;
  marks: Token[];
  id: Token | null;
  from: Token | null;
  until: Token | null;
};

export type Gantt = {
  title: Named | null;
  sections: Named[];
  tasks: Task[];
};

function tokens(text: string, at: number): Token[] {
  const out: Token[] = [];
  let pos = 0;
  for (const part of text.split(",")) {
    const span = trimmedSpan(part, at + pos);
    if (span.end > span.start) out.push({ text: part.trim(), ...span });
    pos += part.length + 1;
  }
  return out;
}

function readTask(line: Line): Task | null {
  const colon = line.text.indexOf(":", line.indent.length);
  const name = colon < 0 ? "" : line.text.slice(line.indent.length, colon);
  if (name.trim() === "") return null;
  const metaStart = line.start + colon + 1;
  const all = tokens(line.text.slice(colon + 1), metaStart);
  let n = 0;
  while (n < all.length && MARKS.includes(all[n]!.text)) n++;
  const values = all.slice(n);
  const [a, b, c] = values;
  return {
    line: line.index,
    label: decodeLabel(name.trim()),
    ...trimmedSpan(name, line.start + line.indent.length),
    indent: line.indent,
    metaStart,
    marks: all.slice(0, n),
    id: values.length >= 3 ? a! : null,
    from: values.length >= 3 ? b! : values.length === 2 ? a! : null,
    until: values.length >= 3 ? c! : values.length === 2 ? b! : (a ?? null),
  };
}

function named(line: Line, keyword: number): Named | null {
  const rest = line.text.slice(line.indent.length + keyword);
  const span = trimmedSpan(rest, line.start + line.indent.length + keyword);
  if (span.end === span.start) return null;
  return { line: line.index, label: decodeLabel(rest.trim()), ...span };
}

export function readGantt(result: VisimerResult): Gantt {
  const out: Gantt = { title: null, sections: [], tasks: [] };
  for (const line of statements(result)) {
    const text = line.text.trim();
    if (SETTING.test(text) || /^(accTitle|accDescr)\s*[:{]/i.test(text)) continue;
    if (/^title(\s|$)/i.test(text)) {
      out.title = named(line, 5) ?? out.title;
      continue;
    }
    if (/^section(\s|$)/i.test(text)) {
      const section = named(line, 7);
      if (section) out.sections.push(section);
      continue;
    }
    const task = readTask(line);
    if (task) out.tasks.push(task);
  }
  return out;
}

const taskId = (line: number): string => `task:${line}`;

function taskOf(g: Gantt, entity: Entity): number {
  const line = lineOfId(entity.id);
  return entity.kind === "node" ? g.tasks.findIndex((t) => t.line === line) : -1;
}

/** What a task's name cannot hold: a colon ends it. */
const NAME_CHARS = ":#;";

/** A value among a task's values: no comma, no colon, one line. */
const value = (text: string): string => oneLine(text).replace(/[,:]/g, "").trim();

function add(result: VisimerResult, label: string, from: Entity | null): Compiled | null {
  const g = readGantt(result);
  const lines = linesOf(result);
  const words = encodeLabel(oneLine(label), NAME_CHARS);
  if (!words) return null;
  const sibling = from ? g.tasks[taskOf(g, from)] : null;
  if (from && !sibling) return null;
  const last = g.tasks[g.tasks.length - 1];
  const all = statements(result);
  const header = headerOf(result);
  // After the task it was added from; else at the end of the chart.
  const at = sibling ? lines[sibling.line] : (all[all.length - 1] ?? header ?? undefined);
  if (!at) return null;
  const indent = sibling?.indent ?? last?.indent ?? (at === header ? `${at.indent}  ` : at.indent);
  return {
    edits: [lineAfter(at, `${indent}${words} :1d`)],
    created: [taskId(at.index + 1)],
  };
}

function rename(result: VisimerResult, entity: Entity, label: string): Compiled | null {
  const g = readGantt(result);
  const text = oneLine(label);
  if (!text) return null;
  const line = lineOfId(entity.id);
  if (entity.sub === "title") {
    if (!g.title || g.title.line !== line) return null;
    return { edits: [{ start: g.title.start, end: g.title.end, text: encodeLabel(text, "#;") }] };
  }
  if (entity.sub === "section") {
    const section = g.sections.find((s) => s.line === line);
    if (!section) return null;
    return { edits: [{ start: section.start, end: section.end, text: encodeLabel(text, "#;") }] };
  }
  const task = g.tasks[taskOf(g, entity)];
  if (!task) return null;
  return { edits: [{ start: task.start, end: task.end, text: encodeLabel(text, NAME_CHARS) }] };
}

function remove(result: VisimerResult, entity: Entity): Compiled | null {
  const line = lineOfId(entity.id);
  const g = readGantt(result);
  const there =
    entity.sub === "title"
      ? g.title?.line === line
      : entity.sub === "section"
        ? g.sections.some((s) => s.line === line)
        : taskOf(g, entity) >= 0;
  const edit = there && line !== null ? removeLines(result, line, line) : null;
  return edit ? { edits: [edit] } : null;
}

function setFlag(result: VisimerResult, entity: Entity, flag: string, on: boolean): Compiled | null {
  const g = readGantt(result);
  const task = g.tasks[taskOf(g, entity)];
  if (!task || !GANTT_FLAGS.some((f) => f.key === flag)) return null;
  const first = task.marks[0] ?? task.id ?? task.from ?? task.until;
  if (!first) return null;
  // A mark, with the comma and the space after it.
  const drop = (mark: Token): TextEdit => {
    const all = [...task.marks, task.id, task.from, task.until].filter((t): t is Token => !!t);
    const next = all[all.indexOf(mark) + 1];
    return { start: mark.start, end: next ? next.start : mark.end, text: "" };
  };
  const has = (key: string): Token | undefined => task.marks.find((m) => m.text === key);
  const mine = has(flag);
  if (!on) return mine ? { edits: [drop(mine)] } : null;
  if (mine) return null;
  const edits: TextEdit[] = [{ start: first.start, end: first.start, text: `${flag}, ` }];
  // A task is under way or it is finished.
  const other = flag === "active" ? has("done") : flag === "done" ? has("active") : undefined;
  if (other) edits.push(drop(other));
  return { edits };
}

const UNITS: Record<string, string> = {
  ms: "ms",
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s",
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
  w: "w", wk: "w", wks: "w", week: "w", weeks: "w",
  M: "M", month: "M", months: "M",
  y: "y", yr: "y", yrs: "y", year: "y", years: "y",
};

/** `5`, `5 days`, `2 Weeks` → `5d`, `5d`, `2w`; anything else as typed. */
function lengthOf(text: string): string {
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(text);
  if (!m) return text;
  const unit = m[2] === "" ? "d" : (UNITS[m[2]!] ?? UNITS[m[2]!.toLowerCase()]);
  return unit ? `${m[1]}${unit}` : text;
}

function setLength(result: VisimerResult, entity: Entity, typed: string): Compiled | null {
  const g = readGantt(result);
  const task = g.tasks[taskOf(g, entity)];
  const text = lengthOf(value(typed));
  if (!task || !text) return null;
  if (task.until) return { edits: [{ start: task.until.start, end: task.until.end, text }] };
  // A colon with nothing after it yet.
  return { edits: [{ start: task.metaStart, end: task.metaStart, text: ` ${text}` }] };
}

function setStart(
  result: VisimerResult,
  entity: Entity,
  typed: string,
  newId: () => string | undefined,
): Compiled | null {
  const g = readGantt(result);
  const index = taskOf(g, entity);
  const task = g.tasks[index];
  if (!task || !task.until) return null;
  const edits: TextEdit[] = [];
  const taken = new Set(g.tasks.map((t) => t.id?.text).filter((id): id is string => !!id));
  const given = new Map<number, string>();

  const fresh = (): string => {
    const own = newId();
    let id = own && /^[\w-]+$/.test(own) && !taken.has(own) ? own : "";
    for (let n = 1; !id; n++) if (!taken.has(`t${n}`)) id = `t${n}`;
    taken.add(id);
    return id;
  };
  // The id of task `k`, giving it one if it has none — and with it a start,
  // which for a task that had only a length is "after the one before it":
  // that one's id, and so on up.
  const idOf = (k: number): string | null => {
    const t = g.tasks[k];
    if (!t || !t.until || k === index) return null;
    if (t.id) return t.id.text;
    const had = given.get(k);
    if (had) return had;
    if (t.from) {
      const id = fresh();
      edits.push({ start: t.from.start, end: t.from.start, text: `${id}, ` });
      given.set(k, id);
      return id;
    }
    const before = idOf(k - 1);
    if (!before) return null;
    const id = fresh();
    edits.push({ start: t.until.start, end: t.until.start, text: `${id}, after ${before}, ` });
    given.set(k, id);
    return id;
  };

  let text = value(typed);
  const after = /^after\s+(.+)$/i.exec(text);
  if (after) {
    const said = after[1]!.trim();
    const words = said.split(/\s+/);
    if (words.every((w) => taken.has(w) && w !== task.id?.text)) {
      text = `after ${words.join(" ")}`;
    } else {
      // Not ids: a task's name.
      const k = g.tasks.findIndex(
        (t, i) => i !== index && t.label.toLowerCase() === said.toLowerCase(),
      );
      const id = k < 0 ? null : idOf(k);
      if (!id) return null;
      text = `after ${id}`;
    }
  } else if (text === "") {
    if (!task.from) return null;
    if (!task.id) {
      // Start and end: without the start it is the end alone.
      edits.push({ start: task.from.start, end: task.until.start, text: "" });
      return { edits };
    }
    // With an id it has to say so.
    const before = idOf(index - 1);
    if (!before) return null;
    text = `after ${before}`;
  }
  if (task.from) edits.push({ start: task.from.start, end: task.from.end, text });
  else edits.push({ start: task.until.start, end: task.until.start, text: `${text}, ` });
  return { edits };
}

function entities(result: VisimerResult): Entities {
  const g = readGantt(result);
  const flags = GANTT_FLAGS.map((f) => f.key as string);
  const group = (n: Named, sub: string): Entity => ({
    id: `${sub}:${n.line}`,
    kind: "group",
    ref: `${sub}:${n.line}`,
    domId: "",
    label: n.label,
    sub,
  });
  return {
    nodes: g.tasks.map((t) => ({
      id: taskId(t.line),
      kind: "node" as const,
      ref: taskId(t.line),
      domId: t.id?.text ?? "",
      label: t.label,
      flags: t.marks.map((m) => m.text).filter((m) => flags.includes(m)),
      fields: { start: t.from?.text ?? "", length: t.until?.text ?? "" },
    })),
    edges: [],
    groups: [...(g.title ? [group(g.title, "title")] : []), ...g.sections.map((s) => group(s, "section"))],
  };
}

export const gantt: DiagramKit = {
  type: "gantt",
  item: "task",
  newLabel: "New task",
  hint: "list",
  positional: true,
  nodeSelector: ".pele-task",
  edgeSelector: ".pele-none",
  edgeOrder: "dom",
  entities,
  direction: () => null,
  add: (label, _id, from): TextOp => (r) => add(r, label, from ?? null),
  addAfter: (e, label): TextOp | null => (e.kind === "node" ? (r) => add(r, label, e) : null),
  addLabel: () => "Add a task after this one",
  rename: (e, label): TextOp => (r) => rename(r, e, label),
  remove: (e): TextOp => (r) => remove(r, e),
  flags: GANTT_FLAGS,
  setFlag: (e, flag, on): TextOp => (r) => setFlag(r, e, flag, on),
  fields: GANTT_FIELDS,
  setField: (e, field, typed, newId): TextOp => (r) =>
    field === "start" ? setStart(r, e, typed, newId) : field === "length" ? setLength(r, e, typed) : null,
  // Pele draws the tasks in the order they are written and tags each with
  // its id — its own count (`task1`) for one that has none. Paired by order;
  // an id that is written must agree.
  correlate(svg, ents, tag) {
    const drawn = Array.from(svg.querySelectorAll(".pele-task"));
    const agree =
      drawn.length === ents.nodes.length &&
      ents.nodes.every((n, i) => n.domId === "" || drawn[i]!.getAttribute("data-id") === n.domId);
    if (agree) ents.nodes.forEach((n, i) => tag(drawn[i]!, n));
    tagNamed(
      Array.from(svg.querySelectorAll(".pele-section-label")),
      ents.groups.filter((s) => s.sub === "section"),
      tag,
    );
    const title = ents.groups.find((s) => s.sub === "title");
    const drawnTitle = svg.querySelector(".pele-title");
    if (title && drawnTitle) tag(drawnTitle, title);
  },
  // Rows are tight; beside a bar there is room.
  side: () => "right",
};
