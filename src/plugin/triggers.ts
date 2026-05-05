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

  constructor(private opts: TriggerManagerOptions) {
    // Auto-close when caret moves out of the trigger block — covers click
    // away, arrow up/down, etc. Inside-block motion (typing query chars,
    // arrow left/right within the query) doesn't trigger close.
    this.unsubSel = opts.selStore.subscribe(() => {
      if (!this.active) return;
      const sel = opts.selStore.get();
      const a = sel.kind === "caret" ? sel.at : sel.anchor;
      if (a.blockId !== this.active.start.blockId) {
        this.close();
      }
    });
  }

  destroy(): void {
    this.close();
    this.unsubSel?.();
    this.unsubSel = null;
  }

  /** Called by nativeInput AFTER a successful insertText dispatch. */
  onTextInserted(text: string): void {
    if (this.active) {
      this.active.query += text;
      this.active.ctrl.onTextChange?.(this.active.query);
      return;
    }
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
