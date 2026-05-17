// ---------------------------------------------------------------------------
// styles.ts — inject base CSS for the search panel + the named highlights.
// Idempotent: re-injecting only updates the <style> contents, never adds
// duplicates.
// ---------------------------------------------------------------------------

const STYLE_ID = "creo-search-styles";

const CSS_TEXT = `
::highlight(creo-search) {
  background-color: rgba(255, 220, 0, 0.45);
  color: inherit;
}
::highlight(creo-search-current) {
  background-color: rgba(255, 140, 0, 0.85);
  color: inherit;
}

.creo-search-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  width: max-content;
  max-width: calc(100% - 16px);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--creo-search-bg, #ffffff);
  color: var(--creo-search-fg, #1a1a1a);
  border: 1px solid var(--creo-search-border, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: auto;
}
.creo-search-panel input.creo-search-input {
  appearance: none;
  border: 1px solid transparent;
  outline: none;
  background: var(--creo-search-input-bg, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
  padding: 4px 8px;
  width: 200px;
  font: inherit;
  color: inherit;
}
.creo-search-panel input.creo-search-input.creo-search-error {
  border-color: rgba(220, 50, 50, 0.7);
}
.creo-search-panel .creo-search-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
  min-width: 56px;
  text-align: center;
}
.creo-search-panel button {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  padding: 0;
}
.creo-search-panel button:hover {
  background: rgba(0, 0, 0, 0.06);
}
.creo-search-panel button[aria-pressed="true"] {
  background: rgba(0, 0, 0, 0.12);
}
.creo-search-panel button[disabled] {
  opacity: 0.4;
  cursor: default;
}

@media (prefers-color-scheme: dark) {
  .creo-search-panel {
    background: var(--creo-search-bg, #1f1f1f);
    color: var(--creo-search-fg, #f0f0f0);
    border-color: var(--creo-search-border, rgba(255, 255, 255, 0.15));
  }
  .creo-search-panel input.creo-search-input {
    background: var(--creo-search-input-bg, rgba(255, 255, 255, 0.08));
  }
  .creo-search-panel button:hover {
    background: rgba(255, 255, 255, 0.08);
  }
  .creo-search-panel button[aria-pressed="true"] {
    background: rgba(255, 255, 255, 0.16);
  }
}
`;

export function ensureStylesInjected(): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== CSS_TEXT) el.textContent = CSS_TEXT;
}
