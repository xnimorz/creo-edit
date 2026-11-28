// ---------------------------------------------------------------------------
// The visual editor — editing a diagram by pointing at it.
//
// The rule it works under: the source text is the only thing that is ever
// stored. A gesture here becomes an operation, the operation becomes a text
// edit (`kits.ts`, through visimer), the block's source changes, and the
// picture is drawn again from it. That is also why nothing can be dragged to
// a position — mermaid lays a diagram out itself, and the source has nowhere
// to keep one.
//
// What makes it easy to work with is deliberately few moves:
//
//   click            select a node, an edge or a group
//   double-click     rename it where it is (on empty space: add one)
//   +                add a node connected to the selected one, already
//                    selected for typing — click, type, Tab, type, Tab…
//   drag a dot       to another node: connect them; to empty space: add a
//                    connected node there
//   Delete           remove what is selected
//
// A mind map, a timeline and a Gantt chart have nothing to connect: there +
// and Tab add one INSIDE the selected (an idea under an idea, an event in a
// period) or after it (a task), and Shift+Enter adds the next one beside it.
// Enter renames, in every kind.
//
// Two kinds are dragged, too: a mind map's idea onto another (inside it, or
// before or after it beside it — `kit.move`), and a Gantt task's bar (whole,
// to move it; by an end, to make it shorter or longer — `kit.retime`). What is
// dragged is drawn where it would go; the source changes once, on the drop.
// Mod+C / Mod+X copy the selection's words (a mind map's idea with what is
// under it, as an outline), Mod+V adds what is pasted from the selection.
//
// Layout of the pieces: Pele owns the SVG inside `canvas` and replaces it on
// every draw, so nothing of ours can live in there. Selection chrome is in
// `overlay`, a sibling stacked over it, positioned from the SVG elements'
// rects after each draw.
//
// What can be done to the selection (shape, line, delete…) is NOT drawn
// here. A toolbar floating beside the selected node was tried and covers the
// node's neighbours — a laid-out diagram has no spare room around a node.
// The actions go in the block's bar instead (`entityActions()`), which is
// always in the same place and covers nothing.
// ---------------------------------------------------------------------------

import { isolateInput } from "creo-edit";
import { iconFor, icons } from "./icons";
import {
  correlate,
  ENTITY_ATTR,
  kitFor,
  openSession,
  type DiagramKit,
  type DropPlace,
  type EditSession,
  type Entities,
  type Entity,
  type Side,
} from "./kits";
import type { MermaidRuntime } from "./runtime";
import { remapId } from "./textkit";
import type { MermaidAction } from "./types";

export type VisualHost = {
  /** The block element. */
  readonly root: HTMLElement;
  readonly stage: HTMLElement;
  /** Pele draws in here. */
  readonly canvas: HTMLElement;
  /** Stacked over the canvas; ours. */
  readonly overlay: HTMLElement;
  runtime(): MermaidRuntime | null;
  /** The block's source, as the document has it. */
  source(): string;
  /** The source the canvas is showing — the document's, or a preview. */
  canvasSource(): string;
  /**
   * Draw `next` without writing it to the document; `null` goes back to the
   * document's source. This is how a node grows while its name is typed: the
   * picture follows every keystroke, the document changes once, on commit.
   */
  preview(next: string | null): void;
  /** Editable editor, visual editing on, Diagram mode. */
  interactive(): boolean;
  /** Write a new source to the document. False when it was refused. */
  commit(next: string): boolean;
  toast(message: string): void;
  /** Selection or diagram type changed — the bar may need redrawing. */
  changed(): void;
};

/** What to do once the edited source has been drawn. */
type Intent = {
  select?: string | null;
  /** If `select` is gone (a rename that changed the id), the node now
   *  carrying this label. */
  orLabel?: string;
  edit?: boolean;
};

type Rect = { left: number; top: number; width: number; height: number };

const NO_ENTITIES: Entities = { nodes: [], edges: [], groups: [] };
const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

/** Which side of a node "forward" is, for a flow direction. */
function forwardSide(direction: string | null): Side {
  switch ((direction ?? "TB").toUpperCase()) {
    case "LR":
      return "right";
    case "RL":
      return "left";
    case "BT":
      return "top";
    default:
      return "bottom";
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
};

/** A press on chrome must not take the focus off the canvas. */
const keepFocus = (e: Event): void => e.preventDefault();

/** Computed style, through the element's own window (a document in a frame,
 *  or a test's, has no global `getComputedStyle`). */
const styleOf = (node: Element): CSSStyleDeclaration | null =>
  node.ownerDocument?.defaultView?.getComputedStyle(node) ?? null;

/** A label is one line of text, however the field wrapped or pasted it. */
const oneLine = (value: string): string => value.replace(/\s*\n\s*/g, " ").trim();

const OWN_SHAPES = ["rect", "circle", "ellipse", "polygon"];
/**
 * Where an element is — its own shape's place when it is drawn AROUND other
 * things that can be selected (a timeline's period holds its events): the
 * frame goes round the period, not round all that is in it.
 */
function ownBox(el: Element): DOMRect {
  if (el.querySelector(`[${ENTITY_ATTR}]`)) {
    const own = Array.from(el.children).find((c) => OWN_SHAPES.includes(c.tagName.toLowerCase()));
    if (own) return own.getBoundingClientRect();
  }
  return el.getBoundingClientRect();
}

let measurer: CanvasRenderingContext2D | null | undefined;
/** Width of `text` in `font` (a CSS font shorthand), in px. */
function textWidth(text: string, font: string): number {
  if (measurer === undefined) {
    try {
      measurer = document.createElement("canvas").getContext("2d");
    } catch {
      measurer = null;
    }
  }
  if (!measurer) return text.length * 8;
  measurer.font = font;
  return measurer.measureText(text).width;
}

export class VisualLayer {
  kit: DiagramKit | null = null;
  /** Selected entity id (visimer's), or null. */
  selection: string | null = null;

  private entities: Entities = NO_ENTITIES;
  private found = new Map<string, Entity>();
  private direction: string | null = null;
  private pending: Intent | null = null;
  private input: HTMLTextAreaElement | null = null;
  private editing: string | null = null;
  /** The label the entity had when its field was opened. */
  private editFrom = "";
  /** Whether the canvas is showing the text that is in the field. */
  private following = true;
  /** The document's source the ids held here were read from. */
  private lastDoc: string | null = null;
  /** A day is being picked in a calendar of the host's (`hold`). */
  private holding = false;
  /** Something is being dragged: what ends it early (Escape). */
  private dragging: (() => void) | null = null;
  /** The field the clipboard's text is pasted into (`pasteHere`). */
  private clip: HTMLTextAreaElement | null = null;
  private dead = false;
  private off: (() => void)[] = [];

  private readonly box: HTMLElement;
  private readonly dots: HTMLElement[];
  private readonly plus: HTMLButtonElement;
  private readonly ghost: SVGSVGElement;
  private readonly ghostLine: SVGLineElement;

  constructor(private readonly host: VisualHost) {
    const { overlay, canvas, root } = host;

    this.box = el("div", "ce-mmd-box");
    this.dots = SIDES.map((side) => {
      const d = el("div", `ce-mmd-dot ce-mmd-dot-${side}`);
      d.setAttribute("role", "button");
      d.setAttribute("aria-label", "Drag to connect");
      d.title = "Drag to another one to connect";
      d.addEventListener("pointerdown", (e) => this.startConnect(e));
      return d;
    });
    this.plus = el("button", "ce-mmd-plus");
    this.plus.type = "button";
    this.plus.innerHTML = icons.plus;
    this.plus.addEventListener("pointerdown", keepFocus);
    this.plus.addEventListener("click", (e) => {
      e.preventDefault();
      const from = this.current();
      if (from && from.kind === "node") this.addNode(from);
    });
    const NS = "http://www.w3.org/2000/svg";
    this.ghost = document.createElementNS(NS, "svg") as SVGSVGElement;
    this.ghost.setAttribute("class", "ce-mmd-ghost");
    this.ghostLine = document.createElementNS(NS, "line") as SVGLineElement;
    this.ghost.appendChild(this.ghostLine);

    overlay.append(this.box, ...this.dots, this.plus, this.ghost);
    this.hideChrome();

    const on = <T extends Event>(
      target: EventTarget,
      type: string,
      fn: (e: T) => void,
    ): void => {
      target.addEventListener(type, fn as EventListener);
      this.off.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on<PointerEvent>(canvas, "pointerdown", (e) => this.onPointerDown(e));
    on<PointerEvent>(canvas, "pointermove", (e) => this.onHover(e));
    on<MouseEvent>(canvas, "dblclick", (e) => this.onDoubleClick(e));
    on<KeyboardEvent>(canvas, "keydown", (e) => this.onKey(e));
    // The selection belongs to a diagram being worked on. Once the focus is
    // anywhere else in the page it would only be stale chrome.
    on<FocusEvent>(root, "focusout", () => {
      setTimeout(() => {
        if (this.dead || this.input) return;
        const active = document.activeElement;
        if (root.contains(active)) return;
        // …but in a calendar of the host's, opened for what is selected
        // (`hold`), the work is still on it. Such a calendar is beside the
        // document, never in it: the focus in the document has left.
        const away = !active || active === document.body || !!root.closest("[data-creo-edit]")?.contains(active);
        if (this.holding && !away) return;
        this.holding = false;
        this.select(null);
      }, 0);
    });
    on<FocusEvent>(root, "focusin", () => {
      this.holding = false;
    });

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.paint());
      ro.observe(host.stage);
      this.off.push(() => ro.disconnect());
    }
  }

  destroy(): void {
    this.dead = true;
    this.dragging?.();
    for (const f of this.off) f();
    this.off = [];
    this.closeInput();
    this.clip?.remove();
    this.clip = null;
  }

  // -------------------------------------------------------------------------
  // After every draw: learn what is on the canvas.
  // -------------------------------------------------------------------------

  /** Forget everything — the canvas is not something to edit right now. */
  reset(): void {
    this.kit = null;
    this.entities = NO_ENTITIES;
    this.found = new Map();
    this.selection = null;
    this.pending = null;
    this.lastDoc = null;
    this.closeInput();
    this.hideChrome();
    delete this.host.root.dataset.interactive;
  }

  /**
   * Carry the ids held here over a change of the document that was not made
   * here. Where an id is a line of the source (`kit.positional`), a line
   * someone else added above it would otherwise make it another thing's.
   */
  private rebase(): void {
    const doc = this.host.source();
    const was = this.lastDoc;
    this.lastDoc = doc;
    if (was === null || was === doc || !this.kit?.positional) return;
    this.selection = remapId(was, doc, this.selection);
    this.editing = remapId(was, doc, this.editing);
  }

  sync(): void {
    if (this.dead) return;
    const { host } = this;
    if (!host.interactive()) {
      this.reset();
      host.changed();
      return;
    }
    const rt = host.runtime();
    const visimer = rt?.visimerNow() ?? null;
    if (!rt || !visimer) {
      // Not loaded yet. The diagram is already on screen; it becomes
      // editable when the rewriter arrives.
      void rt?.visimer().then(
        () => this.sync(),
        () => {},
      );
      return;
    }
    const svg = host.canvas.querySelector("svg");
    if (!svg) {
      this.reset();
      host.changed();
      return;
    }

    this.rebase();
    if (this.input && !this.editing) {
      // What was being renamed is gone. Its field goes now; the picture of
      // the name half typed goes once this draw is done with.
      this.closeInput();
      queueMicrotask(() => !this.dead && !this.input && host.preview(null));
    }
    const session = openSession(visimer, host.canvasSource());
    const kit = kitFor(session.ed.result);
    const typeChanged = kit?.type !== this.kit?.type;
    this.kit = kit;
    if (!kit) {
      // A type with no visual editing: still a picture, still editable in Code.
      this.entities = NO_ENTITIES;
      this.found = new Map();
      this.selection = null;
      this.hideChrome();
      delete host.root.dataset.interactive;
      host.changed();
      return;
    }
    this.entities = kit.entities(session.ed.result);
    this.direction = kit.direction(session.ed.result);
    this.found = correlate(svg, kit, this.entities);
    this.widenEdges(svg);
    host.root.dataset.interactive = "true";

    const intent = this.pending;
    this.pending = null;
    if (intent && "select" in intent) {
      let id = intent.select ?? null;
      if (id && !this.found.has(id) && intent.orLabel != null) {
        id = this.entities.nodes.find((n) => n.label === intent.orLabel)?.id ?? null;
      }
      this.selection = id;
    }
    if (this.selection && !this.found.has(this.selection)) this.selection = null;
    if (this.editing && !this.found.has(this.editing)) this.closeInput();

    this.paint();
    if (intent?.edit && this.selection) this.startEdit(this.selection);
    if (typeChanged || intent) host.changed();
  }

  /**
   * An edge is a hairline; nobody should have to hit it exactly. Each one
   * gets an invisible, wide copy of its line that takes the pointer.
   */
  private widenEdges(svg: Element): void {
    for (const g of Array.from(svg.querySelectorAll(`[${ENTITY_ATTR}]`))) {
      if (g.querySelector(":scope > .ce-mmd-hit")) continue;
      const line = Array.from(g.querySelectorAll("path, line")).find(
        (p) => !p.classList.contains("pele-marker"),
      );
      if (!line) continue;
      // Nodes are filled shapes and easy to hit already.
      if (g.matches(this.kit?.nodeSelector ?? ".pele-node") || g.matches(".pele-cluster")) continue;
      const hit = line.cloneNode(false) as SVGElement;
      for (const a of ["marker-start", "marker-end", "style", "stroke-dasharray", "id"]) {
        hit.removeAttribute(a);
      }
      hit.setAttribute("class", "ce-mmd-hit");
      g.appendChild(hit);
    }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  current(): Entity | null {
    return (this.selection && this.found.get(this.selection)) || null;
  }

  select(id: string | null): void {
    if (id !== null && !this.found.has(id)) id = null;
    if (id === this.selection) return;
    this.selection = id;
    this.paint();
    this.host.changed();
  }

  private entityAt(target: EventTarget | null): string | null {
    const hit = (target as Element | null)?.closest?.(`[${ENTITY_ATTR}]`);
    if (!hit || !this.host.canvas.contains(hit)) return null;
    const id = hit.getAttribute(ENTITY_ATTR);
    return id && this.found.has(id) ? id : null;
  }

  private elementsOf(id: string): Element[] {
    const all = this.host.canvas.querySelectorAll(`[${ENTITY_ATTR}]`);
    return Array.from(all).filter((n) => n.getAttribute(ENTITY_ATTR) === id);
  }

  /** Where an entity is, in the overlay's coordinates. */
  private rectOf(e: Entity): Rect | null {
    const els = this.elementsOf(e.id);
    if (els.length === 0) return null;
    const origin = this.host.overlay.getBoundingClientRect();
    const rel = (r: DOMRect): Rect => ({
      left: r.left - origin.left,
      top: r.top - origin.top,
      width: r.width,
      height: r.height,
    });
    if (e.kind !== "edge") return rel(ownBox(els[0]!));
    // An edge: its label if it has one on screen, else the middle of its line.
    const label = els.find((n) => n.classList.contains("pele-edge-label"));
    if (label) {
      const r = label.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return rel(r);
    }
    const hit = els
      .map((n) => n.querySelector(".ce-mmd-hit"))
      .find((n): n is Element => !!n) as (SVGGeometryElement & Element) | undefined;
    if (hit && typeof hit.getTotalLength === "function" && typeof hit.getScreenCTM === "function") {
      try {
        const p = hit.getPointAtLength(hit.getTotalLength() / 2);
        const m = hit.getScreenCTM();
        if (m) {
          const x = p.x * m.a + p.y * m.c + m.e;
          const y = p.x * m.b + p.y * m.d + m.f;
          return { left: x - origin.left, top: y - origin.top, width: 0, height: 0 };
        }
      } catch {
        /* fall through to the bounding box */
      }
    }
    const r = els[0]!.getBoundingClientRect();
    return {
      left: r.left + r.width / 2 - origin.left,
      top: r.top + r.height / 2 - origin.top,
      width: 0,
      height: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------

  private hideChrome(): void {
    this.box.hidden = true;
    this.plus.hidden = true;
    this.ghost.style.display = "none";
    for (const d of this.dots) d.hidden = true;
  }

  private paint(): void {
    if (this.dead) return;
    for (const n of Array.from(this.host.canvas.querySelectorAll(".ce-mmd-selected"))) {
      n.classList.remove("ce-mmd-selected");
    }
    const e = this.current();
    const kit = this.kit;
    const rect = e ? this.rectOf(e) : null;
    if (!e || !kit || !rect) {
      this.hideChrome();
      return;
    }
    for (const n of this.elementsOf(e.id)) n.classList.add("ce-mmd-selected");

    const isNode = e.kind === "node";
    const boxed = e.kind !== "edge";
    this.box.hidden = !boxed;
    if (boxed) {
      const pad = 4;
      Object.assign(this.box.style, {
        left: `${rect.left - pad}px`,
        top: `${rect.top - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
      });
    }

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const at: Record<Side, [number, number]> = {
      top: [cx, rect.top],
      right: [rect.left + rect.width, cy],
      bottom: [cx, rect.top + rect.height],
      left: [rect.left, cy],
    };
    const connectable = isNode && !!kit.connect;
    SIDES.forEach((side, i) => {
      const d = this.dots[i]!;
      d.hidden = !connectable;
      if (!connectable) return;
      d.style.left = `${at[side][0]}px`;
      d.style.top = `${at[side][1]}px`;
    });

    const label = !isNode ? null : kit.addLabel ? kit.addLabel(e) : `Add a connected ${kit.item}`;
    this.plus.hidden = label === null;
    if (label !== null) {
      const side = kit.side
        ? kit.side(e, (other) => this.centreOf(other), this.entities)
        : forwardSide(this.direction);
      const gap = 26;
      const [px, py] = at[side];
      const dx = side === "right" ? gap : side === "left" ? -gap : 0;
      const dy = side === "bottom" ? gap : side === "top" ? -gap : 0;
      this.plus.style.left = `${px + dx}px`;
      this.plus.style.top = `${py + dy}px`;
      this.plus.title = `${label} (Tab)`;
      this.plus.setAttribute("aria-label", label);
    }

    this.placeInput();
  }

  /**
   * The host is about to open something of its own for what is selected (a
   * calendar: `options.pickDate`), which may take the focus: the selection
   * is kept while the focus is in it. Let go by `release`, by the focus
   * coming back, or by its going anywhere in the document.
   */
  hold(): void {
    this.holding = true;
  }

  release(): void {
    this.holding = false;
  }

  private centreOf(e: Entity): { x: number; y: number } | null {
    const r = this.found.has(e.id) ? this.rectOf(e) : null;
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }

  /** What can be done to the selection. Part of the block's action list:
   *  the bar draws it, and a host can put it in its own menu. */
  entityActions(): MermaidAction[] {
    const e = this.current();
    const kit = this.kit;
    const labels = this.host.runtime()?.labels;
    if (!e || !kit || !labels || !this.host.interactive()) return [];
    const out: MermaidAction[] = [];
    if (kit.rename(e, e.label) !== null) {
      out.push({
        key: "edit",
        scope: "entity",
        label: labels.edit,
        icon: icons.edit,
        run: () => this.startEdit(e.id),
      });
    }
    if (e.kind === "node" && kit.shapes && kit.setShape) {
      const setShape = kit.setShape;
      out.push({
        key: "shape",
        scope: "entity",
        label: labels.shape,
        icon: iconFor(e.shape ?? "rect"),
        run: () => {},
        choices: kit.shapes.map((s) => ({
          key: s.key,
          label: s.label,
          icon: iconFor(s.key),
          on: e.shape === s.key,
          run: () => this.apply((session) => (session.run(setShape(e, s.key)) ? { select: e.id } : false)),
        })),
      });
    }
    if (e.kind === "edge" && kit.lines && kit.setLine) {
      const setLine = kit.setLine;
      out.push({
        key: "line",
        scope: "entity",
        label: labels.line,
        icon: iconFor(e.line ?? "solid"),
        run: () => {},
        choices: kit.lines.map((l) => ({
          key: l.key,
          label: l.label,
          icon: iconFor(l.key),
          on: e.line === l.key,
          // Changing the line changes the edge's text but not its place in
          // the source, so it keeps its id.
          run: () => this.apply((session) => (session.run(setLine(e, l.key)) ? { select: e.id } : false)),
        })),
      });
    }
    if (e.kind === "edge" && kit.reverse && e.line !== "note") {
      const reverse = kit.reverse;
      out.push({
        key: "reverse",
        scope: "entity",
        label: labels.reverse,
        icon: icons.reverse,
        run: () => this.apply((session) => (session.run(reverse(e)) ? { select: null } : false)),
      });
    }
    if (e.kind === "node" && kit.flags && kit.setFlag) {
      const setFlag = kit.setFlag;
      out.push({
        key: "flags",
        scope: "entity",
        label: labels.status,
        icon: icons.check,
        run: () => {},
        choices: kit.flags.map((f) => {
          const on = e.flags?.includes(f.key) === true;
          return {
            key: f.key,
            label: f.label,
            icon: iconFor(f.key),
            on,
            run: () => this.apply((session) => (session.run(setFlag(e, f.key, !on)) ? { select: e.id } : false)),
          };
        }),
      });
    }
    if (e.kind === "node" && kit.fields && kit.setField) {
      const setField = kit.setField;
      for (const f of kit.fields) {
        out.push({
          key: f.key,
          scope: "entity",
          label: f.label,
          icon: icons.edit,
          run: () => {},
          field: {
            value: e.fields?.[f.key] ?? "",
            placeholder: f.placeholder,
            hint: f.hint,
            // Written on leaving the field — which may be for another task:
            // that one stays selected.
            commit: (value) =>
              this.apply((session) => {
                if (!session.run(setField(e, f.key, value, () => this.newId()))) return false;
                return this.selection === e.id ? { select: e.id } : {};
              }),
            ...(kit.setDate && e.dates && f.key in e.dates
              ? {
                  date: {
                    value: e.dates[f.key] ?? null,
                    pick: (day: string) =>
                      this.apply((session) => {
                        if (!session.run(kit.setDate?.(e, f.key, day) ?? null)) return false;
                        return this.selection === e.id ? { select: e.id } : {};
                      }),
                  },
                }
              : {}),
          },
        });
      }
    }
    out.push({
      key: "copyItem",
      scope: "entity",
      label: labels.copyItem,
      icon: icons.copy,
      run: () => this.copySelected(),
    });
    if (kit.remove(e) !== null) {
      out.push({
        key: "delete",
        scope: "entity",
        label: labels.delete,
        icon: icons.trash,
        run: () => this.removeSelected(),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Run operations against the source and, if they leave a diagram that
   * still draws, write the result to the document.
   *
   * `build` returns what to do once the new source is drawn, `false` when
   * the edit was refused, or `null` when there was nothing to do.
   */
  private apply(build: (session: EditSession, kit: DiagramKit) => Intent | false | null): boolean {
    const { host } = this;
    const rt = host.runtime();
    const visimer = rt?.visimerNow();
    if (!rt || !visimer || !host.interactive()) return false;
    const before = host.source();
    const session = openSession(visimer, before);
    const kit = kitFor(session.ed.result);
    if (!kit) return false;
    const intent = build(session, kit);
    if (intent === null) return false;
    if (intent === false) {
      host.toast(rt.labels.rejected);
      return false;
    }
    const next = session.code();
    if (next === before) return false;
    // Two parsers read this language — visimer to edit it, the engine to draw
    // it — and they will not always agree. An edit the engine cannot draw is
    // not applied, unless the diagram was already broken before it.
    const engine = rt.engineNow();
    if (engine && engine.check(next) !== null && engine.check(before) === null) {
      host.toast(rt.labels.rejected);
      return false;
    }
    this.pending = intent;
    // This change is ours: the ids `intent` names are the new source's
    // already, and one kept across it is carried here.
    const selected = this.selection;
    if (kit.positional && !("select" in intent)) this.selection = remapId(before, next, selected);
    this.lastDoc = next;
    if (host.commit(next)) return true;
    this.pending = null;
    this.selection = selected;
    this.lastDoc = before;
    return false;
  }

  /** The host's id for a node about to be added (`options.nodeId`), if it
   *  gives one. */
  private newId(): string | undefined {
    const id = this.host.runtime()?.options.nodeId?.();
    return typeof id === "string" && id ? id : undefined;
  }

  /** Add a node; connected from `from` when given. It comes up selected with
   *  its label ready to type over. */
  addNode(from?: Entity | null): void {
    this.apply((session, kit) => {
      const id = this.addIn(session, kit, from ?? null);
      return id ? { select: id, edit: true } : false;
    });
  }

  /** Add an item in an open session — from `from`, when given: joined to it
   *  in a graph, inside or after it elsewhere. Its id, or null. */
  private addIn(session: EditSession, kit: DiagramKit, from: Entity | null): string | null {
    const created = session.run(kit.add(kit.newLabel, this.newId(), from));
    if (!created || created.length === 0) return null;
    const id = created[0]!;
    if (from && kit.connect) {
      const added = kit.entities(session.ed.result).nodes.find((n) => n.id === id);
      if (added) session.run(kit.connect(from, added));
    }
    return id;
  }

  /** Shift+Enter: the next one beside `from`, ready to be named. False
   *  where the type has no such thing (a graph, a group). */
  private addNext(from: Entity): boolean {
    if (!this.kit?.addAfter || this.kit.addAfter(from, this.kit.newLabel) === null) return false;
    this.apply((session, kit) => {
      const created = session.run(kit.addAfter?.(from, kit.newLabel) ?? null);
      return created && created.length > 0 ? { select: created[0]!, edit: true } : false;
    });
    return true;
  }

  private connect(from: Entity, to: Entity): void {
    this.apply((session, kit) => {
      if (!kit.connect) return false;
      const created = session.run(kit.connect(from, to));
      if (created === null) return false;
      // A message or a relationship is its text; a flowchart arrow usually
      // has none. Only the former opens for typing.
      const worded = kit.type === "sequence" || kit.type === "er";
      return { select: created[0] ?? null, edit: worded };
    });
  }

  removeSelected(): void {
    const e = this.current();
    if (!e) return;
    this.apply((session, kit) => {
      const op = kit.remove(e);
      // Not something that is removed here (a mind map's root): nothing to say.
      if (op === null) return null;
      return session.run(op) ? { select: null } : false;
    });
  }

  /** Flip the diagram between top-down and left-to-right. */
  toggleDirection(): void {
    const set = this.kit?.setDirection;
    if (!set) return;
    const next = this.horizontal() ? "TD" : "LR";
    // No `select` in the intent: whatever was selected stays selected.
    this.apply((session) => (session.run(set(next)) ? {} : false));
  }

  /** True when the diagram flows sideways. */
  horizontal(): boolean {
    const side = forwardSide(this.direction);
    return side === "right" || side === "left";
  }

  // -------------------------------------------------------------------------
  // Renaming in place
  // -------------------------------------------------------------------------

  startEdit(id: string): void {
    const e = this.found.get(id);
    const kit = this.kit;
    if (!e || !kit || !this.host.interactive() || kit.rename(e, e.label) === null) return;
    this.closeInput();
    this.selection = id;
    this.paint();

    // A textarea, not an input: a long name wraps inside its node, and the
    // field has to wrap the same way to stay the node's size.
    const input = el("textarea", "ce-mmd-input");
    input.rows = 1;
    input.value = e.label;
    input.setAttribute("aria-label", this.host.runtime()?.labels.edit ?? "Edit text");
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    // Typed in the diagram's own face and size, so the text does not jump
    // when the field closes and the label takes its place.
    const text = this.elementsOf(id)
      .map((n) => (n.matches("text") ? n : n.querySelector("text")))
      .find((n): n is Element => !!n);
    if (text) {
      const cs = styleOf(text);
      if (cs?.fontFamily) input.style.fontFamily = cs.fontFamily;
      if (cs?.fontSize) input.style.fontSize = cs.fontSize;
    }
    // Listeners first, isolation second: both are on this node, and they run
    // in the order they were added.
    input.addEventListener("input", () => this.typed());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        // Shift: named, and on to the next one beside it.
        this.commitEdit(ev.shiftKey ? "next" : null);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.cancelEdit();
      } else if (ev.key === "Tab" && !ev.shiftKey && e.kind === "node") {
        ev.preventDefault();
        this.commitEdit("inside");
      }
    });
    input.addEventListener("blur", () => {
      if (this.input === input) this.commitEdit();
    });
    isolateInput(input);

    this.input = input;
    this.editing = id;
    this.editFrom = e.label;
    this.following = true;
    // While a label is being typed the dots, the + and the selection frame
    // are only clutter: the field IS the node for now.
    this.host.root.dataset.editing = "true";
    this.host.overlay.appendChild(input);
    this.placeInput();
    input.focus({ preventScroll: true });
    input.select();
  }

  /**
   * A keystroke in the label field. The node itself grows: the diagram is
   * redrawn with the name as typed so far, and the field is laid back over
   * the node at its new size. Nothing is written to the document — that
   * happens once, on commit, so a rename stays one undo step.
   */
  private typed(): void {
    this.rebase();
    const input = this.input;
    const id = this.editing;
    if (input && !id) this.cancelEdit();
    if (!input || !id) return;
    this.previewLabel(id, oneLine(input.value));
    // Whether or not the picture could follow, the field fits its text.
    this.placeInput();
  }

  private previewLabel(id: string, value: string): void {
    const { host } = this;
    // Until shown otherwise, the picture is NOT showing what is in the field.
    this.following = false;
    const rt = host.runtime();
    const visimer = rt?.visimerNow();
    if (!rt || !visimer) return;
    if (value === this.editFrom) {
      host.preview(null);
      this.following = true;
      return;
    }
    if (value === "") {
      host.preview(null);
      return;
    }
    const session = openSession(visimer, host.source());
    const kit = kitFor(session.ed.result);
    if (!kit) return;
    const all = (): Entity[] => {
      const ents = kit.entities(session.ed.result);
      return [...ents.nodes, ...ents.edges, ...ents.groups];
    };
    const original = all().find((x) => x.id === id);
    if (!original || session.run(kit.rename(original, value)) === null) return;
    // Renaming a class or an ER entity changes its id. The field is held on
    // to by id, so for those the picture waits for the commit and only the
    // field grows.
    if (!all().some((x) => x.id === id)) return;
    const next = session.code();
    // A name half typed can be one the engine will not draw (`A[` …). Keep
    // the last picture until it can.
    const engine = rt.engineNow();
    if (engine && engine.check(next) !== null) return;
    host.preview(next);
    this.following = true;
  }

  private placeInput(): void {
    const input = this.input;
    const e = this.editing ? this.found.get(this.editing) : null;
    if (!input || !e) return;
    const rect = this.rectOf(e);
    if (!rect) return;
    // Exactly over the node, and no wider than its text needs: a field
    // bigger than the node would hide the edges around it.
    //
    // Normally the node has just been redrawn around the text (`typed`), so
    // its box IS the answer — including where it wraps. Only when the picture
    // cannot follow the typing does the field grow on its own: up to the
    // width a label wraps at, then downwards.
    const WRAP_AT = 220;
    const pad = 20;
    // An edge's label is bare text, and so is a mind map's leaf or a chart's
    // title; a node's words have the node's padding round them.
    const drawn = this.elementsOf(e.id)[0];
    const bare =
      e.kind === "edge" ||
      !drawn ||
      drawn.matches("text") ||
      !drawn.querySelector("rect, circle, ellipse, polygon, path");
    const base = rect.width + (bare ? 18 : 0);
    let width = Math.max(base, 48);
    // Bare words have no box to say how wide they are but their own, and a
    // field does not set them quite as the picture does: it is measured.
    if (!this.following || bare) {
      const cs = styleOf(input);
      const font = `${cs?.fontSize || "14px"} ${cs?.fontFamily || "sans-serif"}`;
      const needs = textWidth(input.value || " ", font) + pad;
      width = Math.max(width, Math.min(needs, WRAP_AT));
    }
    input.style.width = `${width}px`;
    // Height: the node's, or what the wrapped text takes if that is more;
    // the text is centred in it by padding, as a label is in its node.
    input.style.paddingTop = "0px";
    input.style.height = "0px";
    const text = input.scrollHeight;
    const height = Math.max(rect.height, text + 6, 26);
    input.style.height = `${height}px`;
    input.style.paddingTop = `${Math.max(0, (height - text) / 2 - 2)}px`;
    input.style.left = `${rect.left + rect.width / 2 - width / 2}px`;
    input.style.top = `${rect.top + rect.height / 2 - height / 2}px`;
  }

  private closeInput(): void {
    const input = this.input;
    this.input = null;
    this.editing = null;
    delete this.host.root.dataset.editing;
    input?.remove();
  }

  private cancelEdit(): void {
    this.closeInput();
    // Back to the picture of what the document actually holds.
    this.host.preview(null);
    this.focusCanvas();
  }

  /**
   * `then`: keep going — "inside" (Tab) with a new node connected to this
   * one (under it, in a tree), "next" (Shift+Enter) with the one beside it,
   * where the type has such a thing.
   */
  private commitEdit(then: "inside" | "next" | null = null): void {
    this.rebase();
    const input = this.input;
    const id = this.editing;
    if (input && !id) this.cancelEdit();
    if (!input || !id) return;
    const value = oneLine(input.value);
    this.closeInput();
    this.focusCanvas();
    const unchanged = value === "" || value === this.editFrom;
    if (unchanged && !then) {
      this.host.preview(null);
      return;
    }

    const applied = this.apply((session, kit) => {
      // Found in the document as it is now, not as the canvas last drew it:
      // the canvas may be showing the name half typed, over an older source.
      const ents = kit.entities(session.ed.result);
      const e = [...ents.nodes, ...ents.edges, ...ents.groups].find((x) => x.id === id);
      if (!e) return null;
      let node: Entity | undefined = e;
      if (!unchanged) {
        if (session.run(kit.rename(e, value)) === null) return false;
        // Renaming a class or an entity changes its id.
        const nodes = kit.entities(session.ed.result).nodes;
        node = nodes.find((n) => n.id === e.id) ?? nodes.find((n) => n.label === value);
      }
      if (then === "inside" && node && node.kind === "node") {
        const created = this.addIn(session, kit, node);
        if (created) return { select: created, edit: true };
      }
      if (then === "next" && node) {
        const created = session.run(kit.addAfter?.(node, kit.newLabel) ?? null);
        if (created && created.length > 0) return { select: created[0]!, edit: true };
      }
      // Nothing renamed and nothing added: nothing to write.
      if (unchanged) return null;
      return { select: e.id, orLabel: value };
    });
    // Refused: the canvas may still be showing the name as it was typed.
    if (!applied) this.host.preview(null);
  }

  // -------------------------------------------------------------------------
  // Pointer and keys
  // -------------------------------------------------------------------------

  focusCanvas(): void {
    this.host.canvas.focus({ preventScroll: true });
  }

  private onPointerDown(e: PointerEvent): void {
    // Anything but the primary button is the host's (a context menu).
    if (e.button !== 0 || !this.host.interactive() || !this.kit) return;
    // Take the press: otherwise the browser starts a text selection in the
    // editor around this block and the canvas never gets the keyboard.
    e.preventDefault();
    this.focusCanvas();
    const id = this.entityAt(e.target);
    const was = id !== null && this.selection === id;
    this.select(id);
    const entity = id ? this.found.get(id) : null;
    // A finger drags only what it has already selected: before that, a
    // stroke over the diagram is the page's scroll.
    if (!entity || (e.pointerType === "touch" && !was)) return;
    if (this.kit.move && entity.kind === "node" && !entity.root) this.dragIdea(e, entity);
    else if (this.kit.retime && entity.kind === "node" && entity.dates) this.dragBar(e, entity);
  }

  // -------------------------------------------------------------------------
  // Dragging
  // -------------------------------------------------------------------------

  /**
   * Follow a press until it is let go: nothing happens until it has moved a
   * few pixels (a press that does not move is a click). `move` is called with
   * the pointer as it goes, `drop` once it is let go — not on Escape or a
   * cancel, after which `end` tidies up either way.
   */
  private follow(
    down: PointerEvent,
    on: { start(): void; move(ev: PointerEvent): void; drop(ev: PointerEvent): void; end(): void },
  ): void {
    const x0 = down.clientX;
    const y0 = down.clientY;
    let started = false;
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      this.dragging = null;
      if (started) {
        delete this.host.root.dataset.dragging;
        on.end();
        this.paint();
      }
    };
    const move = (ev: PointerEvent): void => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        started = true;
        this.host.root.dataset.dragging = "true";
        this.hideChrome();
        on.start();
      }
      ev.preventDefault();
      on.move(ev);
    };
    const up = (ev: PointerEvent): void => {
      const was = started;
      if (was) on.drop(ev);
      stop();
    };
    const cancel = (): void => stop();
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape" || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    this.dragging = stop;
  }

  /** Whether `inner` is `outer` or anywhere under it, in a tree. */
  private within(inner: Entity, outer: Entity): boolean {
    const byId = new Map(this.entities.nodes.map((n) => [n.id, n]));
    for (let at: Entity | undefined = inner; at; at = at.parent ? byId.get(at.parent) : undefined) {
      if (at.id === outer.id) return true;
    }
    return false;
  }

  /** A mind map's idea, dragged onto another. */
  private dragIdea(down: PointerEvent, entity: Entity): void {
    const chip = el("div", "ce-mmd-drag");
    chip.textContent = entity.label;
    const line = el("div", "ce-mmd-dropline");
    let target: Entity | null = null;
    let place: DropPlace = "inside";
    const mark = (next: Entity | null): void => {
      if (target && target.id !== next?.id) {
        for (const n of this.elementsOf(target.id)) n.classList.remove("ce-mmd-target");
      }
      target = next;
      if (target) for (const n of this.elementsOf(target.id)) n.classList.add("ce-mmd-target");
    };
    this.follow(down, {
      start: () => {
        this.host.overlay.append(chip, line);
        for (const n of this.elementsOf(entity.id)) n.classList.add("ce-mmd-moving");
      },
      move: (ev) => {
        const origin = this.host.overlay.getBoundingClientRect();
        chip.style.left = `${ev.clientX - origin.left + 12}px`;
        chip.style.top = `${ev.clientY - origin.top + 12}px`;
        const over = this.nodeAt(ev.clientX, ev.clientY);
        const ok = over && !this.within(over, entity) ? over : null;
        mark(ok);
        const rect = ok ? this.rectOf(ok) : null;
        line.hidden = true;
        if (!ok || !rect) return;
        // The top and bottom quarters of an idea are beside it; the rest is
        // inside it. Nothing is beside the root.
        const y = ev.clientY - origin.top - rect.top;
        place = ok.root ? "inside" : y < rect.height / 4 ? "before" : y > (rect.height * 3) / 4 ? "after" : "inside";
        chip.dataset.place = place;
        if (place === "inside") return;
        line.hidden = false;
        Object.assign(line.style, {
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          top: `${place === "before" ? rect.top - 3 : rect.top + rect.height + 2}px`,
        });
      },
      drop: () => {
        const to = target;
        if (!to) return;
        const where = place;
        this.apply((session, kit) => {
          const created = session.run(kit.move?.(entity, to, where) ?? null);
          // Put back where it was: nothing to say.
          if (created === null) return null;
          return { select: created[0] ?? null };
        });
      },
      end: () => {
        mark(null);
        for (const n of this.elementsOf(entity.id)) n.classList.remove("ce-mmd-moving");
        chip.remove();
        line.remove();
      },
    });
  }

  /** Where a press on a Gantt task's bar is: an end of it, or its middle. */
  private barZone(entity: Entity, x: number): "start" | "end" | "both" {
    const bar = this.elementsOf(entity.id)[0]?.querySelector("rect");
    if (!bar) return "both";
    const r = bar.getBoundingClientRect();
    const edge = Math.min(8, r.width / 4);
    if (x >= r.right - edge) return "end";
    if (x <= r.left + edge) return "start";
    return "both";
  }

  /** The pointer over a bar's end says it can be pulled. */
  private onHover(e: PointerEvent): void {
    if (e.buttons !== 0 || this.dragging || !this.kit?.retime) return;
    const id = this.entityAt(e.target);
    const entity = id ? this.found.get(id) : null;
    const zone = entity?.dates ? this.barZone(entity, e.clientX) : null;
    if (zone && zone !== "both") this.host.root.dataset.barEdge = zone;
    else delete this.host.root.dataset.barEdge;
  }

  /** A Gantt task's bar, dragged whole or by an end, a day at a time. */
  private dragBar(down: PointerEvent, entity: Entity): void {
    const engine = this.host.runtime()?.engineNow();
    const svg = this.host.canvas.querySelector("svg") as SVGSVGElement | null;
    const times = engine?.ganttTimes?.(this.host.canvasSource());
    const index = this.entities.nodes.findIndex((n) => n.id === entity.id);
    const t = times?.[index];
    const g = this.elementsOf(entity.id)[0] as SVGGElement | undefined;
    if (!svg || !times || !t || !g) return;
    // How the chart is drawn: SVG units a millisecond, from any bar with a
    // length; the screen's pixels an SVG unit.
    let perMs = 0;
    let origin = 0;
    times.forEach((time, i) => {
      if (perMs || !time || time.end <= time.start) return;
      const n = this.entities.nodes[i];
      const rect = n && this.elementsOf(n.id)[0]?.querySelector("rect");
      if (!rect) return;
      perMs = Number(rect.getAttribute("width")) / (time.end - time.start);
      origin = Number(rect.getAttribute("x")) - time.start * perMs;
    });
    const scale = svg.getScreenCTM?.()?.a ?? 1;
    if (!perMs || !scale) return;
    const zone = this.barZone(entity, down.clientX);
    const rect = g.querySelector("rect");
    const label = g.querySelector("text");
    const saved = {
      transform: g.getAttribute("transform"),
      x: rect?.getAttribute("x") ?? null,
      width: rect?.getAttribute("width") ?? null,
      labelX: label?.getAttribute("x") ?? null,
    };
    const DAY = 86_400_000;
    const chip = el("div", "ce-mmd-drag ce-mmd-dates");
    let days = 0;
    const shifted = (ms: number, n: number): number => {
      const d = new Date(ms);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes()).getTime();
    };
    const span = (): { start: number; end: number } => {
      if (zone === "both") return { start: shifted(t.start, days), end: shifted(t.end, days) };
      if (zone === "end") return { start: t.start, end: Math.max(shifted(t.end, days), shifted(t.start, 1)) };
      return { start: Math.min(shifted(t.start, days), shifted(t.end, -1)), end: t.end };
    };
    const iso = (ms: number): string => {
      const d = new Date(ms);
      const two = (n: number): string => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    };
    const say = (ms: number): string =>
      new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    this.follow(down, {
      start: () => {
        this.host.overlay.appendChild(chip);
        g.classList.add("ce-mmd-moving");
        this.host.root.dataset.barDrag = zone;
      },
      move: (ev) => {
        days = Math.round((ev.clientX - down.clientX) / scale / perMs / DAY);
        const s = span();
        // Drawn where it would go: the bar moved, or its ends.
        if (zone === "both") g.setAttribute("transform", `translate(${(s.start - t.start) * perMs},0)`);
        else if (rect) {
          const x = origin + s.start * perMs;
          const w = (s.end - s.start) * perMs;
          rect.setAttribute("x", String(x));
          rect.setAttribute("width", String(w));
          label?.setAttribute("x", String(x + w / 2));
        }
        const origin2 = this.host.overlay.getBoundingClientRect();
        chip.textContent = `${say(s.start)} – ${say(shifted(s.end, -1))}`;
        chip.style.left = `${ev.clientX - origin2.left + 12}px`;
        chip.style.top = `${ev.clientY - origin2.top + 14}px`;
      },
      drop: () => {
        if (days === 0) return;
        const s = span();
        const to = { start: iso(s.start), end: iso(s.end), moved: zone };
        this.apply((session, kit) => {
          const ops = kit.retime?.(entity, to) ?? [];
          const before = session.code();
          for (const op of ops) session.run(op);
          return session.code() === before ? false : { select: entity.id };
        });
      },
      end: () => {
        g.classList.remove("ce-mmd-moving");
        delete this.host.root.dataset.barDrag;
        // Back as drawn: the drop, if it took, draws it again anyway.
        if (saved.transform === null) g.removeAttribute("transform");
        else g.setAttribute("transform", saved.transform);
        if (rect && saved.x !== null) rect.setAttribute("x", saved.x);
        if (rect && saved.width !== null) rect.setAttribute("width", saved.width);
        if (label && saved.labelX !== null) label.setAttribute("x", saved.labelX);
        chip.remove();
      },
    });
  }

  // -------------------------------------------------------------------------
  // The clipboard
  // -------------------------------------------------------------------------

  /** The words of what is selected — a mind map's idea with what is under
   *  it, as an outline. */
  private selectedText(): string | null {
    const e = this.current();
    const kit = this.kit;
    const visimer = this.host.runtime()?.visimerNow();
    if (!e || !kit) return null;
    if (!kit.copyText || !visimer) return e.label;
    return kit.copyText(e, openSession(visimer, this.host.source()).ed.result);
  }

  copySelected(): boolean {
    const text = this.selectedText();
    if (text === null) return false;
    // The block's own window's (a document in a frame has its own).
    const clip = this.host.root.ownerDocument?.defaultView?.navigator?.clipboard;
    const said = (): void => this.host.toast(this.host.runtime()?.labels.copied ?? "Copied");
    if (clip?.writeText) {
      void clip.writeText(text).then(said, () => this.copyByHand(text) && said());
    } else if (this.copyByHand(text)) said();
    return true;
  }

  /** Where `navigator.clipboard` is not to be had: the old way, through a
   *  field of our own. */
  private copyByHand(text: string): boolean {
    const field = this.clipField();
    field.value = text;
    field.focus({ preventScroll: true });
    field.select();
    let ok = false;
    try {
      ok = document.execCommand?.("copy") ?? false;
    } catch {
      ok = false;
    }
    this.focusCanvas();
    return ok;
  }

  private clipField(): HTMLTextAreaElement {
    if (this.clip) return this.clip;
    const field = el("textarea", "ce-mmd-clip");
    field.tabIndex = -1;
    field.setAttribute("aria-hidden", "true");
    field.addEventListener("paste", (ev) => {
      const text = (ev as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
      ev.preventDefault();
      this.focusCanvas();
      if (text.trim()) this.paste(text);
    });
    // Nothing is ever typed in it.
    field.addEventListener("blur", () => {
      field.value = "";
    });
    isolateInput(field);
    this.host.overlay.appendChild(field);
    this.clip = field;
    return field;
  }

  /**
   * Mod+V: the browser pastes into what has the focus as the key goes down,
   * and a canvas is not a field — so the focus goes to one of ours for that
   * moment, which hands what it was given to `paste`. (Reading the clipboard
   * outright asks the user's permission.)
   */
  private pasteHere(): void {
    const field = this.clipField();
    field.value = "";
    field.focus({ preventScroll: true });
  }

  /** Text pasted: added from the selection — a kit's own way (a mind map:
   *  an outline under the selected idea), else a new item a line. */
  paste(text: string): void {
    const from = this.current();
    this.apply((session, kit) => {
      if (kit.paste) {
        const created = session.run(kit.paste(from, text));
        return created ? { select: created[0] ?? null } : false;
      }
      const lines = text
        .split(/\r?\n/)
        .map((l) => oneLine(l))
        .filter((l) => l !== "")
        .slice(0, 50);
      let last: string | null = null;
      for (const line of lines) {
        const id = this.addIn(session, kit, from);
        if (!id) return false;
        const all = kit.entities(session.ed.result);
        const added = [...all.nodes, ...all.edges].find((n) => n.id === id);
        if (!added || session.run(kit.rename(added, line)) === null) return false;
        const after = kit.entities(session.ed.result).nodes;
        last = after.find((n) => n.id === id)?.id ?? after.find((n) => n.label === line)?.id ?? null;
      }
      return last ? { select: last } : false;
    });
  }

  private onDoubleClick(e: MouseEvent): void {
    if (!this.host.interactive() || !this.kit) return;
    e.preventDefault();
    const id = this.entityAt(e.target);
    if (id) this.startEdit(id);
    else this.addNode(null);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target !== this.host.canvas || !this.host.interactive() || !this.kit) return;
    const sel = this.current();
    const handled = (): void => {
      e.preventDefault();
      // Handled here: the editor must not also act on it.
      e.stopPropagation();
    };
    // Undo and redo are the document's. The editor leaves a key pressed on a
    // control inside a block to that control, so the canvas hands these on.
    const history = historyKey(e);
    if (history) {
      const editor = this.host.runtime()?.editor;
      if (!editor) return;
      handled();
      if (history === "undo") editor.undo();
      else editor.redo();
      return;
    }
    if (!sel) {
      if (e.key === "Escape") {
        handled();
        this.host.runtime()?.editor.focus();
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
        e.stopPropagation();
        this.pasteHere();
      }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === "c" || k === "x") {
        handled();
        this.copySelected();
        if (k === "x") this.removeSelected();
        return;
      }
      if (k === "v") {
        // Not prevented: the paste is the browser's, into our field.
        e.stopPropagation();
        this.pasteHere();
        return;
      }
    }
    // ⌥↑ / ⌥↓: an idea before the one above it, after the one below it.
    if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown") && this.kit.move && sel.parent) {
      handled();
      const siblings = this.entities.nodes.filter((n) => n.parent === sel.parent);
      const at = siblings.findIndex((n) => n.id === sel.id);
      const up = e.key === "ArrowUp";
      const next = siblings[at + (up ? -1 : 1)];
      if (!next) return;
      this.apply((session, kit) => {
        const created = session.run(kit.move?.(sel, next, up ? "before" : "after") ?? null);
        return created ? { select: created[0] ?? null } : null;
      });
      return;
    }
    switch (e.key) {
      case "Delete":
      case "Backspace":
        handled();
        this.removeSelected();
        return;
      case "Enter":
      case "F2":
        handled();
        // Enter renames, in every kind. With Shift, where things are in a
        // row, it is "and the next one".
        if (e.key === "Enter" && e.shiftKey && this.addNext(sel)) return;
        this.startEdit(sel.id);
        return;
      case "Tab":
        if (e.shiftKey || sel.kind !== "node") return;
        handled();
        this.addNode(sel);
        return;
      case "Escape":
        handled();
        this.select(null);
        return;
      case "ArrowUp":
        handled();
        this.step(0, -1);
        return;
      case "ArrowDown":
        handled();
        this.step(0, 1);
        return;
      case "ArrowLeft":
        handled();
        this.step(-1, 0);
        return;
      case "ArrowRight":
        handled();
        this.step(1, 0);
        return;
    }
    // A printable key: start typing over the label. The key itself is left
    // alone, so it lands in the field that now has the focus.
    if (e.key.length === 1 && !mod && !e.altKey && this.kit.rename(sel, sel.label) !== null) {
      e.stopPropagation();
      this.startEdit(sel.id);
    }
  }

  /** Move the selection to the nearest node in a direction. */
  private step(dx: number, dy: number): void {
    const from = this.current();
    const here = from ? this.rectOf(from) : null;
    if (!from || !here) return;
    const cx = here.left + here.width / 2;
    const cy = here.top + here.height / 2;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const n of this.entities.nodes) {
      if (n.id === from.id || !this.found.has(n.id)) continue;
      const r = this.rectOf(n);
      if (!r) continue;
      const vx = r.left + r.width / 2 - cx;
      const vy = r.top + r.height / 2 - cy;
      const along = vx * dx + vy * dy;
      if (along <= 1) continue;
      const across = Math.abs(vx * dy) + Math.abs(vy * dx);
      const score = along + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = n.id;
      }
    }
    if (best) this.select(best);
  }

  private nodeAt(x: number, y: number): Entity | null {
    const hit = document.elementFromPoint(x, y);
    const id = this.entityAt(hit);
    const e = id ? this.found.get(id) : null;
    return e && e.kind === "node" ? e : null;
  }

  private startConnect(e: PointerEvent): void {
    const from = this.current();
    if (e.button !== 0 || !from || from.kind !== "node" || !this.host.interactive()) return;
    e.preventDefault();
    e.stopPropagation();
    const start = this.rectOf(from);
    if (!start) return;
    const origin = this.host.overlay.getBoundingClientRect();
    const x1 = start.left + start.width / 2;
    const y1 = start.top + start.height / 2;
    const downX = e.clientX;
    const downY = e.clientY;
    let target: Entity | null = null;

    const mark = (next: Entity | null): void => {
      if (next?.id === target?.id) return;
      if (target) for (const n of this.elementsOf(target.id)) n.classList.remove("ce-mmd-target");
      target = next;
      if (target) for (const n of this.elementsOf(target.id)) n.classList.add("ce-mmd-target");
    };
    const draw = (x: number, y: number): void => {
      this.ghostLine.setAttribute("x1", String(x1));
      this.ghostLine.setAttribute("y1", String(y1));
      this.ghostLine.setAttribute("x2", String(x - origin.left));
      this.ghostLine.setAttribute("y2", String(y - origin.top));
    };
    this.ghost.style.display = "";
    this.host.root.dataset.connecting = "true";
    draw(downX, downY);

    const move = (ev: PointerEvent): void => {
      draw(ev.clientX, ev.clientY);
      const over = this.nodeAt(ev.clientX, ev.clientY);
      mark(over && over.id !== from.id ? over : null);
    };
    const end = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this.ghost.style.display = "none";
      delete this.host.root.dataset.connecting;
      const to = target;
      mark(null);
      this.focusCanvas();
      if (ev.type === "pointercancel") return;
      if (to) {
        this.connect(from, to);
      } else if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 30) {
        // Dropped on empty space: that is where a new one was wanted.
        this.addNode(from);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
}

/** ⌘Z / Ctrl+Z, ⌘⇧Z / Ctrl+Shift+Z and Ctrl+Y: the document's history keys. */
function historyKey(e: KeyboardEvent): "undo" | "redo" | null {
  if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey) return "redo";
  return null;
}
