// ---------------------------------------------------------------------------
// Inline widget manager — non-text content placed WITHIN a line.
//
// Custom blocks are block-level, and non-text ones must be `isAtomic`, which
// means exactly two caret positions and `contenteditable="false"` around the
// whole thing: an island BETWEEN blocks, not something inside a line of text.
// Ghost-text completions and LSP inlay hints both need the latter.
//
// It genuinely cannot be faked with a styled span, because a span's text
// enters the character-offset walk and every anchor after it on the line
// shifts. So a widget must be invisible to three things, and each is handled
// in exactly one place:
//
//   1. The character-offset walk — `plugin/anchorCodec.ts` skips subtrees
//      marked `data-ce-inline-widget`, for every block using the default or
//      code-block codec. Custom codecs must honour the same attribute.
//   2. IME composition diffing — `input/nativeInput.ts` reads the affected
//      scope through `visibleTextOf`, which strips widget subtrees; otherwise
//      a multi-line ghost-text suggestion would read as a phantom insertion.
//   3. Clipboard serialization — free: `clipboard/htmlSerializer.ts`
//      serializes from the MODEL, and widgets are not in the model.
//
// `contenteditable="false"` on the widget root handles the browser side of
// caret navigation (arrow keys step over an atomic inline), but none of the
// three above — those are creo-edit's own logic.
//
// DOM ownership. The renderer owns block DOM, so widgets are re-inserted
// after each render rather than reconciled by creo. A run renders as
// `span[data-run-index]` holding a single text node, and creo rewrites that
// span's `textContent` wholesale when the run changes — which discards the
// widget, and `sync()` puts it back on the same tick. That is why the manager
// listens to the doc store rather than to a MutationObserver: it never
// observes its own writes, so there is no feedback loop.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type { Anchor, BlockId, DocState, Selection } from "../model/types";
import { anchorToDom } from "../dom/anchorMap";
import { scrollSourceFor } from "../dom/scroll";
import { INLINE_WIDGET_ATTR } from "./anchorCodec";
import type { DecorationViewport, InlineWidgetDef } from "./types";
import type { Registry } from "./registry";

export type InlineWidgetManagerOptions = {
  registry: Registry;
  docStore: Store<DocState>;
  selStore: Store<Selection>;
  editorRoot: HTMLElement;
};

type MountedWidget = {
  def: InlineWidgetDef;
  host: HTMLElement;
  anchor: Anchor;
  data: unknown;
  cleanup: (() => void) | void;
};

export class InlineWidgetManager {
  private mounted = new Map<string, MountedWidget>();
  private unsubDoc: (() => void) | null = null;
  private unsubSel: (() => void) | null = null;
  private rafQueued = false;
  private scrollSource: HTMLElement | Window;

  constructor(private opts: InlineWidgetManagerOptions) {
    this.unsubDoc = opts.docStore.subscribe(() => this.schedule());
    // Ghost text is positioned at the caret, so selection moves matter as
    // much as document edits.
    this.unsubSel = opts.selStore.subscribe(() => this.schedule());
    // The editor's own scroll container, not `window` — scroll doesn't
    // bubble, so an editor in an `overflow: auto` pane never reaches window.
    // See dom/scroll.ts.
    this.scrollSource = scrollSourceFor(opts.editorRoot);
    this.scrollSource.addEventListener("scroll", this.schedule, {
      passive: true,
    } as never);
    window.addEventListener("resize", this.schedule);
    this.sync();
  }

  destroy(): void {
    this.unsubDoc?.();
    this.unsubSel?.();
    this.unsubDoc = null;
    this.unsubSel = null;
    this.scrollSource.removeEventListener("scroll", this.schedule);
    window.removeEventListener("resize", this.schedule);
    for (const m of this.mounted.values()) this.unmountOne(m);
    this.mounted.clear();
  }

  private schedule = (): void => {
    if (this.rafQueued) return;
    this.rafQueued = true;
    // Deferred to after the render flush — the block's fresh DOM has to exist
    // before a widget can be spliced into it.
    const cb = () => {
      this.rafQueued = false;
      this.sync();
    };
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(cb);
    else queueMicrotask(cb);
  };

  /** Recompute placements and reconcile the mounted set. Public so a host can
   *  force a pass after changing state its sources read (a completion arriving
   *  from a language server, say). */
  sync(): void {
    const defs = this.opts.registry.inlineWidgets;
    if (defs.length === 0) return;
    const doc = this.opts.docStore.get();
    const viewport = this.mountedViewport();

    // Group placements by insertion point so `affinity` can order several
    // widgets sharing an anchor: "before" ones first, then "after" ones.
    type Wanted = { key: string; def: InlineWidgetDef; anchor: Anchor; data: unknown };
    const wanted: Wanted[] = [];
    for (const def of defs) {
      let placements;
      try {
        placements = def.at(doc, viewport) ?? [];
      } catch {
        // A throwing source drops its own widgets and nothing else.
        continue;
      }
      for (const p of placements) {
        if (!p?.anchor) continue;
        wanted.push({
          key: `${def.id}::${anchorKey(p.anchor)}`,
          def,
          anchor: p.anchor,
          data: p.data,
        });
      }
    }
    wanted.sort(
      (a, b) => affinityRank(a.def) - affinityRank(b.def),
    );

    const wantedKeys = new Set(wanted.map((w) => w.key));
    for (const [key, m] of this.mounted) {
      if (!wantedKeys.has(key)) {
        this.unmountOne(m);
        this.mounted.delete(key);
      }
    }

    for (const w of wanted) {
      const existing = this.mounted.get(w.key);
      if (existing && existing.host.isConnected) continue;
      if (existing) {
        // The renderer replaced the run's text node and took the host with
        // it. Re-place the same host rather than re-running `mount`, so a
        // widget holding internal state (an animating spinner, a focused
        // control) survives an unrelated keystroke elsewhere in the block.
        if (this.place(existing.host, w.anchor)) continue;
        this.unmountOne(existing);
        this.mounted.delete(w.key);
        continue;
      }
      const host = this.createHost(w.def);
      if (!this.place(host, w.anchor)) continue; // block not mounted — retry later
      let cleanup: (() => void) | void = undefined;
      try {
        cleanup = w.def.mount(host, { anchor: w.anchor, data: w.data }) ?? undefined;
      } catch {
        host.remove();
        continue;
      }
      this.mounted.set(w.key, {
        def: w.def,
        host,
        anchor: w.anchor,
        data: w.data,
        cleanup,
      });
    }
  }

  private createHost(def: InlineWidgetDef): HTMLElement {
    const host = document.createElement("span");
    host.setAttribute(INLINE_WIDGET_ATTR, def.id);
    // Keeps the browser from putting the caret inside and from treating the
    // widget's text as editable content. Necessary, but not sufficient — see
    // the module comment.
    host.setAttribute("contenteditable", "false");
    host.setAttribute("data-affinity", def.affinity ?? "after");
    host.className = `ce-inline-widget ce-inline-widget-${def.id}`;
    const interactive = def.interactive === true;
    Object.assign(host.style, {
      // Inert by default: ghost text must not swallow a click meant for the
      // text under it. A clickable inlay hint opts in.
      pointerEvents: interactive ? "auto" : "none",
      userSelect: "none",
      whiteSpace: "pre-wrap",
    } as Partial<CSSStyleDeclaration>);
    return host;
  }

  /** Splice `host` into the DOM at `anchor`. Returns false when the anchor's
   *  block isn't mounted (virtualized off-screen) — the next sync retries. */
  private place(host: HTMLElement, anchor: Anchor): boolean {
    const point = anchorToDom(anchor, this.opts.editorRoot);
    if (!point) return false;
    const { node, offset } = point;
    try {
      if (node.nodeType === 3) {
        const text = node as Text;
        const parent = text.parentNode;
        if (!parent) return false;
        if (offset <= 0) {
          parent.insertBefore(host, text);
        } else if (offset >= text.data.length) {
          parent.insertBefore(host, skipWidgets(text.nextSibling));
        } else {
          // Split is safe: for a run span creo holds a reference to the SPAN
          // (single-text-child fast path) and rewrites `textContent`, never
          // to this text node, so the halves are not aliased by the renderer.
          const rest = text.splitText(offset);
          parent.insertBefore(host, rest);
        }
        return true;
      }
      const el = node as HTMLElement;
      const before = skipWidgets(el.childNodes[offset] ?? null);
      el.insertBefore(host, before);
      return true;
    } catch {
      return false;
    }
  }

  private unmountOne(m: MountedWidget): void {
    try {
      m.cleanup?.();
    } catch {
      // Plugin error on teardown — still detach the node.
    }
    m.host.remove();
  }

  private mountedViewport(): DecorationViewport | null {
    const els = this.opts.editorRoot.querySelectorAll<HTMLElement>(
      "[data-block-kind][data-block-id]",
    );
    if (els.length === 0) return null;
    const first = els[0]!.getAttribute("data-block-id");
    const last = els[els.length - 1]!.getAttribute("data-block-id");
    if (!first || !last) return null;
    return { firstBlock: first as BlockId, lastBlock: last as BlockId };
  }
}

/**
 * Step past widgets already sitting at this insertion point, so the newcomer
 * lands after them. Placement runs in affinity order ("before" widgets first),
 * so "insert after everything already here" is exactly the ordering the
 * affinity flag promises.
 */
function skipWidgets(ref: Node | null): Node | null {
  let cur = ref;
  while (
    cur &&
    cur.nodeType === 1 &&
    (cur as HTMLElement).hasAttribute(INLINE_WIDGET_ATTR)
  ) {
    cur = cur.nextSibling;
  }
  return cur;
}

function anchorKey(a: Anchor): string {
  return `${a.blockId}:${a.path.join(",")}`;
}

/** "before" widgets sort ahead of "after" ones at the same insertion point. */
function affinityRank(def: InlineWidgetDef): number {
  return def.affinity === "before" ? 0 : 1;
}
