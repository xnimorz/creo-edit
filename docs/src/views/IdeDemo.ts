import { view, div, h1, h2, p, button, span, _ } from "creo";
import {
  createEditor,
  mapAnchor,
  updateBlock,
  type Anchor,
  type AnchorRange,
  type Block,
  type CodeBlock,
  type DecorationDef,
  type DocChange,
  type Editor,
  type EditorPlugin,
  type InlineRun,
  type InlineWidgetDef,
  type RangeDecorationDef,
  type SerializedDoc,
} from "creo-edit";

// ---------------------------------------------------------------------------
// "IDE affordances" demo.
//
// Every feature below exists because a code editor needs it, and each one is
// wired to a real API rather than mocked:
//
//   run attrs            → syntax tokens on each run's span
//   decoration targets   → a per-LINE gutter (line numbers + change bars)
//   range decorations    → a diagnostic squiggle and a comment highlight,
//                          overlapping the syntax tokens without touching them
//   inline widgets       → an inlay hint mid-line and multi-line ghost text
//   onChange + mapAnchor → a pinned comment that follows its text as you edit
//   editable             → a read-only toggle
//
// Type in the editor and watch all six stay correct together.
// ---------------------------------------------------------------------------

const SEED_CODE = [
  "function totalPrice(items) {",
  "  const total = items",
  '    .filter((i) => i.kind === "book")',
  "    .reduce((sum, i) => sum + i.price, 0);",
  "  // resualt is rounded to cents",
  "  return Math.round(total * 100) / 100;",
  "}",
].join("\n");

/** The deliberate typo the diagnostic underlines. */
const TYPO = "resualt";
/** The identifier the inlay hint annotates. */
const HINTED = "const total";

// ---------------------------------------------------------------------------
// Syntax tokens — feature: InlineRun.attrs
//
// A host recomputes these from the text; they are view-only and never
// serialize. This is a toy tokenizer, deliberately — the point is the seam,
// not the lexer.
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  "function", "const", "let", "var", "return", "if", "else", "for", "while",
  "new", "await", "async", "export", "import", "from", "type", "interface",
  "class", "extends", "typeof", "instanceof",
]);

const TOKEN_RE =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;

function classFor(m: RegExpExecArray): string | undefined {
  if (m[1]) return "tok-comment";
  if (m[2]) return "tok-string";
  if (m[3]) return "tok-number";
  if (m[4]) return KEYWORDS.has(m[4]) ? "tok-keyword" : undefined;
  return undefined;
}

function tokenize(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const cls = classFor(m);
    const last = runs[runs.length - 1];
    // Merge into the previous run when the styling matches, so the DOM gets
    // one span per token rather than one per character.
    if (last && (last.attrs?.class ?? undefined) === cls) {
      runs[runs.length - 1] = cls
        ? { text: last.text + m[0], attrs: { class: cls } }
        : { text: last.text + m[0] };
    } else {
      runs.push(cls ? { text: m[0], attrs: { class: cls } } : { text: m[0] });
    }
  }
  return runs;
}

function runsEqual(a: InlineRun[], b: InlineRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.text !== b[i]!.text) return false;
    if ((a[i]!.attrs?.class ?? "") !== (b[i]!.attrs?.class ?? "")) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small helpers over the code block.
// ---------------------------------------------------------------------------

function findCodeBlock(editor: Editor): CodeBlock | null {
  const doc = editor.docStore.get();
  for (const id of doc.order) {
    const b = doc.byId.get(id);
    if (b && b.type === "code") return b as CodeBlock;
  }
  return null;
}

function codeText(editor: Editor): string {
  const b = findCodeBlock(editor);
  return b ? b.runs.map((r) => r.text).join("") : "";
}

const at = (blockId: string, offset: number): Anchor => ({
  blockId,
  path: [offset],
  offset,
});

/** Text between two anchors in the same block — what a pinned comment covers. */
function textBetween(editor: Editor, from: Anchor, to: Anchor): string {
  const doc = editor.docStore.get();
  const b = doc.byId.get(from.blockId) as { runs?: InlineRun[] } | undefined;
  if (!b?.runs) return "";
  return b.runs.map((r) => r.text).join("").slice(from.offset, to.offset);
}

// `use(initialValue)` creates a view-bound reactive store: reading it during
// render subscribes this view, so a `.set()` from an event handler or from
// `editor.onChange` re-renders the panels below.
export const IdeDemo = view(({ use }) => {
  // ---- Feature toggles -------------------------------------------------
  const readOnly = use(false);
  const showGutter = use(true);
  const showDiagnostic = use(true);
  const showWidgets = use(true);

  // ---- Pinned comment (onChange + mapAnchor) ---------------------------
  // A range held OUTSIDE the document, the way a review comment or an LSP
  // diagnostic would be. It has to survive edits before it, inside it, and
  // around it — and honestly report when its text is gone.
  const pin = use<AnchorRange | null>(null);
  const pinText = use<string>("");
  const pinState = use<"none" | "live" | "detached">("none");
  const changeLog = use<string[]>([]);

  // ---- Decorations: a per-line gutter ----------------------------------
  const gutter: DecorationDef = {
    id: "ide-gutter",
    layer: "left",
    slotWidth: 52,
    // Every code line is the same height and they stack contiguously, so the
    // manager measures only the first one per frame instead of all N.
    uniformTargets: true,
    match: (b: Block) => b.type === "code",
    // THE feature: anchor to the block's lines, not to the block.
    targets: (_b, blockEl) =>
      Array.from(blockEl.querySelectorAll<HTMLElement>(".ce-code-line")),
    mount(_block, _target, host, _handle, index) {
      if (!showGutter.get()) return;
      host.classList.add("ide-gutter");
      const num = document.createElement("span");
      num.className = "ide-gutter-num";
      num.textContent = String(index + 1);
      // A change bar on the lines a diff would have touched.
      const bar = document.createElement("span");
      bar.className = index === 4 ? "ide-bar ide-bar-changed" : "ide-bar";
      host.append(bar, num);
    },
  };

  // ---- Range decorations: diagnostic + comment -------------------------
  // Both overlap the syntax tokens. Painted through the CSS Custom Highlight
  // API, so neither one splits a span or disturbs the character-offset walk.
  const diagnostic: RangeDecorationDef = {
    id: "ide-diagnostic",
    className: "ide-diagnostic",
    priority: 20,
    ranges(doc) {
      if (!showDiagnostic.get()) return [];
      for (const id of doc.order) {
        const b = doc.byId.get(id);
        if (!b || b.type !== "code") continue;
        const text = (b as CodeBlock).runs.map((r) => r.text).join("");
        const i = text.indexOf(TYPO);
        if (i < 0) return [];
        return [{ from: at(id, i), to: at(id, i + TYPO.length) }];
      }
      return [];
    },
  };

  const commentRange: RangeDecorationDef = {
    id: "ide-comment",
    className: "ide-comment",
    priority: 10,
    ranges() {
      const r = pin.get();
      return r ? [r] : [];
    },
  };

  // ---- Inline widgets: inlay hint + ghost text -------------------------
  const inlayHint: InlineWidgetDef = {
    id: "inlay",
    affinity: "after",
    interactive: false,
    at(doc) {
      if (!showWidgets.get()) return [];
      for (const id of doc.order) {
        const b = doc.byId.get(id);
        if (!b || b.type !== "code") continue;
        const text = (b as CodeBlock).runs.map((r) => r.text).join("");
        const i = text.indexOf(HINTED);
        if (i < 0) return [];
        return [{ anchor: at(id, i + HINTED.length), data: ": number" }];
      }
      return [];
    },
    mount(host, ctx) {
      host.classList.add("ide-inlay");
      host.textContent = String(ctx.data ?? "");
    },
  };

  const ghostText: InlineWidgetDef = {
    id: "ghost",
    affinity: "after",
    interactive: false,
    at(doc) {
      if (!showWidgets.get()) return [];
      for (const id of doc.order) {
        const b = doc.byId.get(id);
        if (!b || b.type !== "code") continue;
        const text = (b as CodeBlock).runs.map((r) => r.text).join("");
        return [{ anchor: at(id, text.length) }];
      }
      return [];
    },
    mount(host) {
      host.classList.add("ide-ghost");
      // Multi-line, exactly like a real completion — and completely invisible
      // to the character-offset walk, so the anchors above it don't move.
      host.textContent = "\n\nfunction formatPrice(cents) {\n  return `$${(cents / 100).toFixed(2)}`;\n}";
    },
  };

  const idePlugin: EditorPlugin = {
    name: "ide-demo",
    decorations: [gutter],
    rangeDecorations: [diagnostic, commentRange],
    inlineWidgets: [inlayHint, ghostText],
  };

  const seed: SerializedDoc = {
    blocks: [
      { type: "h2", runs: [{ text: "totalPrice.js" }] },
      { type: "code", runs: [{ text: SEED_CODE }], lang: "js" },
      {
        type: "p",
        runs: [
          {
            text:
              "Edit the code above. The gutter, the squiggle, the hint and the pinned comment all stay correct.",
          },
        ],
      },
    ],
  };

  const editor = createEditor({ initial: seed, plugins: [idePlugin] });

  // ---- Syntax tokens, recomputed from the text on every change ---------
  // Writing runs straight into the doc store is exactly how a real
  // highlighter would work: `attrs` is derived view state, not authored
  // content, so it never round-trips through toJSON().
  const retokenize = (): void => {
    const doc = editor.docStore.get();
    const b = findCodeBlock(editor);
    if (!b) return;
    const next = tokenize(b.runs.map((r) => r.text).join(""));
    // Idempotent: the no-op case bails before touching the store, so this
    // subscription can't feed itself.
    if (runsEqual(b.runs, next)) return;
    editor.docStore.set(updateBlock(doc, { ...b, runs: next } as Block));
  };
  editor.docStore.subscribe(() => queueMicrotask(retokenize));
  retokenize();

  // ---- Pinned comment tracking ----------------------------------------
  const describe = (c: DocChange): string => {
    switch (c.kind) {
      case "text":
        return c.insertedLength === 0
          ? `delete [${c.from},${c.to})`
          : c.from === c.to
            ? `insert ${c.insertedLength} @${c.from}`
            : `replace [${c.from},${c.to}) with ${c.insertedLength}`;
      case "split":
        return `split @${c.at}`;
      case "merge":
        return `merge → @${c.atOffset}`;
      case "insertBlock":
        return `+block @${c.index}`;
      case "removeBlock":
        return "−block";
      case "resetBlock":
        return "reset block";
      case "replaceDoc":
        return "replace doc";
    }
  };

  editor.onChange((changes) => {
    changeLog.set([
      ...changes.map(describe),
      ...changeLog.get(),
    ].slice(0, 6));
    const cur = pin.get();
    if (!cur) return;
    // Bias outward: text typed at either edge stays inside the comment.
    const from = mapAnchor(cur.from, changes, "right");
    const to = mapAnchor(cur.to, changes, "left");
    // `mapAnchor` maps ONE anchor. Mapping a range means mapping both ends —
    // and deleting the text between them collapses the pair rather than
    // nulling either one, because neither endpoint is strictly inside the
    // deleted span. A host tracking a range has to treat a collapse as
    // "the covered text is gone" itself.
    if (!from || !to || from.offset >= to.offset) {
      pin.set(null);
      pinText.set("");
      pinState.set("detached");
      editor.refreshRangeDecorations();
      return;
    }
    pin.set({ from, to });
    pinText.set(textBetween(editor, from, to));
    editor.refreshRangeDecorations();
  });

  const pinSelection = (): void => {
    const sel = editor.selStore.get();
    if (sel.kind !== "range") {
      pinState.set("none");
      pinText.set("select some code first");
      return;
    }
    const a = sel.anchor;
    const b = sel.focus;
    const forward =
      a.blockId === b.blockId ? a.offset <= b.offset : true;
    const range: AnchorRange = forward ? { from: a, to: b } : { from: b, to: a };
    pin.set(range);
    pinText.set(textBetween(editor, range.from, range.to));
    pinState.set("live");
    editor.refreshRangeDecorations();
  };

  const pinTypo = (): void => {
    const b = findCodeBlock(editor);
    if (!b) return;
    const text = codeText(editor);
    const i = text.indexOf(TYPO);
    if (i < 0) return;
    pin.set({ from: at(b.id, i), to: at(b.id, i + TYPO.length) });
    pinText.set(TYPO);
    pinState.set("live");
    editor.refreshRangeDecorations();
  };

  const toggle = (
    s: { get(): boolean; set(v: boolean): void },
    after?: () => void,
  ) => () => {
    s.set(!s.get());
    after?.();
  };

  const Toggle = (
    label: string,
    s: { get(): boolean },
    onClick: () => void,
  ): void => {
    button(
      {
        class: s.get() ? "ide-toggle is-on" : "ide-toggle",
        on: { click: onClick },
      },
      label,
    );
  };

  return {
    render() {
      // Read every reactive store up front so this view is subscribed to all
      // of them, regardless of which branches the markup below takes.
      const ro = readOnly.get();
      const state = pinState.get();
      const pinnedText = pinText.get();
      const pinned = pin.get();
      const log = changeLog.get();
      div({ class: "ide-demo" }, () => {
        div({ class: "ide-shell" }, () => {
          h1({ class: "demo-title" }, "IDE affordances");
          p(
            { class: "demo-tagline" },
            "Six APIs working at once on one document: per-line gutter decorations, overlapping range decorations, inline widgets, run-level syntax tokens, position mapping, and read-only mode.",
          );

          div({ class: "ide-toolbar" }, () => {
            Toggle(
              ro ? "Read-only" : "Editable",
              readOnly,
              () => {
                readOnly.set(!readOnly.get());
                editor.setEditable(!readOnly.get());
              },
            );
            Toggle("Gutter", showGutter, toggle(showGutter, () => {
              // Decorations mount once per target; force a rebuild so the
              // toggle takes effect immediately.
              editor.docStore.set(editor.docStore.get());
            }));
            Toggle("Diagnostic", showDiagnostic, toggle(showDiagnostic, () =>
              editor.refreshRangeDecorations(),
            ));
            Toggle("Inline widgets", showWidgets, toggle(showWidgets, () =>
              editor.refreshInlineWidgets(),
            ));
            span({ class: "ide-sep" });
            button(
              { class: "ide-btn", on: { click: pinSelection } },
              "Pin selection",
            );
            button(
              { class: "ide-btn", on: { click: pinTypo } },
              "Pin the typo",
            );
          });

          div({ class: "ide-editor-wrap" }, () => {
            editor.EditorView({ class: "ide-editor" });
          });

          div({ class: "ide-panels" }, () => {
            div({ class: "ide-panel" }, () => {
              h2({ class: "ide-panel-title" }, "Pinned comment");
              p({ class: "ide-panel-hint" }, () => {
                if (state === "none") {
                  span(
                    { class: "ide-muted" },
                    pinnedText ||
                      "Nothing pinned yet — select some code and press “Pin selection”.",
                  );
                  return;
                }
                if (state === "detached") {
                  span(
                    { class: "ide-detached" },
                    "detached — the pinned text is gone",
                  );
                  return;
                }
                span({ class: "ide-code" }, JSON.stringify(pinnedText));
                span(
                  { class: "ide-muted" },
                  pinned ? `  ·  [${pinned.from.offset}, ${pinned.to.offset})` : "",
                );
              });
              p(
                { class: "ide-panel-note" },
                "Type before it, inside it, or split the line — the offsets move with the text. Delete it and the pin reports that it's gone: mapAnchor moves one anchor, so tracking a range means mapping both ends and treating a collapse (from === to) as detached.",
              );
            });

            div({ class: "ide-panel" }, () => {
              h2({ class: "ide-panel-title" }, "Recent DocChanges");
              div({ class: "ide-changes" }, () => {
                if (log.length === 0) {
                  span({ class: "ide-muted" }, "edit the document to see changes");
                  return;
                }
                for (let i = 0; i < log.length; i++) {
                  span({ class: "ide-change", key: `${i}:${log[i]}` }, log[i]!);
                }
              });
              p(
                { class: "ide-panel-note" },
                "The same batches editor.onChange() hands you — forward them to a language server as an incremental didChange instead of resending the file.",
              );
            });
          });
        });
        void _;
      });
    },
  };
});
