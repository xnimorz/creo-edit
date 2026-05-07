// ---------------------------------------------------------------------------
// TriggerManager — watches text insertion + key events for plugin triggers
// (slash commands, mentions, etc.).
//
// At most ONE trigger can be active at a time. While active:
//   - subsequent text input extends the query and notifies the controller
//   - keydown events are routed to the controller's onKey first
//   - caret movement off the trigger range auto-closes
//
// The controller, returned by `TriggerDef.open`, is the trigger's contract
// for rendering UI (popover, dropdown, autocomplete) and committing a
// result. The manager itself never touches the DOM beyond computing a caret
// rect for positioning.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { Anchor, DocState, Selection } from "../model/types";
import type {
  DispatchableCommand,
} from "../createEditor";
import { runsAt } from "./runsAt";
import type {
  TriggerController,
  TriggerCtx,
  TriggerDef,
} from "./types";
import type { Registry } from "./registry";

export type TriggerManagerOptions = {
  registry: Registry;
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  dispatch: (cmd: DispatchableCommand) => void;
};

type ActiveState = {
  def: TriggerDef;
  ctrl: TriggerController;
  start: Anchor;
  query: string;
};

export class TriggerManager {
  private active: ActiveState | null = null;
  private unsubSel: (() => void) | null = null;
  private unsubDoc: (() => void) | null = null;

  constructor(private opts: TriggerManagerOptions) {
    // Auto-close when caret moves out of the trigger block, OR moves
    // before the trigger char (e.g. arrow-left past the "/").
    this.unsubSel = opts.selStore.subscribe(() => this.reconcile());
    // Auto-close when the trigger char itself is deleted (backspace), or
    // when the doc otherwise mutates such that the typed query no longer
    // makes sense. Also recompute the live query string from the doc so
    // backspace inside the query updates the menu's filter.
    this.unsubDoc = opts.docStore.subscribe(() => this.reconcile());
  }

  destroy(): void {
    this.close();
    this.unsubSel?.();
    this.unsubDoc?.();
    this.unsubSel = null;
    this.unsubDoc = null;
  }

  /**
   * Re-derive the active trigger's state from the current doc + selection.
   * Closes the menu if any of:
   *   - caret left the trigger's block
   *   - caret moved before the trigger char position
   *   - the trigger char at the start position is no longer there
   * Otherwise, recomputes the live query string and notifies the controller.
   */
  private reconcile(): void {
    if (!this.active) return;
    const sel = this.opts.selStore.get();
    const a = sel.kind === "caret" ? sel.at : sel.anchor;
    if (a.blockId !== this.active.start.blockId) {
      this.close();
      return;
    }
    const startOff = lastPathEntry(this.active.start);
    const curOff = lastPathEntry(a);
    // Caret moved before/onto the trigger position → trigger char is gone
    // or about to be (close on equality so the user can't backspace into
    // the trigger char itself).
    if (curOff < startOff) {
      this.close();
      return;
    }
    // Read the runs slot at the trigger anchor and check the trigger char
    // is still present at offset (startOff - 1).
    const block = this.opts.docStore.get().byId.get(a.blockId);
    if (!block) {
      this.close();
      return;
    }
    const ctx = runsAt(block, this.active.start);
    if (!ctx) {
      this.close();
      return;
    }
    const text = runsToText(ctx.runs);
    const triggerCharPos = startOff - 1;
    if (triggerCharPos < 0 || triggerCharPos >= text.length) {
      this.close();
      return;
    }
    const triggerChar = text[triggerCharPos];
    const def = this.active.def;
    const expected = typeof def.match === "string" ? def.match : null;
    if (expected !== null && triggerChar !== expected) {
      this.close();
      return;
    }
    // Recompute the query: text from the trigger anchor (after the trigger
    // char) up to the current caret position.
    const newQuery = text.slice(startOff, curOff);
    if (newQuery !== this.active.query) {
      this.active.query = newQuery;
      this.active.ctrl.onTextChange?.(newQuery);
    }
  }

  /** Called by nativeInput AFTER a successful insertText dispatch. */
  onTextInserted(text: string): void {
    // While a trigger is active, the docStore subscriber's reconcile has
    // already updated the query — no extra work needed here.
    if (this.active) return;
    const sel = this.opts.selStore.get();
    if (sel.kind !== "caret") return;
    for (const def of this.opts.registry.triggers) {
      if (!matchesTrigger(def, text)) continue;
      const ctx: TriggerCtx = {
        at: sel.at,
        docStore: this.opts.docStore,
        selStore: this.opts.selStore,
        dispatch: (...args: unknown[]) => {
          // Two call shapes:
          //   dispatch({ t: "toggleList", ordered: true })   ← typed
          //   dispatch("table.insertRow", { where: "below" }) ← plugin
          if (typeof args[0] === "string") {
            const t = args[0];
            const payload = args[1];
            this.opts.dispatch({ t, payload } as DispatchableCommand);
          } else {
            this.opts.dispatch(args[0] as DispatchableCommand);
          }
        },
        caretRect: () => caretRect(),
        close: () => this.close(),
      };
      const ctrl = def.open(ctx);
      if (ctrl) {
        this.active = { def, ctrl, start: sel.at, query: "" };
        return;
      }
    }
  }

  /** Called by nativeInput at the top of onKeyDown. Returns true if consumed. */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return true;
    }
    return this.active.ctrl.onKey?.(e) ?? false;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  close(): void {
    if (this.active) {
      try {
        this.active.ctrl.close();
      } catch {
        // Don't let a faulty controller leave us in a half-closed state.
      }
      this.active = null;
    }
  }
}

function matchesTrigger(def: TriggerDef, text: string): boolean {
  if (typeof def.match === "string") return text === def.match;
  return def.match.test(text);
}

function lastPathEntry(a: Anchor): number {
  return a.path[a.path.length - 1] ?? 0;
}

function runsToText(runs: import("../model/types").InlineRun[]): string {
  let s = "";
  for (const r of runs) s += r.text;
  return s;
}

function caretRect(): DOMRect | null {
  if (typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  try {
    return sel.getRangeAt(0).getBoundingClientRect();
  } catch {
    return null;
  }
}
