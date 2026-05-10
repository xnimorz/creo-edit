import { view, div, store, _ } from "creo";
import {
  createEditor,
  searchPlugin,
  type Editor,
  type SerializedDoc,
} from "creo-edit";

// ---------------------------------------------------------------------------
// Search + virtualization demo. A long document (~500 paragraphs) rendered
// through the virtualized renderer, with the search plugin claiming Cmd+F.
// All three match-options (case, whole-word, regex) are exposed as toggles
// in the panel.
//
// The demo seeds prose-style text so search has plenty to chew on. Sentences
// rotate through a small lexicon so the same words repeat enough to produce
// dozens-to-hundreds of matches per query.
// ---------------------------------------------------------------------------

// Lexicon — short word lists that get spliced together below. The themes
// (editor, virtualization, search) match what the user is looking at, so
// queries like "editor" or "virtualization" return many hits.
const SUBJECTS = [
  "the editor",
  "this paragraph",
  "the virtual renderer",
  "the search plugin",
  "the document model",
  "the caret",
  "every block",
  "the keymap",
];
const VERBS = [
  "renders",
  "scrolls",
  "highlights",
  "tracks",
  "mounts",
  "skips",
  "matches",
  "indexes",
];
const OBJECTS = [
  "every block in view",
  "the active selection",
  "matches across the whole document",
  "off-screen content lazily",
  "the scroll container",
  "thousands of paragraphs",
  "without mutating the DOM",
  "the inline runs of each block",
];
const TAILS = [
  "thanks to the height index.",
  "even when virtualization is on.",
  "while staying responsive on long documents.",
  "with a single anchor mapping pass.",
  "courtesy of the CSS Custom Highlight API.",
  "without disturbing the caret.",
  "in O(log n) per scroll event.",
  "so you can find what you wrote yesterday.",
];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length]!;
}

function paragraphText(i: number): string {
  // Two-sentence paragraph — enough text to make match-density realistic.
  const a = `${pick(SUBJECTS, i)} ${pick(VERBS, i + 1)} ${pick(OBJECTS, i + 2)} ${pick(TAILS, i + 3)}`;
  const b = `Paragraph ${i + 1} also mentions the word "search" so navigation across hundreds of matches is easy to try.`;
  return `${a[0]!.toUpperCase()}${a.slice(1)} ${b}`;
}

const PARAGRAPH_COUNT = 500;

const INTRO = `This is a long document — ${PARAGRAPH_COUNT} paragraphs of mostly-repetitive prose, rendered through the virtualized renderer so only the visible blocks live in the DOM at any moment.`;
const HOW = `Press Cmd+F (Mac) or Ctrl+F (Windows / Linux) to open the search panel. Try queries like "editor", "search", "virtualization". The result counter is total across the whole document — even matches in blocks that haven't been mounted yet. Click ↑ / ↓ (or Enter / Shift+Enter) to jump; the next match scrolls into view, mounts the off-screen block, then highlights it.`;
const TIPS = `Toggles in the panel: Aa = match case, W = whole word, .* = regex. They re-scan as you change them.`;

function buildSeed(): SerializedDoc {
  const blocks: SerializedDoc["blocks"] = [
    { type: "h1", runs: [{ text: "Long-document search demo" }] },
    { type: "p", runs: [{ text: INTRO }] },
    { type: "p", runs: [{ text: HOW }] },
    { type: "p", runs: [{ text: TIPS }] },
    { type: "h2", runs: [{ text: "Body" }] },
  ];
  for (let i = 0; i < PARAGRAPH_COUNT; i++) {
    blocks.push({ type: "p", runs: [{ text: paragraphText(i) }] });
  }
  return { blocks };
}

function buildEditor(): Editor {
  return createEditor({
    virtualized: true,
    plugins: [
      searchPlugin({
        interceptBrowserFind: true,
        toggles: {
          caseSensitive: { initial: false, show: true },
          wholeWord: { initial: false, show: true },
          regex: { initial: false, show: true },
        },
      }),
    ],
    initial: buildSeed(),
  });
}

export const SearchDemo = view(() => {
  const editorStore = store.new<Editor>(buildEditor());

  return {
    render() {
      const ed = editorStore.get();
      div({ class: "search-demo-scroll" }, () => {
        ed.EditorView({ class: "search-demo-editor" });
      });
      void _;
    },
  };
});
