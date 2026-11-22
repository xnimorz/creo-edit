// ---------------------------------------------------------------------------
// Diagram kits — what the visual editor knows about each diagram type.
//
// Two libraries meet here. Pele draws the diagram and tags its SVG with the
// ids things have in the source (`<g class="pele-node" data-id="A">`). Visimer
// (`@visimer/core`, headless) parses the same source and turns an operation —
// "rename A", "connect A to B" — into the minimal text edit. A kit says, for
// one diagram type:
//
//   - which things in the source are editable (nodes, edges, groups), read
//     off visimer's graph;
//   - where each of them is in Pele's SVG;
//   - which visimer operation each gesture becomes.
//
// Nodes and groups are matched BY ID. Edges are matched BY ORDER: Pele and
// visimer number a repeated edge differently (`L_A_B_2` vs `edge:A->B#1` for
// the second A→B), but both list edges in source order. When the counts
// disagree the edges of that diagram are simply not selectable — a wrong
// match would edit the wrong line.
// ---------------------------------------------------------------------------

/** What the kits need from `@visimer/core`. Structural — see `types.ts`. */
export type VisimerEditor = {
  readonly code: string;
  readonly result: VisimerResult;
  dispatch(op: Record<string, unknown>): { created?: string[] } | null;
  deleteEntities(ids: string[]): void;
};
export type VisimerModule = {
  MermaidWysiwygEditor: new (options: { code: string }) => VisimerEditor;
};
export type VisimerResult = {
  typeInfo: { id: string; capability: string } | null;
  [graph: string]: unknown;
};

export type EntityKind = "node" | "edge" | "group";

export type Entity = {
  /** Visimer's entity id — stable across a re-render: `node:A`, `edge:A->B#0`. */
  id: string;
  kind: EntityKind;
  /** The id operations take: a node's own id; an edge's entity id. */
  ref: string;
  /** The id Pele tags its element with (nodes and groups only). */
  domId: string;
  label: string;
  /** Flowchart node shape / edge line style, where the type has them. */
  shape?: string;
  line?: string;
  /** Edge endpoints, as node ids. */
  source?: string;
  target?: string;
};

export type Entities = { nodes: Entity[]; edges: Entity[]; groups: Entity[] };

export type Op = Record<string, unknown>;

export type DiagramKit = {
  /** Visimer's type id. */
  type: string;
  /** What a node is called here: "step", "state", "participant", … */
  item: string;
  /** Label a freshly added item gets, selected for typing over. */
  newLabel: string;
  entities(result: VisimerResult): Entities;
  /** CSS selectors inside Pele's SVG. */
  nodeSelector: string;
  edgeSelector: string;
  /** How edge elements are put in source order. */
  edgeOrder: "dom" | "numeric";
  /** Flow direction ("TD", "LR", …), which decides where the quick-add
   *  button sits. null = the type has none. */
  direction(result: VisimerResult): string | null;
  /** `id`: the id the new item takes in the source, for the types whose
   *  items have one apart from their name (a flowchart's nodes, a state
   *  diagram's states). Omitted, visimer picks the next free one. */
  add(label: string, id?: string): Op;
  connect?(source: Entity, target: Entity): Op;
  rename(entity: Entity, label: string): Op | null;
  /** null = this kind of thing cannot be deleted visually. */
  remove(entity: Entity): Op | null;
  setShape?(node: Entity, shape: string): Op;
  setLine?(edge: Entity, line: string): Op;
  reverse?(edge: Entity): Op;
  setDirection?(direction: string): Op;
  shapes?: readonly { key: string; label: string }[];
  lines?: readonly { key: string; label: string }[];
};

type Rec = Record<string, unknown>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const graph = (r: VisimerResult, key: string): Rec =>
  (r[key] as Rec | null | undefined) ?? {};

const node = (n: Rec, label = str(n.label)): Entity => ({
  id: str(n.entityId),
  kind: "node",
  ref: str(n.id),
  domId: str(n.id),
  label,
});
const edge = (e: Rec, label = str(e.label)): Entity => ({
  id: str(e.entityId),
  kind: "edge",
  ref: str(e.entityId),
  domId: "",
  label,
  source: str(e.source),
  target: str(e.target),
});
const dirOf = (g: Rec): string | null => {
  const d = g.direction;
  if (typeof d === "string") return d;
  if (d && typeof d === "object") return str((d as Rec).value) || null;
  return null;
};

export const FLOW_SHAPES = [
  { key: "rect", label: "Rectangle" },
  { key: "round", label: "Rounded" },
  { key: "stadium", label: "Pill" },
  { key: "diamond", label: "Decision" },
  { key: "circle", label: "Circle" },
  { key: "hexagon", label: "Hexagon" },
  { key: "cylinder", label: "Database" },
  { key: "subroutine", label: "Subroutine" },
] as const;

export const FLOW_LINES = [
  { key: "solid", label: "Solid" },
  { key: "dotted", label: "Dotted" },
  { key: "thick", label: "Thick" },
] as const;

const flowchart: DiagramKit = {
  type: "flowchart",
  item: "step",
  newLabel: "New step",
  nodeSelector: ".pele-node",
  edgeSelector: ".pele-edge",
  edgeOrder: "dom",
  entities(r) {
    const g = graph(r, "flowchart");
    return {
      nodes: arr(g.nodes).map((n) => ({ ...node(n), shape: str(n.shape) })),
      edges: arr(g.edges).map((e) => ({
        ...edge(e),
        line: str((e.seg as Rec | undefined)?.line),
      })),
      groups: arr(g.subgraphs).map((s) => ({
        id: str(s.entityId),
        kind: "group" as const,
        ref: str(s.id),
        domId: str(s.id),
        label: str(s.title) || str(s.id),
      })),
    };
  },
  direction: (r) => dirOf(graph(r, "flowchart")) ?? "TB",
  add: (label, id) => ({ type: "addNode", label, ...(id ? { id } : {}) }),
  connect: (s, t) => ({ type: "connect", source: s.ref, target: t.ref }),
  rename(e, label) {
    if (e.kind === "node") return { type: "renameNode", id: e.ref, label };
    if (e.kind === "edge") return { type: "setEdgeLabel", edgeId: e.ref, label };
    return { type: "renameSubgraph", id: e.ref, title: label };
  },
  remove: (e) =>
    e.kind === "edge"
      ? { type: "deleteEdge", edgeId: e.ref }
      : e.kind === "node"
        ? { type: "deleteNode", id: e.ref }
        : // Visimer has no operation that removes a subgraph.
          null,
  setShape: (n, shape) => ({ type: "setNodeShape", id: n.ref, shape }),
  setLine: (e, line) => ({ type: "setEdgeStyle", edgeId: e.ref, line }),
  reverse: (e) => ({ type: "reverseEdge", edgeId: e.ref }),
  setDirection: (direction) => ({ type: "setDirection", direction }),
  shapes: FLOW_SHAPES,
  lines: FLOW_LINES,
};

const state: DiagramKit = {
  type: "state",
  item: "state",
  newLabel: "New state",
  nodeSelector: ".pele-node",
  edgeSelector: ".pele-edge",
  edgeOrder: "dom",
  entities(r) {
    const g = graph(r, "state");
    return {
      nodes: arr(g.states).map((n) => node(n)),
      edges: arr(g.transitions).map((e) => edge(e)),
      groups: [],
    };
  },
  direction: (r) => dirOf(graph(r, "state")) ?? "TB",
  add: (label, id) => ({ type: "st.addState", label, ...(id ? { id } : {}) }),
  connect: (s, t) => ({ type: "st.connect", source: s.ref, target: t.ref }),
  rename: (e, label) =>
    e.kind === "node"
      ? { type: "st.setStateLabel", id: e.ref, label }
      : e.kind === "edge"
        ? { type: "st.setTransitionLabel", transId: e.ref, label }
        : null,
  remove: (e) =>
    e.kind === "edge"
      ? { type: "st.deleteTransition", transId: e.ref }
      : { type: "st.deleteState", id: e.ref },
  reverse: (e) => ({ type: "st.reverseTransition", transId: e.ref }),
  setDirection: (direction) => ({ type: "st.setDirection", direction }),
};

const sequence: DiagramKit = {
  type: "sequence",
  item: "participant",
  newLabel: "Participant",
  nodeSelector: ".pele-actor",
  edgeSelector: ".pele-message, .pele-note",
  edgeOrder: "numeric",
  entities(r) {
    const g = graph(r, "sequence");
    return {
      nodes: arr(g.participants).map((n) => node(n)),
      edges: arr(g.events).map((e) => {
        const stmt = (e.stmt as Rec | undefined) ?? {};
        return {
          ...edge({ ...e, source: stmt.source, target: stmt.target }, str(stmt.text)),
          line: str(e.kind),
        };
      }),
      groups: [],
    };
  },
  // Lifelines run down the page; a new participant goes to the right.
  direction: () => "LR",
  add: (name) => ({ type: "seq.addParticipant", name }),
  connect: (s, t) => ({
    type: "seq.addMessage",
    source: s.ref,
    target: t.ref,
    text: "Message",
  }),
  rename: (e, label) =>
    e.kind === "node"
      ? { type: "seq.renameParticipant", id: e.ref, name: label }
      : e.kind === "edge"
        ? { type: "seq.setEventText", eventId: e.ref, text: label }
        : null,
  remove: (e) =>
    e.kind === "edge"
      ? { type: "seq.deleteEvent", eventId: e.ref }
      : { type: "seq.deleteParticipant", id: e.ref },
  reverse: (e) => ({ type: "seq.reverseMessage", eventId: e.ref }),
};

const classKit: DiagramKit = {
  type: "class",
  item: "class",
  newLabel: "NewClass",
  nodeSelector: ".pele-node",
  edgeSelector: ".pele-edge",
  edgeOrder: "dom",
  entities(r) {
    const g = graph(r, "classGraph");
    return {
      nodes: arr(g.classes).map((n) => node(n, str(n.label) || str(n.id))),
      edges: arr(g.relations).map((e) => edge(e)),
      groups: [],
    };
  },
  direction: (r) => dirOf(graph(r, "classGraph")) ?? "TB",
  add: (name) => ({ type: "cl.addClass", name }),
  connect: (s, t) => ({ type: "cl.connect", source: s.ref, target: t.ref }),
  rename: (e, label) =>
    e.kind === "node"
      ? { type: "cl.renameClass", id: e.ref, name: label }
      : e.kind === "edge"
        ? { type: "cl.setRelationLabel", relId: e.ref, label }
        : null,
  remove: (e) =>
    e.kind === "edge"
      ? { type: "cl.deleteRelation", relId: e.ref }
      : { type: "cl.deleteClass", id: e.ref },
  reverse: (e) => ({ type: "cl.reverseRelation", relId: e.ref }),
  setDirection: (direction) => ({ type: "cl.setDirection", direction }),
};

const er: DiagramKit = {
  type: "er",
  item: "entity",
  newLabel: "ENTITY",
  nodeSelector: ".pele-node",
  edgeSelector: ".pele-edge",
  edgeOrder: "dom",
  entities(r) {
    const g = graph(r, "er");
    return {
      nodes: arr(g.entities).map((n) => node(n, str(n.label) || str(n.id))),
      edges: arr(g.relations).map((e) => edge(e)),
      groups: [],
    };
  },
  direction: () => "TB",
  add: (name) => ({ type: "er.addEntity", name }),
  connect: (s, t) => ({
    type: "er.connect",
    source: s.ref,
    target: t.ref,
    label: "relates",
  }),
  rename: (e, label) =>
    e.kind === "node"
      ? { type: "er.renameEntity", id: e.ref, name: label }
      : e.kind === "edge"
        ? { type: "er.setRelationLabel", relId: e.ref, label }
        : null,
  remove: (e) =>
    e.kind === "edge"
      ? { type: "er.deleteRelation", relId: e.ref }
      : { type: "er.deleteEntity", id: e.ref },
};

const KITS: readonly DiagramKit[] = [flowchart, state, sequence, classKit, er];

/** The kit for a parsed source, or null when the type has no visual editing. */
export function kitFor(result: VisimerResult): DiagramKit | null {
  const info = result.typeInfo;
  if (!info || info.capability !== "edit") return null;
  return KITS.find((k) => k.type === info.id) ?? null;
}

/** Diagram types the visual editor can edit. */
export const EDITABLE_TYPES: readonly string[] = KITS.map((k) => k.type);

/**
 * An editing session over one source: open, run operations, read the result.
 *
 * It exists for one reason. Visimer 1.1.4 throws "Overlapping text edits"
 * when a node declared on the LAST line of a source with no trailing newline
 * is deleted together with an edge on the line before it — the two line
 * removals both claim the newline between them. With a trailing newline the
 * same operation is fine. So a session always works on a newline-terminated
 * copy, and `code()` takes that newline off again if the source had none.
 */
export type EditSession = {
  readonly ed: VisimerEditor;
  /** Run one operation. Returns the ids it created, or null when it did not
   *  apply (including when visimer threw). */
  run(op: Op | null): string[] | null;
  /** The source as it stands, in the original's trailing-newline style. */
  code(): string;
};

export function openSession(visimer: VisimerModule, source: string): EditSession {
  const padded = source.endsWith("\n") ? source : source + "\n";
  const ed = new visimer.MermaidWysiwygEditor({ code: padded });
  return {
    ed,
    run(op) {
      if (!op) return null;
      try {
        const res = ed.dispatch(op);
        return res ? (res.created ?? []) : null;
      } catch {
        // A failed edit costs the edit, never the document.
        return null;
      }
    },
    code() {
      const out = ed.code;
      if (source.endsWith("\n")) return out;
      return out.endsWith("\n") ? out.slice(0, -1) : out;
    },
  };
}

// ---------------------------------------------------------------------------
// Correlation — tag Pele's SVG elements with the entity they draw.
// ---------------------------------------------------------------------------

/** Attribute the visual editor reads to learn what was clicked. */
export const ENTITY_ATTR = "data-ce-entity";

const numericTail = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * Write `data-ce-entity` onto every element of `svgRoot` that draws one of
 * `entities`. Returns the entities that were found, by id.
 */
export function correlate(
  svgRoot: Element,
  kit: DiagramKit,
  entities: Entities,
): Map<string, Entity> {
  const found = new Map<string, Entity>();

  const byDomId = new Map<string, Entity>();
  for (const n of entities.nodes) byDomId.set(n.domId, n);
  for (const el of Array.from(svgRoot.querySelectorAll(kit.nodeSelector))) {
    const e = byDomId.get(el.getAttribute("data-id") ?? "");
    if (!e) continue;
    el.setAttribute(ENTITY_ATTR, e.id);
    found.set(e.id, e);
  }

  if (entities.groups.length > 0) {
    const groups = new Map<string, Entity>();
    for (const g of entities.groups) groups.set(g.domId, g);
    for (const el of Array.from(svgRoot.querySelectorAll(".pele-cluster"))) {
      const e = groups.get(el.getAttribute("data-id") ?? "");
      if (!e) continue;
      el.setAttribute(ENTITY_ATTR, e.id);
      found.set(e.id, e);
    }
  }

  // Edges, by order. Several elements can share one `data-id` (the line and
  // its label), so order is taken over the distinct ids.
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(svgRoot.querySelectorAll(kit.edgeSelector))) {
    const id = el.getAttribute("data-id");
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (kit.edgeOrder === "numeric") {
    ids.sort((a, b) => numericTail(a) - numericTail(b));
  }
  if (ids.length === entities.edges.length) {
    const byEdgeDomId = new Map<string, Entity>();
    ids.forEach((id, i) => byEdgeDomId.set(id, entities.edges[i]!));
    const tagged = svgRoot.querySelectorAll(
      `${kit.edgeSelector}, .pele-edge-label`,
    );
    for (const el of Array.from(tagged)) {
      const e = byEdgeDomId.get(el.getAttribute("data-id") ?? "");
      if (!e) continue;
      el.setAttribute(ENTITY_ATTR, e.id);
      found.set(e.id, e);
    }
  }
  return found;
}
