# Keybindings

The editor ships with a default keymap. Every chord maps onto a single `Command` (or a built-in like undo/select-all), so what the keyboard does and what your toolbar does flow through the exact same dispatch path.

## Defaults

| Chord | Action |
|---|---|
| `Cmd/Ctrl+B` | Toggle **bold** mark |
| `Cmd/Ctrl+I` | Toggle *italic* mark |
| `Cmd/Ctrl+U` | Toggle <u>underline</u> mark |
| `Cmd/Ctrl+Shift+S` | Toggle ~~strikethrough~~ mark |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+Shift+Z` (or `Cmd/Ctrl+Y`) | Redo |
| `Cmd/Ctrl+A` | Select all |
| `Cmd/Ctrl+Alt+1`…`6` | Heading levels 1–6 |
| `Cmd/Ctrl+Alt+0` | Paragraph |
| `Tab` (in list) | Indent list item |
| `Shift+Tab` (in list) | Outdent list item |
| `Tab` (in table) | Move to next cell |
| `Shift+Tab` (in table) | Move to previous cell |
| `Enter` | `splitBlock` |
| `Shift+Enter` | Soft break (newline character within the current block) |
| `Backspace` | `deleteBackward` (or `mergeBackward` at start-of-block) |
| `Delete` | `deleteForward` (or `mergeForward` at end-of-block) |
| `←` / `→` / `↑` / `↓` | Caret navigation. `Shift` extends, `Cmd/Ctrl/Alt` jumps by word/line/document depending on platform conventions. |
| `Home` / `End` | Beginning / end of line. `Cmd+Home` / `Cmd+End` jump to document. |

`Cmd` is used on macOS, `Ctrl` elsewhere — the keymap normalises this for you.

## Adding your own

There is no "register chord" API — and that's deliberate. The keymap is small, the editor input pipeline is the only DOM listener that needs to see keys, and adding more behavior is just calling `editor.dispatch()` from your own listeners.

If you want extra shortcuts (say `Cmd+K` for a link prompt), attach a listener to your editor's container and call dispatch yourself:

```ts
import { view } from "creo";

const App = view(() => ({
  onMount() {
    const root = document.querySelector(".my-shell")!;
    root.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        const url = prompt("URL?");
        if (url) {
          // Implement your own link command on top of the existing
          // primitives — toggleMark gives you styling, insertText handles
          // the visible label.
        }
      }
    });
  },
  render() {
    /* … */
  },
}));
```

Listening at your shell — not at `window` — keeps the binding scoped to the editor.

## Disabling defaults

Same answer as above — the editor doesn't expose a "remove this binding" knob. If you want different behavior for, say, `Tab`, add a listener that calls `e.stopPropagation()` (or `e.preventDefault()`) before the editor's pipeline sees it. The pipeline registers on the hidden textarea, so its handler runs only when the textarea is focused — your wrapper listener can run first if attached to a parent in capture phase.

For most apps the defaults are enough. The shortcut surface is intentionally minimal: anything richer (slash menus, autocomplete, link popovers) is built on top by listening to `selStore` and dispatching commands.
