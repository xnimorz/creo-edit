// ---------------------------------------------------------------------------
// Default search panel — plain DOM (no creo) so it doesn't fight the
// editor's own selection plumbing or render scheduler.
//
// Floating top-right via `position: sticky` inside the decoration host.
// Skipped entirely when the host supplies `opts.renderUI`.
// ---------------------------------------------------------------------------

import type { SearchController, SearchOptions, SearchToggle } from "./types";

type ToggleSpec = {
  key: SearchToggle;
  label: string;
  title: string;
};

const TOGGLES: ToggleSpec[] = [
  { key: "caseSensitive", label: "Aa", title: "Match case" },
  { key: "wholeWord", label: "W", title: "Whole word" },
  { key: "regex", label: ".*", title: "Regex" },
];

export function mountDefaultPanel(
  host: HTMLElement,
  controller: SearchController,
  options: SearchOptions,
): () => void {
  const panel = document.createElement("div");
  panel.className = "creo-search-panel";
  panel.setAttribute("role", "search");
  // Stop edits/clicks inside the panel from reaching the editor.
  for (const evt of [
    "keydown",
    "keyup",
    "keypress",
    "input",
    "beforeinput",
    "mousedown",
    "click",
    "pointerdown",
  ] as const) {
    panel.addEventListener(evt, (e) => e.stopPropagation());
  }

  const input = document.createElement("input");
  input.type = "text";
  input.className = "creo-search-input";
  input.placeholder = "Find";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Find in document");
  panel.appendChild(input);

  const count = document.createElement("span");
  count.className = "creo-search-count";
  count.textContent = "";
  panel.appendChild(count);

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.title = "Previous match (Shift+Enter)";
  prevBtn.setAttribute("aria-label", "Previous match");
  prevBtn.textContent = "↑";
  panel.appendChild(prevBtn);

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.title = "Next match (Enter)";
  nextBtn.setAttribute("aria-label", "Next match");
  nextBtn.textContent = "↓";
  panel.appendChild(nextBtn);

  // Build toggle buttons only for those declared `show: true`.
  const toggleEls = new Map<SearchToggle, HTMLButtonElement>();
  for (const t of TOGGLES) {
    const cfg = options.toggles?.[t.key];
    if (!cfg?.show) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.title = t.title;
    b.setAttribute("aria-label", t.title);
    b.setAttribute("aria-pressed", "false");
    b.textContent = t.label;
    b.addEventListener("click", () => {
      controller.setToggle(t.key, !controller.toggle(t.key));
    });
    panel.appendChild(b);
    toggleEls.set(t.key, b);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.title = "Close (Esc)";
  close.setAttribute("aria-label", "Close search");
  close.textContent = "×";
  close.addEventListener("click", () => controller.close());
  panel.appendChild(close);

  // Wiring -----------------------------------------------------------------

  input.addEventListener("input", () => {
    controller.setQuery(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) controller.prev();
      else controller.next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      controller.close();
    }
  });
  prevBtn.addEventListener("click", () => controller.prev());
  nextBtn.addEventListener("click", () => controller.next());

  host.appendChild(panel);

  const sync = () => {
    const s = controller.state();
    panel.style.display = s.isOpen ? "" : "none";
    if (input.value !== s.query) input.value = s.query;
    input.classList.toggle("creo-search-error", Boolean(s.error));
    if (s.error) {
      input.title = s.error;
    } else {
      input.removeAttribute("title");
    }
    if (s.matches.length === 0) {
      count.textContent = s.query ? "0 / 0" : "";
    } else {
      count.textContent = `${s.activeIndex + 1} / ${s.matches.length}`;
    }
    const noMatches = s.matches.length === 0;
    prevBtn.toggleAttribute("disabled", noMatches);
    nextBtn.toggleAttribute("disabled", noMatches);
    for (const [k, btn] of toggleEls) {
      const on = controller.toggle(k);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (s.isOpen && document.activeElement !== input) {
      // Only refocus on initial open (when value is empty or matches the
      // controller); otherwise let the user interact with the panel.
      // We refocus when isOpen flipped to true — track via a flag.
    }
  };

  let lastOpen = false;
  const onChange = () => {
    const open = controller.isOpen();
    if (open && !lastOpen) {
      // Just opened — focus + select existing query so re-opens are fast.
      // Defer to next frame so the panel is visible first.
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    }
    lastOpen = open;
    sync();
  };
  const unsub = controller.subscribe(onChange);
  sync();

  return () => {
    unsub();
    panel.remove();
  };
}
