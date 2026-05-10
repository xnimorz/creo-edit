import { view, div, store, _ } from "creo";
import {
  calendarPlugin,
  createEditor,
  infiniteScrollPlugin,
  type BlockInsertInput,
  type Editor,
  type SerializedDoc,
} from "creo-edit";

// ---------------------------------------------------------------------------
// Two demos in one page:
//
//   1. Atomic-block contract — date-marker as a non-editable separator
//      block. Editable paragraphs sit between markers; the editor treats
//      the markers as caret-only-around (Backspace deletes the marker,
//      arrow keys step around it).
//
//   2. Infinite scroll — appendBlocks / prependBlocks on the editor +
//      infiniteScrollPlugin to wire scroll-near-edge → load more. The
//      plugin captures scrollTop before a prepend and re-applies the
//      delta after the next frame so the viewport stays anchored.
//
// The two compose, but they're independent — atomic blocks work without
// infinite scroll; infinite scroll works with any block kinds.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
void DAY_MS;

function todayIso(): string {
  return formatIso(new Date());
}
function formatIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function dayPair(date: string): BlockInsertInput[] {
  // One date marker followed by one empty paragraph — that pair is the
  // "unit" the journal grows / shrinks by.
  return [
    { type: "date-marker", date } as BlockInsertInput,
    { type: "p", runs: [] } as BlockInsertInput,
  ];
}

// Number of days a single load-event appends or prepends. Loading one
// day at a time looks unresponsive on a fast mousewheel — the user
// out-scrolls the loader and hits the actual bottom. A week's worth of
// days per fire keeps the buffer comfortably ahead.
const DAYS_PER_LOAD = 7;

function dayBatch(startIso: string, count: number): BlockInsertInput[] {
  const out: BlockInsertInput[] = [];
  for (let i = 0; i < count; i++) {
    const d = formatIso(addDays(parseIso(startIso), i));
    out.push(...dayPair(d));
  }
  return out;
}

// The "how to initialise this demo" snippet rendered as a code block
// under today's date marker. Showing the actual init code keeps users
// looking at the source they'd write themselves.
const INIT_SNIPPET = `import {
  createEditor,
  calendarPlugin,
  infiniteScrollPlugin,
} from "creo-edit";

const editor = createEditor({
  plugins: [
    calendarPlugin(),
    infiniteScrollPlugin({
      scrollContainer: () => document.querySelector(".my-wrap"),
      loadAfter:  (ed) => ed.appendBlocks(nextDay(ed)),
      loadBefore: (ed) => ed.prependBlocks(prevDay(ed)),
    }),
  ],
  initial: { blocks: seedDays(new Date(), 10) },
});`;

function buildSeed(centre: Date, halfDays: number): SerializedDoc {
  const blocks: SerializedDoc["blocks"] = [];
  const todayKey = formatIso(centre);
  for (let i = -halfDays; i <= halfDays; i++) {
    const iso = formatIso(addDays(centre, i));
    blocks.push({ type: "date-marker", date: iso });
    if (iso === todayKey) {
      // Today's slot starts with a code block that shows the user how
      // this very page is wired up — followed by an empty paragraph for
      // their own notes.
      blocks.push({
        type: "code",
        lang: "ts",
        runs: [{ text: INIT_SNIPPET }],
      });
      blocks.push({ type: "p", runs: [] });
    } else {
      blocks.push({ type: "p", runs: [] });
    }
  }
  return { blocks };
}

function lastDateMarkerIso(editor: Editor): string | null {
  const doc = editor.docStore.get();
  for (let i = doc.order.length - 1; i >= 0; i--) {
    const b = doc.byId.get(doc.order[i]!);
    if (b && b.type === "date-marker") {
      return (b as { date: string }).date;
    }
  }
  return null;
}

function firstDateMarkerIso(editor: Editor): string | null {
  const doc = editor.docStore.get();
  for (const id of doc.order) {
    const b = doc.byId.get(id);
    if (b && b.type === "date-marker") {
      return (b as { date: string }).date;
    }
  }
  return null;
}

// Inline sample-code constant kept around in case we re-introduce
// explanatory copy later — currently the demo page is editor-only.
void 0;

function buildEditor(getScrollContainer: () => HTMLElement | null): Editor {
  let editor: Editor;
  editor = createEditor({
    plugins: [
      calendarPlugin(),
      infiniteScrollPlugin({
        scrollContainer: getScrollContainer,
        // Generous threshold + a week-per-load batch keeps the buffer
        // comfortably ahead of a fast mousewheel. Loading one day at a
        // time means a single wheel flick races past the loader and
        // dumps the user at the actual end of doc.
        threshold: 600,
        // Tight cooldown — a fast wheel fires many scroll events per
        // frame; the default 60ms means every other event was bailed
        // and the user out-scrolled the loader.
        cooldownMs: 16,
        loadAfter: (ed) => {
          const last = lastDateMarkerIso(ed as unknown as Editor) ?? todayIso();
          const start = formatIso(addDays(parseIso(last), 1));
          (ed as unknown as Editor).appendBlocks(dayBatch(start, DAYS_PER_LOAD));
        },
        loadBefore: (ed) => {
          const first = firstDateMarkerIso(ed as unknown as Editor) ?? todayIso();
          // Prepending: build the batch oldest-first so the inserted
          // order in the doc stays chronological.
          const start = formatIso(addDays(parseIso(first), -DAYS_PER_LOAD));
          (ed as unknown as Editor).prependBlocks(dayBatch(start, DAYS_PER_LOAD));
        },
      }),
    ],
    // Seed ~21 days centred on today so the viewport overflows at
    // mount on most screens (each day is ~80px → ~1700px). Hosts that
    // expect very tall viewports should seed more; the infinite-scroll
    // plugin then takes over as the user scrolls.
    initial: buildSeed(new Date(), 10),
  });
  return editor;
}

export const AtomicBlocksDemo = view(() => {
  // The plugin needs a getter so the scroll container can be looked up
  // lazily — the editor mounts before the wrapper div is queryable.
  const getScrollContainer = (): HTMLElement | null =>
    document.querySelector(".atomic-journal-scroll") as HTMLElement | null;

  const editorStore = store.new<Editor>(buildEditor(getScrollContainer));

  return {
    onMount() {
      requestAnimationFrame(() => {
        const sc = getScrollContainer();
        if (!sc) return;
        // Centre the scroll position so both edges are within reach of
        // the plugin's threshold.
        sc.scrollTop = Math.max(0, (sc.scrollHeight - sc.clientHeight) / 2);
        // Park the caret on a VISIBLE empty paragraph rather than
        // leaving it at end-of-doc (which is below the viewport).
        // Otherwise the browser's focus-scroll yanks the journal
        // downward on the user's first click — the click target moves
        // out from under the cursor before the click commits, so the
        // native selection never updates and the editor effectively
        // ignores the click.
        const ed = editorStore.get();
        const doc = ed.docStore.get();
        const scRect = sc.getBoundingClientRect();
        for (const id of doc.order) {
          const blk = doc.byId.get(id);
          if (!blk || blk.type !== "p") continue;
          const el = sc.querySelector<HTMLElement>(
            `.atomic-journal-editor p[data-block-id="${id}"]`,
          );
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.top >= scRect.top && r.bottom <= scRect.bottom) {
            ed.selStore.set({
              kind: "caret",
              at: { blockId: id, path: [0], offset: 0 },
            });
            return;
          }
        }
      });
    },
    render() {
      const ed = editorStore.get();
      // Editor-only demo page — no surrounding copy. The full-bleed
      // layout removes the sidebar (see Layout.isFullBleed) so the
      // editor takes the full content area.
      div({ class: "atomic-journal-scroll" }, () => {
        ed.EditorView({ class: "atomic-journal-editor" });
      });
      void _;
    },
  };
});
