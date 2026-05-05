// ---------------------------------------------------------------------------
// Slash menu UI — vanilla DOM popover anchored at the caret rect.
//
// The framework only sets the bare minimum required for the menu to work:
//   - the popover is `position: fixed` (positional)
//   - active item gets `is-active` class
//   - items get the `creo-slash-item` class
// All cosmetic styling (colors, borders, padding, fonts) lives in the
// consumer's stylesheet. A reference stylesheet is shipped at
// `creo-editor/src/plugins/styles.css` for hosts that want defaults.
// ---------------------------------------------------------------------------

import type { SlashItem } from "./items";
import { defaultFilter } from "./items";

export type MenuOptions = {
  items: SlashItem[];
  filter?: (items: SlashItem[], query: string) => SlashItem[];
  caretRect: DOMRect | null;
  /** Called when the user picks an item (Enter or click). */
  onPick(item: SlashItem): void;
  /** Called when the user hits Escape, clicks away, or otherwise dismisses. */
  onCancel(): void;
};

export type MenuHandle = {
  setQuery(q: string): void;
  /** Returns true if the key was consumed (arrow nav / Enter / Esc). */
  handleKey(e: KeyboardEvent): boolean;
  destroy(): void;
};

const ITEM_CLASS = "creo-slash-item";

export function mountSlashMenu(opts: MenuOptions): MenuHandle {
  const root = document.createElement("div");
  root.className = "creo-slash";
  root.setAttribute("role", "listbox");
  // Positional only — host stylesheet owns appearance.
  root.style.position = "fixed";
  root.style.zIndex = "10000";
  positionAt(root, opts.caretRect);

  document.body.appendChild(root);

  let filtered: SlashItem[] = (opts.filter ?? defaultFilter)(opts.items, "");
  let activeIdx = 0;

  const render = (): void => {
    root.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "creo-slash-empty";
      empty.textContent = "No matches";
      root.appendChild(empty);
      return;
    }
    for (let i = 0; i < filtered.length; i++) {
      const it = filtered[i]!;
      const el = document.createElement("div");
      el.className = ITEM_CLASS + (i === activeIdx ? " is-active" : "");
      el.setAttribute("role", "option");
      el.setAttribute("data-id", it.id);
      const title = document.createElement("div");
      title.className = "creo-slash-item-title";
      title.textContent = it.title;
      el.appendChild(title);
      if (it.description) {
        const desc = document.createElement("div");
        desc.className = "creo-slash-item-desc";
        desc.textContent = it.description;
        el.appendChild(desc);
      }
      el.addEventListener("mousedown", (e) => {
        // mousedown (not click) so we fire before the editor loses focus.
        e.preventDefault();
        opts.onPick(it);
      });
      el.addEventListener("mouseenter", () => {
        activeIdx = i;
        render();
      });
      root.appendChild(el);
    }
  };

  render();

  const handle: MenuHandle = {
    setQuery(q) {
      filtered = (opts.filter ?? defaultFilter)(opts.items, q);
      activeIdx = 0;
      render();
    },
    handleKey(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (filtered.length > 0) {
          activeIdx = (activeIdx + 1) % filtered.length;
          render();
        }
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length > 0) {
          activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
          render();
        }
        return true;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = filtered[activeIdx];
        if (it) opts.onPick(it);
        else opts.onCancel();
        return true;
      }
      return false;
    },
    destroy() {
      root.remove();
    },
  };
  return handle;
}

function positionAt(el: HTMLElement, rect: DOMRect | null): void {
  if (!rect) {
    el.style.left = "20px";
    el.style.top = "20px";
    return;
  }
  const vh = window.innerHeight ?? 800;
  const vw = window.innerWidth ?? 800;
  const PAD = 4;
  let top = rect.bottom + PAD;
  let left = rect.left;
  const estH = 280;
  if (top + estH > vh) top = Math.max(PAD, rect.top - estH - PAD);
  if (left + 240 > vw) left = vw - 240 - PAD;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
