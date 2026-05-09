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

function buildSeed(centre: Date, halfDays: number): SerializedDoc {
  const blocks: SerializedDoc["blocks"] = [];
  for (let i = -halfDays; i <= halfDays; i++) {
    const iso = formatIso(addDays(centre, i));
    blocks.push({ type: "date-marker", date: iso });
    blocks.push({ type: "p", runs: [] });
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
        threshold: 240,
        loadAfter: (ed) => {
          const last = lastDateMarkerIso(ed as unknown as Editor) ?? todayIso();
          const next = formatIso(addDays(parseIso(last), 1));
          (ed as unknown as Editor).appendBlocks(dayPair(next));
        },
        loadBefore: (ed) => {
          const first = firstDateMarkerIso(ed as unknown as Editor) ?? todayIso();
          const prev = formatIso(addDays(parseIso(first), -1));
          (ed as unknown as Editor).prependBlocks(dayPair(prev));
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
      // Centre the scroll position so both edges are within reach of
      // the threshold. The plugin's initial-fire logic will extend
      // either side as the user scrolls.
      requestAnimationFrame(() => {
        const sc = getScrollContainer();
        if (!sc) return;
        sc.scrollTop = Math.max(0, (sc.scrollHeight - sc.clientHeight) / 2);
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
