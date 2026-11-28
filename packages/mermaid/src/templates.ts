import type { MermaidTemplate } from "./types";

// Starter diagrams offered by an empty block. Small on purpose: a starter is
// something to edit, and every node here is one the user would have to delete
// if it were not theirs. All but the pie are types the visual editor can
// edit, so someone who never opens Code mode still gets somewhere.
export const defaultMermaidTemplates: readonly MermaidTemplate[] = [
  {
    id: "flowchart",
    title: "Flowchart",
    source: "flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]",
  },
  {
    id: "sequence",
    title: "Sequence",
    source: "sequenceDiagram\n  participant User\n  participant App\n  User->>App: Request\n  App-->>User: Response",
  },
  {
    id: "state",
    title: "State",
    source: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]",
  },
  {
    id: "class",
    title: "Class",
    source: "classDiagram\n  class Animal {\n    +String name\n    +speak()\n  }\n  class Dog\n  Animal <|-- Dog",
  },
  {
    id: "er",
    title: "Entities",
    source: "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ ITEM : contains",
  },
  {
    id: "mindmap",
    title: "Mind map",
    source: "mindmap\n  root((Topic))\n    Idea one\n    Idea two\n      Detail",
  },
  {
    id: "gantt",
    title: "Gantt",
    source: "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :a1, 2026-01-05, 5d\n  Implement :after a1, 10d",
  },
  {
    id: "pie",
    title: "Pie",
    source: 'pie title Share\n  "First" : 45\n  "Second" : 35\n  "Third" : 20',
  },
  {
    id: "timeline",
    title: "Timeline",
    source: "timeline\n  title History\n  2024 : Idea\n  2025 : Prototype\n  2026 : Launch",
  },
];

/** What a bare `mermaid.insert` shows when asked for a starter by id. */
export function templateSource(
  templates: readonly MermaidTemplate[],
  id: string,
): string | null {
  return templates.find((t) => t.id === id)?.source ?? null;
}
