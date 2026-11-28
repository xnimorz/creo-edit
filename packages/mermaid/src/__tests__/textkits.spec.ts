import "../../../../src/__tests__/setup";
import { describe, expect, test } from "bun:test";
import { MermaidWysiwygEditor } from "@visimer/core";
import { render } from "pele";
import {
  correlate,
  ENTITY_ATTR,
  kitFor,
  openSession,
  type DiagramKit,
  type Entity,
  type EditSession,
  type VisimerModule,
} from "../kits";
import { dayFormat, readGantt } from "../gantt";
import { readMindmap } from "../mindmap";
import { readTimeline } from "../timeline";
import { decodeLabel, encodeLabel, remapId, remapLine } from "../textkit";

// A mind map, a timeline and a Gantt chart are edited by this package's own
// reading of their source (`textkit.ts`), paired with Pele's drawing by ORDER.
// Both rest on what Pele does, not on what it documents — so, as in
// `kits.spec.ts`, these run the real libraries: what an edit writes has to be
// something Pele draws, and draws as what was meant.

const visimer = { MermaidWysiwygEditor } as unknown as VisimerModule;

type Open = {
  s: EditSession;
  kit: DiagramKit;
  nodes(): Entity[];
  groups(): Entity[];
  node(label: string): Entity;
  /** Run an operation; the source after it. */
  run(op: ReturnType<DiagramKit["add"]> | null): string;
};

function open(source: string): Open {
  const s = openSession(visimer, source);
  const kit = kitFor(s.ed.result)!;
  const nodes = (): Entity[] => kit.entities(s.ed.result).nodes;
  return {
    s,
    kit,
    nodes,
    groups: () => kit.entities(s.ed.result).groups,
    node: (label) => nodes().find((n) => n.label === label)!,
    run(op) {
      expect(s.run(op)).not.toBeNull();
      return s.code();
    },
  };
}

/** The words Pele draws for `source`, in the order it draws them. */
function words(source: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = render(source).svg;
  return Array.from(host.querySelectorAll("text"))
    .map((t) => (t.textContent ?? "").trim())
    .filter((t) => t !== "");
}

/** The same, without spaces: a long label is drawn on several lines, and
 *  where one breaks the space is not drawn. */
const letters = (source: string): string[] => words(source).map((w) => w.replace(/\s+/g, ""));

/** Draw `source` and pair it with its entities, as the visual layer does. */
function drawn(source: string) {
  const host = document.createElement("div");
  host.innerHTML = render(source).svg;
  const s = openSession(visimer, source);
  const kit = kitFor(s.ed.result)!;
  const entities = kit.entities(s.ed.result);
  const found = correlate(host, kit, entities);
  const of = (id: string): Element | null =>
    Array.from(host.querySelectorAll(`[${ENTITY_ATTR}]`)).find((n) => n.getAttribute(ENTITY_ATTR) === id) ?? null;
  return { host, kit, entities, found, of };
}

describe("text kits — what they share", () => {
  test("a line is followed over lines added and removed around it", () => {
    const before = "a\nb\nc\nd";
    expect(remapLine(before, before, 2)).toBe(2);
    // Added above: it moves down. Added below: it stays.
    expect(remapLine(before, "a\nNEW\nb\nc\nd", 2)).toBe(3);
    expect(remapLine(before, "a\nb\nc\nd\nNEW", 2)).toBe(2);
    expect(remapLine(before, "b\nc\nd", 2)).toBe(1);
    // Rewritten where it stands (someone renamed it): still that line.
    expect(remapLine(before, "a\nb\nC!\nd", 2)).toBe(2);
    // Removed: gone, not the line that took its place.
    expect(remapLine(before, "a\nb\nd", 2)).toBeNull();
    expect(remapId(before, "NEW\na\nb\nc\nd", "event:2:1")).toBe("event:3:1");
    expect(remapId(before, "a\nb\nd", "idea:2")).toBeNull();
    // An id that is a name, not a line, is not touched.
    expect(remapId(before, "x", "node:A")).toBe("node:A");
  });

  test("a label is written with what its place cannot hold as codes, and read back", () => {
    expect(encodeLabel("a (b) [c]", "()[]{}")).toBe("a #40;b#41; #91;c#93;");
    expect(decodeLabel("a #40;b#41; #91;c#93;")).toBe("a (b) [c]");
    // A `#` that would itself read as a code is one.
    expect(encodeLabel("tag #x; y", "")).toBe("tag #35;x; y");
    expect(decodeLabel(encodeLabel("tag #x; y", ""))).toBe("tag #x; y");
    expect(encodeLabel("#1 priority", "")).toBe("#1 priority");
    expect(decodeLabel("10#58;30 #quot;x#quot; #colon; #nope; #99999999;")).toBe('10:30 "x" : #nope; #99999999;');
  });
});

describe("mind maps", () => {
  const MAP = `mindmap
  root((Project))
    Plan
      Scope
      Budget
    b1[Build]
    ::icon(fa fa-wrench)
      Tests
    Tests
`;

  test("read as an outline: whose each idea is, its shape, its last line", () => {
    const ideas = readMindmap(open(MAP).s.ed.result);
    expect(ideas.map((i) => [i.label, i.shape, i.id, i.parent, i.line, i.last])).toEqual([
      ["Project", "circle", "root", -1, 1, 8],
      ["Plan", "default", "", 0, 2, 4],
      ["Scope", "default", "", 1, 3, 3],
      ["Budget", "default", "", 1, 4, 4],
      // Its icon line is its own; the idea under it comes after that.
      ["Build", "rect", "b1", 0, 5, 7],
      ["Tests", "default", "", 4, 7, 7],
      ["Tests", "default", "", 0, 8, 8],
    ]);
  });

  test("paired with the drawing by order — two ideas may say the same", () => {
    const d = drawn(MAP);
    expect(d.kit.type).toBe("mindmap");
    expect(d.found.size).toBe(7);
    for (const n of d.entities.nodes) {
      expect(d.of(n.id)!.querySelector("text")!.textContent).toBe(n.label);
    }
    expect(d.of("idea:1")!.classList.contains("pele-root")).toBe(true);
    // The two "Tests" are two elements, each its own line's.
    expect(d.of("idea:7")).not.toBe(d.of("idea:8"));
    expect(d.entities.nodes[0]!.root).toBe(true);
  });

  test("an id that is written must be the one drawn there, or nothing is paired", () => {
    const d = drawn(MAP);
    d.host.querySelector(".pele-node[data-id=b1]")!.setAttribute("data-id", "other");
    for (const el of Array.from(d.host.querySelectorAll(`[${ENTITY_ATTR}]`))) el.removeAttribute(ENTITY_ATTR);
    expect(correlate(d.host, d.kit, d.entities).size).toBe(0);
  });

  test("+ adds an idea under one, after all that is under it already", () => {
    const o = open(MAP);
    const created = o.s.run(o.kit.add("New idea", undefined, o.node("Plan")));
    expect(created).toEqual(["idea:5"]);
    expect(o.s.code()).toBe(MAP.replace("      Budget\n", "      Budget\n      New idea\n"));
    // Under one with nothing under it yet: one step deeper.
    expect(o.run(o.kit.add("Deeper", undefined, o.node("Scope")))).toContain("      Scope\n        Deeper\n");
    // Under nothing: under the root, at its children's depth.
    expect(o.run(o.kit.add("Last"))).toMatch(/\n    Tests\n    Last\n$/);
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("Enter adds the next idea beside one — after everything under it", () => {
    const o = open(MAP);
    const created = o.s.run(o.kit.addAfter!(o.node("Plan"), "New idea"));
    expect(created).toEqual(["idea:5"]);
    expect(o.s.code()).toContain("      Budget\n    New idea\n    b1[Build]");
    // Its decoration stays with the idea it dresses.
    expect(o.run(o.kit.addAfter!(o.node("Build"), "After build"))).toContain(
      "    ::icon(fa fa-wrench)\n      Tests\n    After build\n",
    );
    // The root has nothing beside it: the next one is under it.
    const root = o.nodes()[0]!;
    expect(o.run(o.kit.addAfter!(root, "Under root"))).toMatch(/\n    Under root\n$/);
  });

  test("an empty mind map gets its root", () => {
    const o = open("mindmap");
    expect(o.s.run(o.kit.add("Topic"))).toEqual(["idea:1"]);
    expect(o.s.code()).toBe("mindmap\n  Topic");
    expect(words(o.s.code())).toEqual(["Topic"]);
  });

  test("renaming changes the words and nothing else", () => {
    const o = open(MAP);
    expect(o.run(o.kit.rename(o.node("Project"), "The plan"))).toContain("  root((The plan))\n");
    expect(o.run(o.kit.rename(o.node("Build"), "Make"))).toContain("    b1[Make]\n    ::icon(fa fa-wrench)\n");
    expect(o.run(o.kit.rename(o.node("Scope"), "What is in"))).toContain("      What is in\n      Budget\n");
    // No words is no rename.
    expect(o.s.run(o.kit.rename(o.node("Budget"), "  "))).toBeNull();
  });

  test("words the outline's grammar would read as brackets still draw as typed", () => {
    for (const [shape, line] of [
      ["default", "Plan"],
      ["rect", "p[Plan]"],
      ["circle", "p((Plan))"],
      ["rect", 'p["Plan"]'],
    ] as const) {
      const o = open(`mindmap\n  root\n    ${line}\n`);
      const label = 'a (b) [c] {d} "e" 100% ::x #tag;';
      const next = o.run(o.kit.rename(o.node("Plan"), label));
      expect(letters(next)).toContain(label.replace(/\s+/g, ""));
      const again = open(next).node(label);
      expect(again.shape).toBe(shape);
      expect(again.label).toBe(label);
    }
    // Bare words that would be read as a decoration of the idea above.
    const o = open("mindmap\n  root\n    Plan\n");
    const next = o.run(o.kit.rename(o.node("Plan"), ":::urgent"));
    expect(open(next).nodes().map((n) => n.label)).toEqual(["root", ":::urgent"]);
    expect(words(next)).toContain(":::urgent");
  });

  test("a shape is its brackets: the words stay as they are written", () => {
    const o = open(MAP);
    expect(o.run(o.kit.setShape!(o.node("Plan"), "hexagon"))).toContain("    {{Plan}}\n");
    expect(o.run(o.kit.setShape!(o.node("Plan"), "cloud"))).toContain("    )Plan(\n");
    expect(o.run(o.kit.setShape!(o.node("Plan"), "default"))).toContain("    Plan\n");
    // An id is kept while there are brackets for it to stand before.
    expect(o.run(o.kit.setShape!(o.node("Build"), "round"))).toContain("    b1(Build)\n");
    expect(o.run(o.kit.setShape!(o.node("Build"), "default"))).toContain("    Build\n    ::icon");
    expect(o.s.run(o.kit.setShape!(o.node("Build"), "default"))).toBeNull();
    expect(() => render(o.s.code())).not.toThrow();
    // Quoted words can hold what bare ones cannot: out of the brackets they
    // are written again.
    const q = open('mindmap\n  root\n    p["a (b)"]\n');
    const bare = q.run(q.kit.setShape!(q.node("a (b)"), "default"));
    expect(bare).toBe("mindmap\n  root\n    a #40;b#41;\n");
    expect(words(bare)).toContain("a (b)");
    for (const s of q.kit.shapes!) {
      const p = open(MAP);
      const next = s.key === "default" ? MAP : p.run(p.kit.setShape!(p.node("Plan"), s.key));
      expect(open(next).node("Plan").shape).toBe(s.key);
      expect(() => render(next)).not.toThrow();
    }
  });

  test("removing an idea removes what is under it; the root stays", () => {
    const o = open(MAP);
    expect(o.run(o.kit.remove(o.node("Build")))).toBe(
      "mindmap\n  root((Project))\n    Plan\n      Scope\n      Budget\n    Tests\n",
    );
    expect(o.run(o.kit.remove(o.node("Tests")))).toMatch(/      Budget\n$/);
    expect(o.kit.remove(o.nodes()[0]!)).toBeNull();
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("an idea is moved with all under it: inside another, before or after it", () => {
    const o = open(MAP);
    const before = o.nodes().map((n) => [n.label, n.parent ?? null]);
    expect(before.slice(0, 3)).toEqual([["Project", null], ["Plan", "idea:1"], ["Scope", "idea:2"]]);
    // Build (and its icon, and Tests under it) into Plan, as its last.
    const created = o.s.run(o.kit.move!(o.node("Build"), o.node("Plan"), "inside"));
    expect(created).toEqual(["idea:5"]);
    expect(o.s.code()).toBe(
      "mindmap\n  root((Project))\n    Plan\n      Scope\n      Budget\n      b1[Build]\n      ::icon(fa fa-wrench)\n        Tests\n    Tests\n",
    );
    expect(words(o.s.code())).toContain("Build");
    // Back out, before Plan.
    expect(o.run(o.kit.move!(o.node("Build"), o.node("Plan"), "before"))).toBe(
      "mindmap\n  root((Project))\n    b1[Build]\n    ::icon(fa fa-wrench)\n      Tests\n    Plan\n      Scope\n      Budget\n    Tests\n",
    );
    // A leaf after a sibling of its parent; deeper ideas take its depth.
    expect(o.run(o.kit.move!(o.node("Scope"), o.nodes().at(-1)!, "after"))).toMatch(/\n    Tests\n    Scope\n$/);
    // Onto the root is inside it; nothing goes inside itself; the root stays.
    expect(o.s.run(o.kit.move!(o.node("Build"), o.node("Tests"), "inside"))).toBeNull();
    expect(o.s.run(o.kit.move!(o.nodes()[0]!, o.node("Plan"), "inside"))).toBeNull();
    expect(o.run(o.kit.move!(o.node("Budget"), o.nodes()[0]!, "before"))).toMatch(/\n    Scope\n    Budget\n$/);
    // Where it already is: nothing to write.
    expect(o.s.run(o.kit.move!(o.node("Budget"), o.nodes()[0]!, "inside"))).toBeNull();
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("copied as an outline of its words; an outline pasted is ideas, as deep as indented", () => {
    const o = open(MAP);
    expect(o.kit.copyText!(o.node("Plan"), o.s.ed.result)).toBe("Plan\n  Scope\n  Budget");
    expect(o.kit.copyText!(o.node("Scope"), o.s.ed.result)).toBe("Scope");
    expect(o.kit.copyText!(o.node("Build"), o.s.ed.result)).toBe("Build\n  Tests");
    const created = o.s.run(o.kit.paste!(o.node("Scope"), "Plan\n  Scope (v2)\n\n  Budget\n    - Q1\r\n"));
    expect(created).toEqual(["idea:4"]);
    expect(o.s.code()).toContain(
      "      Scope\n        Plan\n          Scope #40;v2#41;\n          Budget\n            Q1\n      Budget\n",
    );
    expect(words(o.s.code())).toContain("Scope (v2)");
    // With nothing selected, under the root.
    expect(o.run(o.kit.paste!(null, "Loose"))).toMatch(/\n    Tests\n    Loose\n$/);
    expect(o.s.run(o.kit.paste!(null, "  \n"))).toBeNull();
  });

  test("the source keeps its last line's ending, comments and tabs", () => {
    const o = open("mindmap\n\troot\n\t\t%% note\n\t\tA");
    expect(o.run(o.kit.add("B", undefined, o.node("A")))).toBe("mindmap\n\troot\n\t\t%% note\n\t\tA\n\t\t\tB");
    expect(o.run(o.kit.remove(o.node("B")))).toBe("mindmap\n\troot\n\t\t%% note\n\t\tA");
  });
});

describe("timelines", () => {
  const TL = `timeline
  title History
  section Early
  2019 : Idea
       : Prototype
  2021 : Launch : Mobile app
  section Later
  2024
`;

  test("read as periods owning events, on their line or under it", () => {
    const t = readTimeline(open(TL).s.ed.result);
    expect(t.title!.label).toBe("History");
    expect(t.sections.map((s) => s.label)).toEqual(["Early", "Later"]);
    expect(t.periods.map((p) => [p.label, p.lines, p.events.map((e) => [e.label, e.line, e.index])])).toEqual([
      ["2019", [3, 4], [["Idea", 3, 0], ["Prototype", 4, 0]]],
      ["2021", [5], [["Launch", 5, 0], ["Mobile app", 5, 1]]],
      ["2024", [7], []],
    ]);
  });

  test("a colon inside words is words; one a space follows starts an event", () => {
    const t = readTimeline(open("timeline\n  2024 : at 10:30 sharp : a:b :c\n").s.ed.result);
    expect(t.periods[0]!.events.map((e) => e.label)).toEqual(["at 10:30 sharp", "a:b :c"]);
    expect(words("timeline\n  2024 : at 10:30 sharp : a:b :c\n")).toEqual(["2024", "at 10:30 sharp", "a:b :c"]);
  });

  test("paired with the drawing: events inside their period, in order", () => {
    const d = drawn(TL);
    expect(d.kit.type).toBe("timeline");
    const text = (id: string): string => {
      const el = d.of(id)!;
      return (el.matches("text") ? el : el.querySelector("text"))!.textContent!.trim();
    };
    for (const e of [...d.entities.nodes, ...d.entities.groups]) expect(text(e.id)).toBe(e.label);
    expect(d.entities.nodes.map((n) => `${n.sub}:${n.label}`)).toEqual([
      "period:2019", "event:Idea", "event:Prototype",
      "period:2021", "event:Launch", "event:Mobile app",
      "period:2024",
    ]);
    expect(d.entities.groups.map((g) => g.sub)).toEqual(["title", "section", "section"]);
    // An event is drawn inside its period: the innermost is what a click hits.
    expect(d.of("period:3")!.contains(d.of("event:4:0"))).toBe(true);
  });

  test("an event is added as a line of its own under its period", () => {
    const o = open(TL);
    const created = o.s.run(o.kit.add("ignored", undefined, o.node("2019")));
    expect(created).toEqual(["event:5:0"]);
    expect(o.s.code()).toContain("  2019 : Idea\n       : Prototype\n       : New event\n  2021");
    // From one of its events: the same period's. Under the period's colon.
    expect(o.run(o.kit.addAfter!(o.node("Launch"), "x"))).toContain(
      "  2021 : Launch : Mobile app\n       : New event\n  section Later",
    );
    // A period with no event yet.
    expect(o.run(o.kit.add("x", undefined, o.node("2024")))).toMatch(/  2024\n    : New event\n$/);
    expect(words(o.s.code()).filter((w) => w === "New event").length).toBe(3);
  });

  test("a period is added after one, or at the end", () => {
    const o = open(TL);
    const created = o.s.run(o.kit.addAfter!(o.node("2019"), "2020"));
    expect(created).toEqual(["period:5"]);
    expect(o.s.code()).toContain("       : Prototype\n  2020\n  2021 : Launch");
    expect(o.run(o.kit.add("2030"))).toMatch(/  2024\n  2030\n$/);
    expect(words(o.s.code())).toContain("2030");
    const empty = open("timeline");
    expect(empty.s.run(empty.kit.add("Now"))).toEqual(["period:1"]);
    expect(empty.s.code()).toBe("timeline\n  Now");
  });

  test("renaming a title, a section, a period, an event", () => {
    const o = open(TL);
    const [title, early] = o.groups();
    expect(o.run(o.kit.rename(title!, "Our story: so far"))).toContain("  title Our story: so far\n");
    expect(o.run(o.kit.rename(early!, "Before"))).toContain("  section Before\n");
    expect(o.run(o.kit.rename(o.node("2019"), "Year one"))).toContain("  Year one : Idea\n");
    expect(o.run(o.kit.rename(o.node("Mobile app"), "Apps"))).toContain("  2021 : Launch : Apps\n");
    expect(o.run(o.kit.rename(o.node("Prototype"), "Demo"))).toContain("       : Demo\n");
    expect(() => render(o.s.code())).not.toThrow();
    // What a name cannot hold is written as its code, and drawn as typed.
    const next = o.run(o.kit.rename(o.node("Year one"), "10:30 #1; x"));
    expect(next).toContain("  10#58;30 #35;1#59; x : Idea\n");
    expect(words(next)).toContain("10:30 #1; x");
    const ev = o.run(o.kit.rename(o.node("Idea"), "at 10:30: go; #2"));
    expect(ev).toContain(" : at 10:30#58; go#59; #35;2\n");
    expect(words(ev)).toContain("at 10:30: go; #2");
    expect(open(ev).node("at 10:30: go; #2")).toBeDefined();
  });

  test("removing an event takes its colon; alone on its line, the line", () => {
    const o = open(TL);
    expect(o.run(o.kit.remove(o.node("Launch")))).toContain("  2021 : Mobile app\n");
    expect(o.run(o.kit.remove(o.node("Mobile app")))).toContain("  2021\n  section Later");
    expect(o.run(o.kit.remove(o.node("Prototype")))).toContain("  2019 : Idea\n  2021\n");
    expect(o.run(o.kit.remove(o.node("Idea")))).toContain("  2019\n  2021\n");
    expect(words(o.s.code())).toEqual(["History", "Early", "2019", "2021", "Later", "2024"]);
  });

  test("removing a period takes its events' lines; a section, its heading only", () => {
    const o = open(TL);
    expect(o.run(o.kit.remove(o.node("2019")))).toBe(
      "timeline\n  title History\n  section Early\n  2021 : Launch : Mobile app\n  section Later\n  2024\n",
    );
    expect(o.run(o.kit.remove(o.groups()[2]!))).toBe(
      "timeline\n  title History\n  section Early\n  2021 : Launch : Mobile app\n  2024\n",
    );
    expect(o.run(o.kit.remove(o.groups()[0]!))).not.toContain("title");
    // Events of a period written past a section's heading: the heading stays.
    const split = open("timeline\n  2019 : A\n  section S\n  : B\n  2020 : C\n");
    expect(split.run(split.kit.remove(split.node("2019")))).toBe("timeline\n  section S\n  2020 : C\n");
  });
});

describe("Gantt charts", () => {
  const G = `gantt
  title Release
  dateFormat YYYY-MM-DD
  section Build
  Design :done, d1, 2026-01-05, 5d
  Implement :crit, active, 2026-01-12, 10d
  Test :3d
  section Ship
  Launch :milestone, after d1, 0d
`;

  test("read: how many values a task has says what they are", () => {
    const g = readGantt(open(G).s.ed.result);
    expect(g.title!.label).toBe("Release");
    expect(g.sections.map((s) => s.label)).toEqual(["Build", "Ship"]);
    expect(
      g.tasks.map((t) => [t.label, t.marks.map((m) => m.text), t.id?.text ?? null, t.from?.text ?? null, t.until?.text ?? null]),
    ).toEqual([
      ["Design", ["done"], "d1", "2026-01-05", "5d"],
      ["Implement", ["crit", "active"], null, "2026-01-12", "10d"],
      ["Test", [], null, null, "3d"],
      ["Launch", ["milestone"], null, "after d1", "0d"],
    ]);
    // Settings are not tasks, whatever colon they hold.
    const odd = readGantt(open("gantt\n  accTitle: x\n  todayMarker off\n  dateFormatter :1d\n  click a href \"x:y\"\n").s.ed.result);
    expect(odd.tasks.map((t) => t.label)).toEqual(["dateFormatter"]);
  });

  test("paired with the drawing: tasks by order, sections and the title", () => {
    const d = drawn(G);
    expect(d.kit.type).toBe("gantt");
    for (const n of d.entities.nodes) {
      expect(d.of(n.id)!.querySelector("text")!.textContent).toBe(n.label);
    }
    expect(d.of("task:4")!.getAttribute("data-id")).toBe("d1");
    expect(d.entities.nodes.map((n) => n.flags)).toEqual([["done"], ["crit", "active"], [], ["milestone"]]);
    expect(d.entities.nodes.map((n) => n.fields)).toEqual([
      { start: "2026-01-05", length: "5d" },
      { start: "2026-01-12", length: "10d" },
      { start: "", length: "3d" },
      { start: "after d1", length: "0d" },
    ]);
    expect(d.of("section:3")!.textContent).toBe("Build");
    expect(d.of("title:1")!.textContent!.trim()).toBe("Release");
    // A section with nothing in it is written and not drawn: the others are
    // still found, by name.
    const e = drawn("gantt\n  section Empty\n  section Build\n  A :1d\n");
    expect(e.of("section:1")).toBeNull();
    expect(e.of("section:2")!.textContent).toBe("Build");
  });

  test("a task is added after one, or at the end, starting where the one before ends", () => {
    const o = open(G);
    const created = o.s.run(o.kit.add("New task", undefined, o.node("Design")));
    expect(created).toEqual(["task:5"]);
    expect(o.s.code()).toContain("  Design :done, d1, 2026-01-05, 5d\n  New task :1d\n  Implement");
    expect(o.run(o.kit.add("Last"))).toMatch(/  Launch :milestone, after d1, 0d\n  Last :1d\n$/);
    expect(() => render(o.s.code())).not.toThrow();
    const empty = open("gantt\n  dateFormat YYYY-MM-DD\n  section Plan");
    expect(empty.run(empty.kit.add("First"))).toBe("gantt\n  dateFormat YYYY-MM-DD\n  section Plan\n  First :1d");
    const bare = open("gantt");
    expect(bare.run(bare.kit.add("First"))).toBe("gantt\n  First :1d");
  });

  test("renaming and removing change one name, one line", () => {
    const o = open(G);
    expect(o.run(o.kit.rename(o.node("Design"), "Design: v2 #1"))).toContain(
      "  Design#58; v2 #35;1 :done, d1, 2026-01-05, 5d\n",
    );
    expect(words(o.s.code())).toContain("Design: v2 #1");
    const [title, build] = o.groups();
    expect(o.run(o.kit.rename(title!, "Q1"))).toContain("  title Q1\n");
    expect(o.run(o.kit.rename(build!, "Make"))).toContain("  section Make\n");
    expect(o.run(o.kit.remove(o.node("Test")))).not.toContain("Test");
    expect(o.run(o.kit.remove(o.groups()[2]!))).not.toContain("section Ship");
    expect(readGantt(o.s.ed.result).tasks.length).toBe(3);
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("a mark is one word in, one word out", () => {
    const o = open(G);
    expect(o.run(o.kit.setFlag!(o.node("Test"), "crit", true))).toContain("  Test :crit, 3d\n");
    expect(o.run(o.kit.setFlag!(o.node("Test"), "crit", false))).toContain("  Test :3d\n");
    // Under way or finished, not both.
    expect(o.run(o.kit.setFlag!(o.node("Implement"), "done", true))).toContain(
      "  Implement :done, crit, 2026-01-12, 10d\n",
    );
    expect(o.run(o.kit.setFlag!(o.node("Design"), "done", false))).toContain("  Design :d1, 2026-01-05, 5d\n");
    expect(o.s.run(o.kit.setFlag!(o.node("Design"), "done", false))).toBeNull();
    expect(o.s.run(o.kit.setFlag!(o.node("Design"), "nope", true))).toBeNull();
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("the length is the last value, typed as a person would", () => {
    const o = open(G);
    const length = (task: string, typed: string): string =>
      o.run(o.kit.setField!(o.node(task), "length", typed, () => undefined));
    expect(length("Test", "5")).toContain("  Test :5d\n");
    expect(length("Test", "2 weeks")).toContain("  Test :2w\n");
    expect(length("Test", "12 Hours")).toContain("  Test :12h\n");
    expect(length("Test", "3M")).toContain("  Test :3M\n");
    expect(length("Design", "2026-01-20")).toContain("  Design :done, d1, 2026-01-05, 2026-01-20\n");
    expect(o.s.run(o.kit.setField!(o.node("Design"), "length", " ", () => undefined))).toBeNull();
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("the start: a date goes in, comes out, and leaves the rest of the line", () => {
    const o = open(G);
    const start = (task: string, typed: string): string =>
      o.run(o.kit.setField!(o.node(task), "start", typed, () => undefined));
    // One value becomes two…
    expect(start("Test", "2026-02-01")).toContain("  Test :2026-02-01, 3d\n");
    // …and two become one again: after the task before it.
    expect(start("Test", "")).toContain("  Test :3d\n");
    expect(start("Implement", "2026-01-13")).toContain("  Implement :crit, active, 2026-01-13, 10d\n");
    expect(start("Design", "2026-01-06")).toContain("  Design :done, d1, 2026-01-06, 5d\n");
    expect(start("Launch", "after d1 d1")).toContain("  Launch :milestone, after d1 d1, 0d\n");
    expect(() => render(o.s.code())).not.toThrow();
  });

  test("“after” a task by its name gives that task the id it needs", () => {
    const ids = ["k7", "k8", "k9"];
    const o = open(G);
    const start = (task: string, typed: string): string =>
      o.run(o.kit.setField!(o.node(task), "start", typed, () => ids.shift()));
    // It has an id already.
    expect(start("Test", "after design")).toContain("  Test :after d1, 3d\n");
    // It has a start: the id goes before it.
    expect(start("Launch", "after Implement")).toBe(
      G.replace("Test :3d", "Test :after d1, 3d")
        .replace("active, 2026-01-12", "active, k7, 2026-01-12")
        .replace("after d1, 0d", "after k7, 0d"),
    );
    expect(() => render(o.s.code())).not.toThrow();

    // It has only a length — it starts after the one before it, and with an
    // id it has to say so; that one may need an id for it, and so on up.
    const chain = open("gantt\n  dateFormat YYYY-MM-DD\n  A :2026-01-05, 2d\n  B :3d\n  C :1d\n  D :1d\n");
    const next = chain.run(chain.kit.setField!(chain.node("D"), "start", "after C", () => undefined));
    expect(next).toBe(
      "gantt\n  dateFormat YYYY-MM-DD\n  A :t1, 2026-01-05, 2d\n  B :t2, after t1, 3d\n  C :t3, after t2, 1d\n  D :after t3, 1d\n",
    );
    expect(() => render(next)).not.toThrow();
    // Nothing above to start after, itself, a name nobody has: not applied.
    const none = open("gantt\n  A :2d\n  B :1d\n");
    const set = (task: string, typed: string): string[] | null =>
      none.s.run(none.kit.setField!(none.node(task), "start", typed, () => undefined));
    expect(set("B", "after A")).toBeNull();
    expect(set("B", "after B")).toBeNull();
    expect(set("B", "after Nobody")).toBeNull();
    expect(none.s.code()).toBe("gantt\n  A :2d\n  B :1d\n");
  });

  test("a day picked is written the chart's way, and a date of the chart read back as a day", () => {
    const iso = dayFormat("YYYY-MM-DD")!;
    expect(iso.write("2026-01-05")).toBe("2026-01-05");
    expect(iso.read("2026-01-05")).toBe("2026-01-05");
    expect([iso.read("after a1"), iso.read("5d"), iso.read(""), iso.read("2026-13-01"), iso.read("2026-1-5")]).toEqual([null, null, null, null, null]);
    const eu = dayFormat("DD.MM.YYYY")!;
    expect([eu.write("2026-01-05"), eu.read("05.01.2026"), eu.read("05x01x2026")]).toEqual(["05.01.2026", "2026-01-05", null]);
    const loose = dayFormat("D/M/YYYY")!;
    expect([loose.write("2026-01-05"), loose.read("5/1/2026"), loose.read("25/12/2026")]).toEqual(["5/1/2026", "2026-01-05", "2026-12-25"]);
    // More than a day, or less: no picker — the date is typed.
    for (const f of ["YYYY-MM-DD HH:mm", "MMM D, YYYY", "YY-MM-DD", "MM-DD", "YYYY-MM-DD-DD", "X"]) expect(dayFormat(f)).toBeNull();

    const o = open("gantt\n  dateFormat DD.MM.YYYY\n  A :a, 05.01.2026, 2d\n  B :after a, 12.01.2026\n  C :3d\n");
    expect(o.nodes().map((n) => n.dates)).toEqual([
      { start: "2026-01-05", length: null },
      { start: null, length: "2026-01-12" },
      { start: null, length: null },
    ]);
    expect(o.run(o.kit.setDate!(o.node("A"), "start", "2026-01-07"))).toContain("  A :a, 07.01.2026, 2d\n");
    expect(o.run(o.kit.setDate!(o.node("B"), "length", "2026-01-20"))).toContain("  B :after a, 20.01.2026\n");
    // A task with only a length: the day picked for its start goes before it.
    expect(o.run(o.kit.setDate!(o.node("C"), "start", "2026-02-02"))).toContain("  C :02.02.2026, 3d\n");
    expect(o.s.run(o.kit.setDate!(o.node("C"), "start", "tomorrow"))).toBeNull();
    expect(() => render(o.s.code())).not.toThrow();
    const timed = open("gantt\n  dateFormat YYYY-MM-DD HH:mm\n  A :2026-01-05 09:00, 2d\n");
    expect(timed.nodes()[0]!.dates).toBeUndefined();
    expect(timed.s.run(timed.kit.setDate!(timed.node("A"), "start", "2026-01-07"))).toBeNull();
  });

  test("a bar dragged: moved whole, or by an end — its length kept as a length, a date as a date", () => {
    const o = open("gantt\n  dateFormat YYYY-MM-DD\n  A :a, 2026-01-05, 5d\n  B :after a, 3d\n  C :2026-01-20, 2026-01-25\n  M :milestone, 2026-01-30, 0d\n");
    const run = (label: string, to: { start: string; end: string; moved: "start" | "end" | "both" }) => {
      for (const op of o.kit.retime!(o.node(label), to)) o.s.run(op);
      return o.s.code();
    };
    // Moved whole: the start; a length stays what it was.
    expect(run("A", { start: "2026-01-07", end: "2026-01-12", moved: "both" })).toContain("  A :a, 2026-01-07, 5d\n");
    // A task after another, put somewhere: a day of its own now.
    expect(run("B", { start: "2026-01-14", end: "2026-01-17", moved: "both" })).toContain("  B :2026-01-14, 3d\n");
    // Its end pulled: a length again, in days.
    expect(run("B", { start: "2026-01-14", end: "2026-01-19", moved: "end" })).toContain("  B :2026-01-14, 5d\n");
    // Its start pulled: the end stays where it was.
    expect(run("B", { start: "2026-01-16", end: "2026-01-19", moved: "start" })).toContain("  B :2026-01-16, 3d\n");
    // An end that is a date stays a date, moved with the bar too.
    expect(run("C", { start: "2026-01-21", end: "2026-01-26", moved: "both" })).toContain("  C :2026-01-21, 2026-01-26\n");
    expect(run("C", { start: "2026-01-21", end: "2026-01-28", moved: "end" })).toContain("  C :2026-01-21, 2026-01-28\n");
    expect(run("M", { start: "2026-02-02", end: "2026-02-02", moved: "both" })).toContain("  M :milestone, 2026-02-02, 0d\n");
    expect(() => render(o.s.code())).not.toThrow();
    // A chart that leaves days out: a length counts only the days kept, so an
    // end pulled is written as its date. One that counts its end day: the day before.
    const ex = open("gantt\n  dateFormat YYYY-MM-DD\n  excludes weekends\n  A :2026-01-05, 5d\n");
    for (const op of ex.kit.retime!(ex.node("A"), { start: "2026-01-05", end: "2026-01-15", moved: "end" })) ex.s.run(op);
    expect(ex.s.code()).toContain("  A :2026-01-05, 2026-01-15\n");
    const inc = open("gantt\n  dateFormat YYYY-MM-DD\n  inclusiveEndDates\n  A :2026-01-05, 2026-01-09\n");
    for (const op of inc.kit.retime!(inc.node("A"), { start: "2026-01-05", end: "2026-01-13", moved: "end" })) inc.s.run(op);
    expect(inc.s.code()).toContain("  A :2026-01-05, 2026-01-12\n");
  });

  test("a task with an id cannot leave its start out: it names the one before", () => {
    const o = open("gantt\n  dateFormat YYYY-MM-DD\n  A :a, 2026-01-05, 2d\n  B :b, 2026-02-01, 1d\n");
    expect(o.run(o.kit.setField!(o.node("B"), "start", "", () => undefined))).toContain("  B :b, after a, 1d\n");
    expect(o.s.run(o.kit.setField!(o.node("A"), "start", "", () => undefined))).toBeNull();
  });
});
