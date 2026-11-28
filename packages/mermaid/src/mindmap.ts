// ---------------------------------------------------------------------------
// Mind maps.
//
// A mind map's source is an outline: a line is an idea, its indent says whose
// it is. So there are no arrows to select and nothing to connect — an idea is
// added UNDER one (a line after its last descendant, one step deeper) or
// AFTER one (same place, same depth), and removed with everything under it.
//
//   mindmap
//     root((Project))
//       Plan
//         Scope
//       b1[Build]
//       ::icon(fa fa-wrench)
//
// An idea is `id` + a shape's brackets around its words, or the bare words
// (the default shape). Nothing refers to an id, so one is kept when it is
// there and never invented. `::icon(…)` and `:::class` lines dress the idea
// before them and go where it goes.
// ---------------------------------------------------------------------------

import type { DiagramKit, Entities, Entity, VisimerResult } from "./kits";
import type { DropPlace } from "./kits";
import {
  codeOf,
  decodeLabel,
  diffEdit,
  encodeLabel,
  headerOf,
  lineAfter,
  lineOfId,
  linesOf,
  oneLine,
  removeLines,
  statements,
  type Compiled,
  type Line,
  type TextEdit,
  type TextOp,
} from "./textkit";

export const MINDMAP_SHAPES = [
  { key: "default", label: "Plain" },
  { key: "rect", label: "Square" },
  { key: "round", label: "Rounded" },
  { key: "circle", label: "Circle" },
  { key: "hexagon", label: "Hexagon" },
  { key: "cloud", label: "Cloud" },
  { key: "bang", label: "Bang" },
] as const;

// Longest opener first: `((` before `(`, `))` before `)`.
const BRACKETS: readonly { key: string; open: string; close: string }[] = [
  { key: "circle", open: "((", close: "))" },
  { key: "bang", open: "))", close: "((" },
  { key: "hexagon", open: "{{", close: "}}" },
  { key: "cloud", open: ")", close: "(" },
  { key: "rect", open: "[", close: "]" },
  { key: "round", open: "(", close: ")" },
];

/** What bare words, and words between unquoted brackets, cannot hold. */
const BRACKET_CHARS = "()[]{}";

export type Idea = {
  /** The line it is on. */
  line: number;
  indent: string;
  /** Index of its parent in the list, -1 for the root. */
  parent: number;
  /** Written before the shape's bracket, or "". */
  id: string;
  shape: string;
  /** What it says, as a person reads it. */
  label: string;
  /** Its words are in quotes (inside its brackets). */
  quoted: boolean;
  /** The whole idea on its line: id, brackets, words. */
  start: number;
  end: number;
  /** Its words, quotes included. */
  wordsStart: number;
  wordsEnd: number;
  /** The last line that is its own: itself or a decoration under it. */
  ownLast: number;
  /** The last line of everything under it. */
  last: number;
};

const isDecoration = (text: string): boolean => /^::icon\(|^:::/.test(text);

function readIdea(line: Line): Omit<Idea, "parent" | "ownLast" | "last"> {
  const text = line.text.trim();
  const start = line.start + line.indent.length;
  const end = start + text.length;
  const base = { line: line.index, indent: line.indent, start, end };
  const m = /^([^\s()[\]{}]*)(\(\(|\)\)|\{\{|\)|\[|\()/.exec(text);
  const shape = m && BRACKETS.find((b) => b.open === m[2]);
  if (m && shape && text.endsWith(shape.close)) {
    const from = m[0].length;
    const to = text.length - shape.close.length;
    if (to >= from) {
      const inner = text.slice(from, to);
      const lead = inner.length - inner.trimStart().length;
      const words = inner.trim();
      const wordsStart = start + from + lead;
      const quoted = words.length >= 2 && words.startsWith('"') && words.endsWith('"');
      return {
        ...base,
        id: m[1] ?? "",
        shape: shape.key,
        label: decodeLabel(quoted ? words.slice(1, -1) : words),
        quoted,
        wordsStart,
        wordsEnd: wordsStart + words.length,
      };
    }
  }
  return {
    ...base,
    id: "",
    shape: "default",
    label: decodeLabel(text),
    quoted: false,
    wordsStart: start,
    wordsEnd: end,
  };
}

/** The ideas of a mind map, in the order they are written. */
export function readMindmap(result: VisimerResult): Idea[] {
  const ideas: Idea[] = [];
  // The ideas on the way down to the one last read.
  const path: number[] = [];
  for (const line of statements(result)) {
    if (isDecoration(line.text.trim())) {
      const owner = ideas[ideas.length - 1];
      if (owner) owner.ownLast = line.index;
      continue;
    }
    const width = line.indent.length;
    while (path.length > 0 && ideas[path[path.length - 1]!]!.indent.length >= width) path.pop();
    ideas.push({
      ...readIdea(line),
      parent: path[path.length - 1] ?? -1,
      ownLast: line.index,
      last: line.index,
    });
    path.push(ideas.length - 1);
  }
  // Children come after their parent, so one pass from the end carries each
  // subtree's last line up.
  for (let i = ideas.length - 1; i >= 0; i--) {
    const idea = ideas[i]!;
    idea.last = Math.max(idea.last, idea.ownLast);
    const parent = ideas[idea.parent];
    if (parent) parent.last = Math.max(parent.last, idea.last);
  }
  return ideas;
}

const ideaId = (line: number): string => `idea:${line}`;

const find = (ideas: Idea[], entity: Entity): { idea: Idea; index: number } | null => {
  const line = lineOfId(entity.id);
  const index = ideas.findIndex((i) => i.line === line);
  return index < 0 ? null : { idea: ideas[index]!, index };
};

/** Bare words, as the source can hold them. */
function bareWords(label: string): string {
  const out = encodeLabel(label, BRACKET_CHARS);
  // Read as a decoration of the idea before, it would not be an idea at all.
  return isDecoration(out) ? `#58;${out.slice(1)}` : out;
}

/** An idea's indent for a child: its children's, or its own and one step.
 *  `but`: a child not to go by (the one being moved there). */
function childIndent(ideas: Idea[], index: number, but?: Idea): string {
  const child = ideas.find((i) => i.parent === index && i !== but);
  if (child) return child.indent;
  const own = ideas[index]!.indent;
  return own + (own.endsWith("\t") ? "\t" : "  ");
}

function addUnder(result: VisimerResult, label: string, parent: Entity | null): Compiled | null {
  const ideas = readMindmap(result);
  const words = bareWords(oneLine(label));
  if (!words) return null;
  const lines = linesOf(result);
  if (ideas.length === 0) {
    const header = headerOf(result);
    if (!header) return null;
    return {
      edits: [lineAfter(header, `${header.indent}  ${words}`)],
      created: [ideaId(header.index + 1)],
    };
  }
  const at = parent ? find(ideas, parent) : { idea: ideas[0]!, index: 0 };
  if (!at) return null;
  const after = lines[at.idea.last];
  if (!after) return null;
  return {
    edits: [lineAfter(after, `${childIndent(ideas, at.index)}${words}`)],
    created: [ideaId(at.idea.last + 1)],
  };
}

function addAfter(result: VisimerResult, label: string, sibling: Entity): Compiled | null {
  const ideas = readMindmap(result);
  const at = find(ideas, sibling);
  if (!at) return null;
  // The root has no sibling: the next one is under it.
  if (at.idea.parent < 0) return addUnder(result, label, sibling);
  const words = bareWords(oneLine(label));
  const after = linesOf(result)[at.idea.last];
  if (!words || !after) return null;
  return {
    edits: [lineAfter(after, `${at.idea.indent}${words}`)],
    created: [ideaId(at.idea.last + 1)],
  };
}

function rename(result: VisimerResult, entity: Entity, label: string): Compiled | null {
  const at = find(readMindmap(result), entity);
  const text = oneLine(label);
  if (!at || !text) return null;
  const { idea } = at;
  const words =
    idea.shape === "default"
      ? bareWords(text)
      : idea.quoted
        ? `"${encodeLabel(text, '"')}"`
        : encodeLabel(text, BRACKET_CHARS);
  return { edits: [{ start: idea.wordsStart, end: idea.wordsEnd, text: words }] };
}

function setShape(result: VisimerResult, entity: Entity, shape: string): Compiled | null {
  const at = find(readMindmap(result), entity);
  if (!at || at.idea.shape === shape) return null;
  const { idea } = at;
  const to = BRACKETS.find((b) => b.key === shape);
  if (!to) {
    if (shape !== "default") return null;
    // Out of its brackets. Quoted words may hold what bare ones cannot, so
    // those are written again; otherwise only the brackets go.
    if (idea.quoted) {
      return { edits: [{ start: idea.start, end: idea.end, text: bareWords(idea.label) }] };
    }
    return {
      edits: [
        { start: idea.start, end: idea.wordsStart, text: "" },
        { start: idea.wordsEnd, end: idea.end, text: "" },
      ],
    };
  }
  // Into brackets, or other brackets: the words stay as they are written.
  const edits: TextEdit[] = [
    { start: idea.start, end: idea.wordsStart, text: `${idea.id}${to.open}` },
    { start: idea.wordsEnd, end: idea.end, text: to.close },
  ];
  return { edits };
}

function remove(result: VisimerResult, entity: Entity): Compiled | null {
  const at = find(readMindmap(result), entity);
  if (!at || at.idea.parent < 0) return null;
  const edit = removeLines(result, at.idea.line, at.idea.last);
  return edit ? { edits: [edit] } : null;
}

/**
 * An idea and all under it, moved: its lines taken out and put back at
 * `place` of `target`, each indented as deep as its new place asks (what
 * is under it keeps its depth below it). The root does not move, and an
 * idea is never put inside itself.
 */
function move(result: VisimerResult, entity: Entity, target: Entity, place: DropPlace): Compiled | null {
  const ideas = readMindmap(result);
  const at = find(ideas, entity);
  const to = find(ideas, target);
  if (!at || !to || at.idea.parent < 0) return null;
  const { idea } = at;
  if (to.idea.line >= idea.line && to.idea.line <= idea.last) return null;
  // Nothing is beside the root: what goes there goes inside it.
  const where = to.idea.parent < 0 ? "inside" : place;
  const code = codeOf(result);
  const lines = code.split("\n");
  const from = idea.line;
  const until = idea.last;
  const indent = where === "inside" ? childIndent(ideas, to.index, idea) : to.idea.indent;
  const block = lines.slice(from, until + 1).map((line) => {
    if (line.trim() === "") return line;
    if (line.startsWith(idea.indent)) return indent + line.slice(idea.indent.length);
    return indent + line.trimStart();
  });
  const rest = [...lines.slice(0, from), ...lines.slice(until + 1)];
  const insert = where === "before" ? to.idea.line : to.idea.last + 1;
  const at2 = insert > until ? insert - (until - from + 1) : insert;
  const next = [...rest.slice(0, at2), ...block, ...rest.slice(at2)].join("\n");
  const edit = diffEdit(code, next);
  return edit ? { edits: [edit], created: [ideaId(at2)] } : null;
}

/** An idea, and what is under it, as an outline: its words, a line each,
 *  two spaces a level deeper. One alone is its words. */
function outline(result: VisimerResult, entity: Entity): string {
  const ideas = readMindmap(result);
  const at = find(ideas, entity);
  if (!at) return entity.label;
  const depth = (i: number): number => (i === at.index ? 0 : depth(ideas[i]!.parent) + 1);
  const out: string[] = [];
  ideas.forEach((idea, i) => {
    if (idea.line < at.idea.line || idea.line > at.idea.last) return;
    out.push(`${"  ".repeat(depth(i))}${idea.label}`);
  });
  return out.join("\n");
}

/** An outline pasted under `target` (the root with none): each line an idea,
 *  as deep below it as it is indented below the outline's first. */
function paste(result: VisimerResult, target: Entity | null, text: string): Compiled | null {
  const rows = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, 200)
    .map((l) => {
      const tabs = l.match(/^[ \t]*/)![0].replace(/\t/g, "  ");
      // A bullet's mark is not words.
      return { depth: tabs.length, words: l.trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, "") };
    });
  if (rows.length === 0) return null;
  const ideas = readMindmap(result);
  const lines = linesOf(result);
  if (ideas.length === 0) return addUnder(result, rows.map((r) => r.words).join(" "), null);
  const at = target ? find(ideas, target) : { idea: ideas[0]!, index: 0 };
  if (!at) return null;
  const base = childIndent(ideas, at.index);
  const step = base.endsWith("\t") ? "\t" : "  ";
  // Levels by how far each line is indented, against the lines above it.
  const stack: number[] = [];
  const out = rows.map((r) => {
    while (stack.length > 0 && stack[stack.length - 1]! >= r.depth) stack.pop();
    const level = stack.length;
    stack.push(r.depth);
    return `${base}${step.repeat(level)}${bareWords(oneLine(r.words))}`;
  });
  const after = lines[at.idea.last];
  if (!after) return null;
  return { edits: [lineAfter(after, out.join("\n"))], created: [ideaId(at.idea.last + 1)] };
}

function entities(result: VisimerResult): Entities {
  const ideas = readMindmap(result);
  return {
    nodes: ideas.map((idea) => ({
      id: ideaId(idea.line),
      kind: "node" as const,
      ref: ideaId(idea.line),
      domId: idea.id,
      label: idea.label,
      shape: idea.shape,
      root: idea.parent < 0,
      ...(idea.parent >= 0 ? { parent: ideaId(ideas[idea.parent]!.line) } : {}),
    })),
    edges: [],
    groups: [],
  };
}

export const mindmap: DiagramKit = {
  type: "mindmap",
  item: "idea",
  newLabel: "New idea",
  hint: "tree",
  positional: true,
  nodeSelector: ".pele-node",
  edgeSelector: ".pele-none",
  edgeOrder: "dom",
  entities,
  direction: () => null,
  add: (label, _id, from): TextOp => (r) => addUnder(r, label, from ?? null),
  addAfter: (e, label): TextOp | null => (e.kind === "node" ? (r) => addAfter(r, label, e) : null),
  addLabel: () => "Add an idea under this one",
  rename: (e, label): TextOp => (r) => rename(r, e, label),
  // The root is the map: it is renamed, not removed.
  remove: (e): TextOp | null => (e.root ? null : (r) => remove(r, e)),
  setShape: (e, shape): TextOp => (r) => setShape(r, e, shape),
  shapes: MINDMAP_SHAPES,
  move: (e, target, place): TextOp => (r) => move(r, e, target, place),
  copyText: (e, r) => outline(r, e),
  paste: (target, text): TextOp => (r) => paste(r, target, text),
  // Pele draws the root last and the others in the order they are written,
  // and tags each with its id or its words — which two ideas can share. So
  // they are paired by order, and an id that is written must agree.
  correlate(svg, ents, tag) {
    const drawn = Array.from(svg.querySelectorAll(".pele-node"));
    const root = drawn.find((el) => el.classList.contains("pele-root"));
    const ordered = root ? [root, ...drawn.filter((el) => el !== root)] : drawn;
    if (ordered.length !== ents.nodes.length) return;
    const agree = ents.nodes.every(
      (n, i) => n.domId === "" || ordered[i]!.getAttribute("data-id") === n.domId,
    );
    if (!agree) return;
    ents.nodes.forEach((n, i) => tag(ordered[i]!, n));
  },
  // Branches leave the root to both sides; the next idea goes further out.
  side(e, centre, ents) {
    if (e.root) return "bottom";
    const root = ents.nodes.find((n) => n.root);
    const own = centre(e);
    const mid = root ? centre(root) : null;
    if (!own || !mid) return "right";
    return own.x < mid.x ? "left" : "right";
  },
};
