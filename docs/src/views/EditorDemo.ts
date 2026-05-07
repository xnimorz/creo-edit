import {
  view,
  div,
  button,
  input,
  label,
  option,
  select,
  span,
  textarea,
  _,
} from "creo";
import type { InputEventData, KeyEventData, PointerEventData } from "creo";
import {
  addBlockPlugin,
  createEditor,
  docToMarkdown,
  defaultSlashItems,
  dragHandlePlugin,
  mdShortcutsPlugin,
  mountSlashMenu,
  slashCommandsPlugin,
  type EditorMode,
  type EditorPlugin,
  type Mark,
  type SerializedDoc,
  type SlashItem,
  type SlashMenuHandle,
} from "creo-edit";
import { markdownToDoc } from "../markdown/toEditorDoc";

/**
 * Move the markdown "block" containing the caret up or down. A block here
 * is a run of consecutive non-blank lines (separated by one or more blank
 * lines from neighbors) — matches how markdown parsers segment paragraphs.
 *
 * `dir = -1` moves the block up; `dir = +1` moves it down. No-op at the
 * top/bottom of the doc.
 */
function moveMdBlock(ta: HTMLTextAreaElement, dir: -1 | 1): void {
  const text = ta.value;
  const caret = ta.selectionStart ?? 0;
  // Split into "blocks" with their original line ranges.
  const lines = text.split("\n");
  // Compute character offset of each line's start.
  const lineStarts: number[] = [];
  let off = 0;
  for (const ln of lines) {
    lineStarts.push(off);
    off += ln.length + 1; // +1 for the \n
  }
  // Find the line under the caret.
  let curLine = 0;
  for (let i = 0; i < lineStarts.length; i++) {
    if (lineStarts[i]! <= caret) curLine = i;
    else break;
  }
  // Walk outward from curLine to find the contiguous non-blank range.
  if (lines[curLine]!.trim().length === 0) return; // cursor on blank line
  let blockStart = curLine;
  while (blockStart > 0 && lines[blockStart - 1]!.trim().length > 0) blockStart--;
  let blockEnd = curLine;
  while (blockEnd < lines.length - 1 && lines[blockEnd + 1]!.trim().length > 0) blockEnd++;
  // Find the previous / next block to swap with.
  if (dir === -1) {
    let prevEnd = blockStart - 1;
    while (prevEnd >= 0 && lines[prevEnd]!.trim().length === 0) prevEnd--;
    if (prevEnd < 0) return; // no block above
    let prevStart = prevEnd;
    while (prevStart > 0 && lines[prevStart - 1]!.trim().length > 0) prevStart--;
    // Swap the two ranges; preserve the blank line(s) between them.
    const blockLines = lines.slice(blockStart, blockEnd + 1);
    const blanks = lines.slice(prevEnd + 1, blockStart);
    const prevBlock = lines.slice(prevStart, prevEnd + 1);
    const head = lines.slice(0, prevStart);
    const tail = lines.slice(blockEnd + 1);
    const newLines = [...head, ...blockLines, ...blanks, ...prevBlock, ...tail];
    ta.value = newLines.join("\n");
    // Caret follows the moved block.
    const newCaret = newLines.slice(0, prevStart).join("\n").length +
      (prevStart > 0 ? 1 : 0) + (caret - lineStarts[blockStart]!);
    ta.selectionStart = newCaret;
    ta.selectionEnd = newCaret;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    let nextStart = blockEnd + 1;
    while (nextStart < lines.length && lines[nextStart]!.trim().length === 0) nextStart++;
    if (nextStart >= lines.length) return; // no block below
    let nextEnd = nextStart;
    while (nextEnd < lines.length - 1 && lines[nextEnd + 1]!.trim().length > 0) nextEnd++;
    const blockLines = lines.slice(blockStart, blockEnd + 1);
    const blanks = lines.slice(blockEnd + 1, nextStart);
    const nextBlock = lines.slice(nextStart, nextEnd + 1);
    const head = lines.slice(0, blockStart);
    const tail = lines.slice(nextEnd + 1);
    const newLines = [...head, ...nextBlock, ...blanks, ...blockLines, ...tail];
    ta.value = newLines.join("\n");
    const newBlockStart = head.length + nextBlock.length + blanks.length;
    const newCaret = newLines.slice(0, newBlockStart).join("\n").length +
      (newBlockStart > 0 ? 1 : 0) + (caret - lineStarts[blockStart]!);
    ta.selectionStart = newCaret;
    ta.selectionEnd = newCaret;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// Map the default slash items to markdown insertions for MD-mode usage.
// Same items, different effect — picking "Heading 1" inserts `# ` instead
// of dispatching `setBlockType`.
const MD_INSERTS: Record<string, string> = {
  p: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  ul: "- ",
  ol: "1. ",
  code: "```\n\n```",
  table: "| col 1 | col 2 |\n| --- | --- |\n| | |",
  columns: "<!-- columns: side-by-side layout -->",
};

// Default initial — the actual createEditor() snippet from the README,
// rendered as a real `code` block so the user can edit it as a single
// multi-line region (Enter inserts \n, doesn't split). Editable: the
// landing-page editor IS the welcome doc, so people can type into it as
// the first thing they do on the site.
const DEFAULT_INITIAL: SerializedDoc = {
  blocks: [
    { type: "h2", runs: [{ text: "This editor is the editor" }] },
    {
      type: "p",
      runs: [
        {
          text:
            "Below is a real createEditor() instance. The block you're reading right now is a row in its model. Click in, type, format with the toolbar — every interaction goes through the public API.",
        },
      ],
    },
    {
      type: "p",
      runs: [{ text: "Mount one in three lines:" }],
    },
    {
      type: "code",
      lang: "ts",
      runs: [
        {
          text:
            'import { createApp, HtmlRender } from "creo";\n' +
            'import { createEditor } from "creo-edit";\n' +
            "\n" +
            "const editor = createEditor();\n" +
            "\n" +
            "createApp(\n" +
            "  () => editor.EditorView(),\n" +
            '  new HtmlRender(document.querySelector("#app")!),\n' +
            ").mount();",
        },
      ],
    },
    {
      type: "p",
      runs: [
        {
          text:
            "Want a toolbar? Wire buttons to editor.dispatch(). Want to save? editor.toJSON(). Want to load HTML? editor.setDocFromHTML(html). The full API is one click away on the right.",
        },
      ],
    },
  ],
};

const blockTypes = [
  { v: "p", label: "Paragraph" },
  { v: "h1", label: "Heading 1" },
  { v: "h2", label: "Heading 2" },
  { v: "h3", label: "Heading 3" },
  { v: "h4", label: "Heading 4" },
  { v: "code", label: "Code block" },
] as const;

export type EditorDemoProps = {
  initial?: SerializedDoc;
  mode?: EditorMode;
  class?: string;
};

type Settings = {
  mode: EditorMode;
  slash: boolean;
  drag: boolean;
  addBlock: boolean;
};

function buildPlugins(s: Settings): EditorPlugin[] {
  const out: EditorPlugin[] = [];
  if (s.slash) out.push(slashCommandsPlugin());
  if (s.drag) out.push(dragHandlePlugin({ hoverOnly: false }));
  if (s.addBlock) out.push(addBlockPlugin({ hoverOnly: false }));
  // mdShortcutsPlugin is always installed when mode === "md" (the typing
  // rules are the user-visible behavior of MD mode).
  if (s.mode === "md") out.push(mdShortcutsPlugin());
  return out;
}

export const EditorDemo = view<EditorDemoProps>(({ props, use }) => {
  const initial = props().initial ?? DEFAULT_INITIAL;

  const settings = use<Settings>({
    mode: props().mode ?? "wysiwyg",
    slash: false,
    drag: false,
    addBlock: false,
  });

  // Markdown source held in a store so it survives re-renders while editing
  // in MD mode. Initialized lazily on first switch into MD.
  const mdText = use<string>("");

  // Slash menu state for MD mode. mdSlash is the live menu handle when one
  // is open; mdSlashAnchor is the textarea position where "/" was typed so
  // we can splice in the chosen markdown at the right spot.
  let mdSlash: SlashMenuHandle | null = null;
  let mdSlashAnchor: { textarea: HTMLTextAreaElement; pos: number } | null = null;

  const closeMdSlash = (): void => {
    mdSlash?.destroy();
    mdSlash = null;
    mdSlashAnchor = null;
  };

  const openMdSlash = (ta: HTMLTextAreaElement): void => {
    closeMdSlash();
    const pos = ta.selectionStart ?? 0;
    // Anchor rect: rough — use the textarea's own bounding rect since
    // computing exact caret position in a textarea requires a hidden
    // mirror. Place the menu at the bottom of the textarea for simplicity.
    const r = ta.getBoundingClientRect();
    const caretRect = new DOMRect(r.left + 16, r.top + 16, 0, 18);
    mdSlashAnchor = { textarea: ta, pos };
    mdSlash = mountSlashMenu({
      items: defaultSlashItems,
      caretRect,
      onPick: (it) => {
        if (!mdSlashAnchor) return;
        const t = mdSlashAnchor.textarea;
        const at = mdSlashAnchor.pos;
        const insert = MD_INSERTS[it.id] ?? "";
        const cur = t.value;
        // Replace the "/" + any chars after it (the typed query) up to the
        // current selection start with the markdown insert.
        const queryEnd = t.selectionStart ?? at;
        const next = cur.slice(0, at - 1) + insert + cur.slice(queryEnd);
        t.value = next;
        mdText.set(next);
        const caret = at - 1 + insert.length;
        t.selectionStart = caret;
        t.selectionEnd = caret;
        t.focus();
        closeMdSlash();
      },
      onCancel: () => closeMdSlash(),
    });
  };

  const maybeOpenMdSlash = (ta: HTMLTextAreaElement): void => {
    if (mdSlash) {
      // Already open — let the menu update its query.
      const at = mdSlashAnchor?.pos ?? 0;
      const cursor = ta.selectionStart ?? 0;
      const query = ta.value.slice(at, cursor);
      mdSlash.setQuery(query);
      return;
    }
    const cursor = ta.selectionStart ?? 0;
    const justTyped = ta.value.slice(Math.max(0, cursor - 1), cursor);
    if (justTyped !== "/") return;
    // Open the menu anywhere "/" is typed — same as the WYSIWYG slash
    // trigger, so users get consistent behavior across modes. The menu
    // closes on Escape / blur / non-matching query.
    openMdSlash(ta);
  };

  // Editor instance held in a store so we can swap it when plugin toggles
  // change. virtualized: true keeps the editor responsive on large docs.
  const editorStore = use(
    createEditor({
      initial,
      mode: settings.get().mode,
      virtualized: true,
      plugins: buildPlugins(settings.get()),
    }),
  );

  const recreateEditor = (): void => {
    // Preserve the current document across plugin reinstall.
    const current = editorStore.get();
    const doc = current.toJSON();
    // Strip any orphan decoration layers from the previous editor — the
    // editor doesn't yet expose a destroy() that would tear them down,
    // so we clean up by selector against the demo wrapper.
    const wrapper = document.querySelector(".ed-demo");
    if (wrapper) {
      for (const el of wrapper.querySelectorAll(".ce-decorations")) {
        el.remove();
      }
    }
    const next = createEditor({
      initial: doc,
      mode: settings.get().mode,
      virtualized: true,
      plugins: buildPlugins(settings.get()),
    });
    editorStore.set(next);
  };

  const setMode = (m: EditorMode) => () => {
    if (settings.get().mode === m) return;
    if (m === "md") {
      // Switching INTO MD: serialize the current doc to markdown.
      const md = docToMarkdown(editorStore.get().toJSON());
      mdText.set(md);
      settings.update((s) => ({ ...s, mode: m }));
      // The textarea is uncontrolled — push the initial markdown into it
      // after the render commits. Subsequent edits stay inside the
      // textarea (no re-render on every keystroke).
      queueMicrotask(() => {
        const ta = document.querySelector(
          ".ed-md-source",
        ) as HTMLTextAreaElement | null;
        if (ta) ta.value = md;
      });
      return;
    }
    // Switching BACK to wysiwyg: read the textarea's current value (since
    // we don't sync it back to mdText on every keystroke) and parse.
    const ta = document.querySelector(
      ".ed-md-source",
    ) as HTMLTextAreaElement | null;
    const liveText = ta?.value ?? mdText.get();
    mdText.set(liveText);
    let parsed: SerializedDoc;
    try {
      parsed = markdownToDoc(liveText);
    } catch {
      parsed = editorStore.get().toJSON();
    }
    settings.update((s) => ({ ...s, mode: m }));
    // Recreate the editor with the parsed doc as the new initial state. This
    // also re-plumbs plugins (mdShortcutsPlugin off in wysiwyg).
    recreateEditorWithDoc(parsed);
  };

  const recreateEditorWithDoc = (doc: SerializedDoc): void => {
    const wrapper = document.querySelector(".ed-demo");
    if (wrapper) {
      for (const el of wrapper.querySelectorAll(".ce-decorations")) el.remove();
    }
    const next = createEditor({
      initial: doc,
      mode: settings.get().mode,
      virtualized: true,
      plugins: buildPlugins(settings.get()),
    });
    editorStore.set(next);
  };

  const togglePlugin = (key: "slash" | "drag" | "addBlock") => () => {
    settings.update((s) => ({ ...s, [key]: !s[key] }));
    recreateEditor();
  };

  // Toolbar handlers — read the current editor lazily so they pick up the
  // new instance after a plugin toggle.
  const editor = () => editorStore.get();
  const onTypeChange = (e: InputEventData) => {
    const v = e.value as (typeof blockTypes)[number]["v"];
    editor().dispatch({ t: "setBlockType", payload: { type: v } });
    editor().focus();
  };
  const mark = (m: Mark) => (e: PointerEventData) => {
    e.preventDefault();
    editor().dispatch({ t: "toggleMark", mark: m });
    editor().focus();
  };
  const list = (ordered: boolean) => (e: PointerEventData) => {
    e.preventDefault();
    editor().dispatch({ t: "toggleList", ordered });
    editor().focus();
  };
  const insertImage = (e: PointerEventData) => {
    e.preventDefault();
    const src = window.prompt("Image URL?");
    if (src) editor().dispatch({ t: "insertImage", src });
    editor().focus();
  };
  const insertTable = (e: PointerEventData) => {
    e.preventDefault();
    editor().dispatch({ t: "insertTable", rows: 3, cols: 3 });
    editor().focus();
  };
  const undo = (e: PointerEventData) => {
    e.preventDefault();
    editor().undo();
    editor().focus();
  };
  const redo = (e: PointerEventData) => {
    e.preventDefault();
    editor().redo();
    editor().focus();
  };

  // Document-level native keydown listener for Alt+Up / Alt+Down line
  // movement in the MD textarea — creo's KeyEventData abstraction strips
  // modifier flags, so we read them from the raw event here.
  const onMdKey = (e: KeyboardEvent): void => {
    if (settings.get().mode !== "md" || !settings.get().drag) return;
    if (!e.altKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const target = e.target as Element | null;
    if (!target?.classList?.contains("ed-md-source")) return;
    e.preventDefault();
    moveMdBlock(target as HTMLTextAreaElement, e.key === "ArrowUp" ? -1 : 1);
  };

  return {
    onMount() {
      document.addEventListener("keydown", onMdKey, true);
    },
    render() {
      const wrapClass =
        "ed-demo" + (props().class ? " " + props().class : "");
      const s = settings.get();
      div({ class: wrapClass }, () => {
        // Settings strip — mode toggle + plugin checkboxes.
        div({ class: "ed-settings" }, () => {
          div({ class: "ed-mode-switch" }, () => {
            span({ class: "ed-settings-label" }, "Mode:");
            button(
              {
                class: "ed-mode-btn" + (s.mode === "wysiwyg" ? " is-active" : ""),
                onClick: setMode("wysiwyg"),
              },
              "WYSIWYG",
            );
            button(
              {
                class: "ed-mode-btn" + (s.mode === "md" ? " is-active" : ""),
                onClick: setMode("md"),
              },
              "Markdown",
            );
          });
          div({ class: "ed-plugin-toggles" }, () => {
            span({ class: "ed-settings-label" }, "Plugins:");
            label({ class: "ed-toggle" }, () => {
              input({
                type: "checkbox",
                checked: s.slash,
                onChange: togglePlugin("slash"),
              });
              span({}, "Slash menu (/)");
            });
            label({ class: "ed-toggle" }, () => {
              input({
                type: "checkbox",
                checked: s.drag,
                onChange: togglePlugin("drag"),
              });
              span({}, "Drag handle");
            });
            label({ class: "ed-toggle" }, () => {
              input({
                type: "checkbox",
                checked: s.addBlock,
                onChange: togglePlugin("addBlock"),
              });
              span({}, "+ button");
            });
          });
        });

        div({ class: "ed-toolbar" }, () => {
          select({ class: "ed-select", onChange: onTypeChange }, () => {
            for (const t of blockTypes) {
              option({ value: t.v }, t.label);
            }
          });
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: mark("b") }, "B");
          button({ class: "ed-btn", onClick: mark("i") }, "I");
          button({ class: "ed-btn", onClick: mark("u") }, "U");
          button({ class: "ed-btn", onClick: mark("s") }, "S");
          button({ class: "ed-btn", onClick: mark("code") }, "</>");
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: list(false) }, "• List");
          button({ class: "ed-btn", onClick: list(true) }, "1. List");
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: insertImage }, "Image");
          button({ class: "ed-btn", onClick: insertTable }, "Table");
          div({ class: "ed-sep" });
          button({ class: "ed-btn", onClick: undo }, "Undo");
          button({ class: "ed-btn", onClick: redo }, "Redo");
        });
        if (s.mode === "md") {
          // Markdown source view — a plain textarea backed by `mdText`.
          // Editing here doesn't go through the editor pipeline; we parse
          // the text on switch back to wysiwyg.
          //
          // Slash menu in MD mode: when the slash plugin is enabled, typing
          // "/" opens a popover that inserts the corresponding markdown
          // syntax at the cursor. Reuses the same `mountSlashMenu` UI.
          // Uncontrolled textarea — no `value` binding. The textarea owns
          // its own state; mdText is only resynced on mode-out. This keeps
          // input on large markdown documents fast (no creo reconciliation
          // per keystroke).
          textarea(
            {
              class: "ed-md-source",
              onInput: (_e: InputEventData) => {
                if (!s.slash) return;
                const ta = document.querySelector(
                  ".ed-md-source",
                ) as HTMLTextAreaElement | null;
                if (ta) maybeOpenMdSlash(ta);
              },
              onKeyDown: (e: KeyEventData) => {
                // Alt+Up/Down handled by a document-level native listener
                // below — creo's KeyEventData strips modifier flags.
                if (!mdSlash) return;
                const adapter = {
                  key: e.key,
                  preventDefault: () => e.preventDefault(),
                } as unknown as KeyboardEvent;
                mdSlash.handleKey(adapter);
                if (e.key === "Escape") closeMdSlash();
              },
              onBlur: () => closeMdSlash(),
            },
          );
        } else {
          // The editor view subscribes to `editorStore` via `use()` above so
          // recreating the editor swaps the mounted view.
          editor().EditorView({ key: `editor-${s.slash}-${s.drag}-${s.addBlock}-${s.mode}` });
        }
        void _;
      });
    },
  };
});
