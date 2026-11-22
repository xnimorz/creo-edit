import "../../../__tests__/setup";
import { describe, expect, test } from "bun:test";
import { MermaidWysiwygEditor } from "@visimer/core";
import { render } from "pele";
import {
  correlate,
  ENTITY_ATTR,
  kitFor,
  openSession,
  type VisimerEditor,
  type VisimerModule,
} from "../kits";

// The correlator rests on something Pele does not document: the `data-id`
// values in its SVG. So these run BOTH real libraries — a Pele or visimer
// upgrade that shifts either side fails here, not in a user's diagram.

const visimer = { MermaidWysiwygEditor } as unknown as VisimerModule;
const open = (code: string): VisimerEditor =>
  new visimer.MermaidWysiwygEditor({ code });

function drawn(code: string) {
  const host = document.createElement("div");
  host.innerHTML = render(code).svg;
  const ed = open(code);
  const kit = kitFor(ed.result)!;
  const entities = kit.entities(ed.result);
  const found = correlate(host, kit, entities);
  const tagged = (id: string) =>
    Array.from(host.querySelectorAll(`[${ENTITY_ATTR}="${id}"]`));
  return { host, ed, kit, entities, found, tagged };
}

describe("mermaid kits — correlation with Pele's SVG", () => {
  test("flowchart: nodes by id, edges by order, subgraphs", () => {
    const d = drawn(`flowchart LR
  A[Start] --> B{OK?} --> C
  A --> B
  B --> D & E
  subgraph S1 [Group]
    D --> X((x))
  end`);
    expect(d.kit.type).toBe("flowchart");
    expect(d.entities.nodes.map((n) => n.id)).toEqual([
      "node:A", "node:B", "node:C", "node:D", "node:E", "node:X",
    ]);
    for (const n of d.entities.nodes) expect(d.tagged(n.id).length).toBe(1);
    // The second A→B is `edge:A->B#1` to visimer and `L_A_B_2` to Pele; order
    // is what pairs them.
    const second = d.tagged("edge:A->B#1");
    expect(second.length).toBeGreaterThan(0);
    expect(second[0]!.getAttribute("data-id")).toBe("L_A_B_2");
    expect(d.found.size).toBe(6 + 6 + 1);
    expect(d.tagged("subgraph:S1").length).toBe(1);
    expect(d.kit.direction(d.ed.result)).toBe("LR");
  });

  test("state: states by id, transitions by order; [*] is not editable", () => {
    const d = drawn(`stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Idle : stop`);
    expect(d.kit.type).toBe("state");
    expect(d.tagged("state:Idle").length).toBe(1);
    expect(d.tagged("state:Running").length).toBe(1);
    expect(d.entities.edges.length).toBe(3);
    for (const e of d.entities.edges) expect(d.tagged(e.id).length).toBeGreaterThan(0);
    expect(d.host.querySelector(".pele-state-start")!.hasAttribute(ENTITY_ATTR)).toBe(false);
  });

  test("sequence: participants, and events in numeric order", () => {
    const d = drawn(`sequenceDiagram
  participant A as Alice
  A->>Bob: Hello
  Bob-->>A: Hi
  Note over A,Bob: note`);
    expect(d.kit.type).toBe("sequence");
    // Head and foot of each lifeline are both the participant.
    expect(d.tagged("participant:A").length).toBeGreaterThan(0);
    expect(d.entities.edges.map((e) => e.label)).toEqual(["Hello", "Hi", "note"]);
    const first = d.tagged(d.entities.edges[0]!.id);
    expect(first.some((el) => el.getAttribute("data-id") === "i0")).toBe(true);
    const note = d.tagged(d.entities.edges[2]!.id);
    expect(note.some((el) => el.getAttribute("data-id") === "i2")).toBe(true);
  });

  test("class and ER diagrams", () => {
    const c = drawn(`classDiagram
  class Animal
  Animal <|-- Dog`);
    expect(c.tagged("class:Animal").length).toBe(1);
    expect(c.tagged(c.entities.edges[0]!.id).length).toBeGreaterThan(0);
    const e = drawn(`erDiagram
  CUSTOMER ||--o{ ORDER : places`);
    expect(e.tagged("entity:CUSTOMER").length).toBe(1);
    expect(e.tagged(e.entities.edges[0]!.id).length).toBeGreaterThan(0);
  });

  test("a type with no kit is view-only", () => {
    expect(kitFor(open("pie\n  \"a\" : 1").result)).toBeNull();
    expect(kitFor(open("").result)).toBeNull();
  });
});

describe("mermaid kits — operations produce source Pele still draws", () => {
  const cases: [string, string][] = [
    ["flowchart", "flowchart TD\n  %% keep me\n  A[Start] --> B{OK?}"],
    ["state", "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : go"],
    ["sequence", "sequenceDiagram\n  Alice->>Bob: Hello"],
    ["class", "classDiagram\n  class Animal\n  Animal <|-- Dog"],
    ["er", "erDiagram\n  CUSTOMER ||--o{ ORDER : places"],
  ];

  for (const [name, src] of cases) {
    test(`${name}: add, connect, rename, delete`, () => {
      const s = openSession(visimer, src);
      const kit = kitFor(s.ed.result)!;
      const ents = () => kit.entities(s.ed.result);
      const first = ents().nodes[0]!;

      const created = s.run(kit.add(kit.newLabel));
      expect(created).not.toBeNull();
      expect(created!.length).toBe(1);
      const added = ents().nodes.find((n) => n.id === created![0])!;
      expect(added).toBeDefined();

      expect(s.run(kit.connect!(first, added))).not.toBeNull();
      expect(ents().edges.length).toBeGreaterThan(1);

      const to = name === "class" || name === "er" ? "RENAMED" : "Renamed it";
      expect(s.run(kit.rename(added, to))).not.toBeNull();
      expect(() => render(s.code())).not.toThrow();

      expect(s.run(kit.rename(ents().edges[0]!, "label"))).not.toBeNull();
      expect(() => render(s.code())).not.toThrow();

      // The node just added sits on the last lines of the source, next to the
      // edge that reaches it — the exact shape visimer 1.1.4 throws on
      // without a trailing newline. `openSession` is what makes this pass.
      const again = ents().nodes.find((n) => n.label.toLowerCase().startsWith("renamed"))!;
      expect(again).toBeDefined();
      expect(s.run(kit.remove(again))).not.toBeNull();
      expect(ents().nodes.some((n) => n.id === again.id)).toBe(false);
      expect(() => render(s.code())).not.toThrow();
      // The source had no trailing newline, so the result has none either.
      expect(s.code().endsWith("\n")).toBe(false);
      if (name === "flowchart") expect(s.code()).toContain("%% keep me");
    });
  }

  test("flowchart: shape, line, reverse, direction", () => {
    const s = openSession(visimer, "flowchart TD\n  A --> B\n  subgraph G [Group]\n    B --> C\n  end");
    const kit = kitFor(s.ed.result)!;
    const ents = () => kit.entities(s.ed.result);
    s.run(kit.setShape!(ents().nodes[1]!, "diamond"));
    expect(s.code()).toContain("B{");
    s.run(kit.setLine!(ents().edges[0]!, "dotted"));
    expect(s.code()).toContain("-.->");
    expect(s.run(kit.reverse!(ents().edges[0]!))).not.toBeNull();
    s.run(kit.setDirection!("LR"));
    expect(s.code().startsWith("flowchart LR")).toBe(true);
    expect(s.run(kit.rename(ents().groups[0]!, "Renamed group"))).not.toBeNull();
    expect(s.code()).toContain("Renamed group");
    // A subgraph can be renamed but not deleted — visimer has no such edit.
    expect(kit.remove(ents().groups[0]!)).toBeNull();
    expect(() => render(s.code())).not.toThrow();
  });

  test("an operation that cannot apply returns null and leaves the source", () => {
    const s = openSession(visimer, "flowchart TD\n  A --> B");
    expect(s.run({ type: "deleteNode", id: "nope" })).toBeNull();
    expect(s.run(null)).toBeNull();
    expect(s.code()).toBe("flowchart TD\n  A --> B");
  });
});
