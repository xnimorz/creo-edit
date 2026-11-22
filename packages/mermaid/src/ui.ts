// ---------------------------------------------------------------------------
// One block's UI: the bar, the diagram, the code field.
//
// Plain DOM, not a creo view. Three reasons, each a constraint rather than a
// preference:
//
//  - The engine owns the canvas and replaces its contents on every draw; the
//    renderer must not think those nodes are its own.
//  - creo delegates event handlers from the app root, which is ABOVE the
//    editor. A field inside a block has to stop its events before they reach
//    the editor root (`isolateInput`), which is also before they would reach
//    creo — so a handler attached through creo props would never run.
//  - The overlay is positioned from measured rects after each draw, which is
//    imperative whatever draws it.
//
// The creo view (`view.ts`) renders only the block's shell element and hands
// it here.
// ---------------------------------------------------------------------------

import { closestEditor, isolateInput } from "creo-edit";
import { icons } from "./icons";
import { runtimeOf, type BlockUiHandle, type MermaidRuntime } from "./runtime";
import type {
  EngineMounted,
  MermaidAction,
  MermaidBlock,
  MermaidDiagnostic,
  MermaidMode,
} from "./types";
import { VisualLayer, type VisualHost } from "./visual";

type State = "empty" | "loading" | "ready" | "error";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
};

const later = (fn: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 16);
};

/** A press on a control must not move the editor's caret or take the focus. */
const keepFocus = (e: Event): void => e.preventDefault();

export class MermaidBlockUI implements VisualHost, BlockUiHandle {
  readonly stage: HTMLElement;
  readonly canvas: HTMLElement;
  readonly overlay: HTMLElement;

  private readonly bar: HTMLElement;
  private readonly codeWrap: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly emptyEl: HTMLElement;
  private readonly visual: VisualLayer;

  private rt: MermaidRuntime | null = null;
  private mounted: EngineMounted | null = null;
  /** The source the engine was last given. */
  private drawn: string | null = null;
  private state: State = "loading";
  /** Text in the code field that the document does not have yet. */
  private draft: string | null = null;
  /** Source being shown in place of the document's while a label is typed. */
  private previewSrc: string | null = null;
  /** Counts draws, so a caller can tell whether its `draw()` produced one. */
  private renders = 0;
  private note: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private drawQueued = false;
  private tries = 0;
  private dead = false;
  private off: (() => void)[] = [];

  constructor(
    readonly root: HTMLElement,
    private block: MermaidBlock,
  ) {
    this.bar = el("div", "ce-mermaid-bar");
    this.bar.setAttribute("role", "toolbar");

    this.codeWrap = el("div", "ce-mermaid-code");
    this.codeWrap.hidden = true;
    this.textarea = el("textarea", "ce-mermaid-source");
    this.textarea.spellcheck = false;
    this.textarea.autocapitalize = "off";
    this.textarea.setAttribute("autocorrect", "off");
    this.textarea.setAttribute("autocomplete", "off");
    this.textarea.rows = 1;
    this.codeWrap.appendChild(this.textarea);

    this.stage = el("div", "ce-mermaid-stage");
    this.canvas = el("div", "ce-mermaid-canvas");
    this.canvas.tabIndex = -1;
    this.overlay = el("div", "ce-mermaid-overlay");
    this.stage.append(this.canvas, this.overlay);

    this.emptyEl = el("div", "ce-mermaid-empty");
    this.emptyEl.hidden = true;

    root.append(this.bar, this.codeWrap, this.stage, this.emptyEl);
    root.dataset.mode = "diagram";
    root.dataset.state = "loading";

    this.visual = new VisualLayer(this);
    this.wireTextarea();
    this.connect();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Find this editor's runtime. On the very first mount the editor has not
   * published itself on its root yet (the root's own `onMount` runs after its
   * children's), so this retries: once in a microtask, then per frame.
   */
  private connect(): void {
    if (this.dead || this.rt) return;
    const rt = runtimeOf(closestEditor(this.root));
    if (!rt) {
      if (this.tries++ > 60) return;
      if (this.tries === 1) queueMicrotask(() => this.connect());
      else later(() => this.connect());
      return;
    }
    this.rt = rt;
    rt.uis.set(this.block.id, this);
    this.off.push(rt.modes.subscribe(() => this.syncMode()));
    this.textarea.setAttribute("aria-label", rt.labels.sourceLabel);

    const intent = rt.intents.get(this.block.id);
    if (intent) {
      rt.intents.delete(this.block.id);
      if (intent.mode) rt.setMode(this.block.id, intent.mode);
    }
    this.syncMode();
    this.draw();
    if (intent?.focus) {
      later(() => {
        // A frame has passed. If the user has put the focus somewhere of
        // their own in the meantime, it stays there.
        const active = document.activeElement;
        const free =
          !active ||
          active === document.body ||
          active === this.root.closest("[data-creo-edit]");
        if (this.dead || !free) return;
        if (this.mode() === "code") this.textarea.focus({ preventScroll: true });
        else if (this.state === "ready") this.canvas.focus({ preventScroll: true });
      });
    }
  }

  /** The renderer has a new version of the block. */
  setBlock(next: MermaidBlock): void {
    if (this.dead) return;
    if (next.id !== this.block.id && this.rt) {
      this.rt.uis.delete(this.block.id);
      this.rt.uis.set(next.id, this);
    }
    this.block = next;
    // The draft has reached the document; it is no longer a draft.
    if (this.draft !== null && next.source === this.draft) this.draft = null;
    if (!this.rt) return;
    if (this.mode() === "code" && document.activeElement !== this.textarea) {
      // Not being typed in: show what the document has. (While it IS being
      // typed in, a change from elsewhere does not pull the text out from
      // under the caret; the next commit decides.)
      this.draft = null;
      this.fillTextarea();
    }
    this.draw();
  }

  destroy(): void {
    if (this.dead) return;
    // Leaving with text the document has not seen would lose it.
    this.commitDraft();
    this.dead = true;
    for (const f of this.off) f();
    this.off = [];
    if (this.note) clearTimeout(this.note.timer);
    this.visual.destroy();
    this.mounted?.destroy();
    this.mounted = null;
    if (this.rt?.uis.get(this.block.id) === this) this.rt.uis.delete(this.block.id);
  }

  // -------------------------------------------------------------------------
  // VisualHost
  // -------------------------------------------------------------------------

  runtime(): MermaidRuntime | null {
    return this.rt;
  }

  source(): string {
    return this.block.source;
  }

  canvasSource(): string {
    return this.drawn ?? "";
  }

  preview(next: string | null): void {
    if (next === this.previewSrc) return;
    this.previewSrc = next;
    this.draw();
  }

  interactive(): boolean {
    const rt = this.rt;
    return (
      !!rt &&
      rt.options.visualEditing !== false &&
      this.state === "ready" &&
      this.mode() === "diagram" &&
      rt.editor.isEditable()
    );
  }

  commit(next: string): boolean {
    const rt = this.rt;
    if (!rt || next === this.block.source) return false;
    const ok = rt.editor.dispatch({
      t: "mermaid.setSource",
      payload: { blockId: this.block.id, source: next },
    });
    if (!ok) return false;
    // Draw now rather than a frame later, when the renderer comes round: an
    // edit made by hand should answer the hand. The renderer's `setBlock`
    // then finds the same source already drawn and does nothing.
    this.block = { ...this.block, source: next };
    this.previewSrc = null;
    const before = this.renders;
    this.draw();
    // Already on the canvas (it was being previewed): nothing was drawn, so
    // nothing told the visual layer to pick its selection back up.
    if (this.renders === before && this.state === "ready") this.visual.sync();
    return true;
  }

  toast(message: string): void {
    if (this.note) clearTimeout(this.note.timer);
    this.note = {
      text: message,
      timer: setTimeout(() => {
        this.note = null;
        this.renderBar();
      }, 2600),
    };
    this.renderBar();
  }

  changed(): void {
    this.renderBar();
  }

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------

  mode(): MermaidMode {
    return this.rt?.mode(this.block.id) ?? "diagram";
  }

  private current(): string {
    return this.previewSrc ?? this.draft ?? this.block.source;
  }

  private syncMode(): void {
    const rt = this.rt;
    if (!rt || this.dead) return;
    const mode = this.mode();
    const was = this.root.dataset.mode;
    this.root.dataset.mode = mode;
    this.codeWrap.hidden = mode !== "code";
    if (mode === "code") {
      this.previewSrc = null;
      this.textarea.readOnly = !rt.editor.isEditable();
      if (was !== "code") this.fillTextarea();
      else this.autosize();
    } else if (was === "code") {
      this.commitDraft();
    }
    // Whether the diagram can be edited by hand depends on the mode.
    if (this.state === "ready") this.visual.sync();
    this.renderBar();
  }

  private setMode(mode: MermaidMode): void {
    const rt = this.rt;
    if (!rt) return;
    rt.setMode(this.block.id, mode);
    // The store has already told `syncMode`, so the field is on screen.
    // Focus it now, not a frame later: a deferred focus would land AFTER
    // whatever the user did next and take the keyboard away from it.
    if (mode === "code" && this.mode() === "code") {
      this.textarea.focus({ preventScroll: true });
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private setState(state: State): void {
    this.state = state;
    this.root.dataset.state = state;
    this.emptyEl.hidden = state !== "empty";
    this.stage.hidden = state === "empty";
  }

  private draw(): void {
    const rt = this.rt;
    if (!rt || this.dead) return;
    const src = this.current();

    if (src.trim() === "") {
      this.mounted?.destroy();
      this.mounted = null;
      this.drawn = null;
      this.canvas.replaceChildren();
      this.setState("empty");
      this.visual.reset();
      this.renderEmpty();
      this.renderBar();
      return;
    }

    const engine = rt.engineNow();
    if (!engine) {
      // Hold the block's place at the height it last had, so the document
      // does not jump when the diagram arrives.
      if (this.state !== "ready") {
        this.setState("loading");
        this.stage.style.minHeight = `${rt.heights.get(this.block.id) ?? 120}px`;
      }
      rt.engine().then(
        () => this.draw(),
        (e) => this.fail({ message: `Could not load the diagram engine. ${String(e?.message ?? e)}` }),
      );
      return;
    }

    if (this.mounted && src === this.drawn) return;
    this.drawn = src;
    if (this.state === "empty") this.setState("loading");
    const hooks = {
      onRender: (): void => this.rendered(),
      onError: (d: MermaidDiagnostic): void => this.fail(d, true),
    };
    if (!this.mounted) this.mounted = engine.mount(this.canvas, src, hooks);
    else this.mounted.update(src);
  }

  private rendered(): void {
    if (this.dead) return;
    const rt = this.rt;
    this.renders++;
    this.setState("ready");
    this.stage.style.minHeight = "";
    const h = this.stage.offsetHeight;
    if (rt && h > 0) rt.heights.set(this.block.id, h);
    this.visual.sync();
    this.renderBar();
  }

  /** `shown`: the engine has already put its own message in the canvas. */
  private fail(d: MermaidDiagnostic, shown = false): void {
    if (this.dead) return;
    this.setState("error");
    this.stage.style.minHeight = "";
    if (!shown) {
      const msg = el("div", "ce-mermaid-error");
      msg.textContent = d.message;
      this.canvas.replaceChildren(msg);
    }
    this.visual.reset();
    this.renderBar();
  }

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    later(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  // -------------------------------------------------------------------------
  // Code field
  // -------------------------------------------------------------------------

  private wireTextarea(): void {
    const ta = this.textarea;
    // Listeners first, then the isolation: both sit on this node and run in
    // the order they were added, so ours still fire.
    ta.addEventListener("input", () => {
      this.draft = ta.value;
      this.autosize();
      // The picture follows the typing, one draw per frame.
      this.queueDraw();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Throw the draft away and go back to the picture.
        this.draft = null;
        this.fillTextarea();
        this.setMode("diagram");
        this.draw();
        this.rt?.editor.focus();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.commitDraft();
        this.setMode("diagram");
      } else if (e.key === "Tab" && !e.shiftKey && !ta.readOnly) {
        e.preventDefault();
        // `insertText` keeps the field's own undo history intact, which
        // assigning `.value` would wipe.
        if (!document.execCommand?.("insertText", false, "  ")) {
          ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end");
          ta.dispatchEvent(new Event("input"));
        }
      }
    });
    ta.addEventListener("blur", () => this.commitDraft());
    this.off.push(isolateInput(ta));
  }

  private fillTextarea(): void {
    this.textarea.value = this.current();
    this.autosize();
  }

  private autosize(): void {
    const ta = this.textarea;
    ta.style.height = "auto";
    const h = ta.scrollHeight;
    if (h > 0) ta.style.height = `${h + 2}px`;
  }

  /** Write the draft to the document — once, so one edit is one undo step. */
  private commitDraft(): void {
    const rt = this.rt;
    const draft = this.draft;
    if (!rt || draft === null) return;
    this.draft = null;
    if (draft === this.block.source || !rt.editor.isEditable()) return;
    const ok = rt.editor.dispatch({
      t: "mermaid.setSource",
      payload: { blockId: this.block.id, source: draft },
    });
    if (ok) this.block = { ...this.block, source: draft };
  }

  // -------------------------------------------------------------------------
  // Empty block
  // -------------------------------------------------------------------------

  private renderEmpty(): void {
    const rt = this.rt;
    if (!rt) return;
    this.emptyEl.replaceChildren();
    const title = el("div", "ce-mermaid-empty-title");
    title.textContent = rt.labels.emptyTitle;
    this.emptyEl.appendChild(title);
    if (!rt.editor.isEditable()) return;
    const hint = el("div", "ce-mermaid-empty-hint");
    hint.textContent = rt.labels.emptyHint;
    const grid = el("div", "ce-mermaid-templates");
    for (const t of rt.templates) {
      const b = el("button", "ce-mermaid-template");
      b.type = "button";
      b.textContent = t.title;
      b.dataset.template = t.id;
      b.addEventListener("pointerdown", keepFocus);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        // `commit` draws at once when the engine is loaded, so the canvas
        // is there to take the focus.
        if (this.commit(t.source) && !this.stage.hidden) {
          this.canvas.focus({ preventScroll: true });
        }
      });
      grid.appendChild(b);
    }
    this.emptyEl.append(hint, grid);
  }

  // -------------------------------------------------------------------------
  // Actions and the bar
  // -------------------------------------------------------------------------

  /**
   * Everything that can be done to this block right now. The bar draws it;
   * `mermaidActions()` hands the same list to a host for its own menu.
   */
  actions(): MermaidAction[] {
    const rt = this.rt;
    if (!rt) return [];
    const L = rt.labels;
    const mode = this.mode();
    const out: MermaidAction[] = [];
    if (rt.options.code !== false) {
      out.push({
        key: "mode",
        scope: "block",
        label: mode === "code" ? L.diagram : L.code,
        icon: mode === "code" ? icons.diagram : icons.code,
        on: mode === "code",
        run: () => this.setMode(mode === "code" ? "diagram" : "code"),
      });
    }
    const kit = this.visual.kit;
    if (kit && this.interactive()) {
      out.push({
        key: "add",
        scope: "block",
        label: `Add ${kit.item}`,
        icon: icons.plus,
        run: () => {
          this.visual.focusCanvas();
          this.visual.addNode(null);
        },
      });
      if (kit.setDirection) {
        out.push({
          key: "direction",
          scope: "block",
          label: L.direction,
          icon: this.visual.horizontal() ? icons.right : icons.down,
          run: () => this.visual.toggleDirection(),
        });
      }
    }
    if (this.current().trim() !== "") {
      out.push({
        key: "copy",
        scope: "block",
        label: L.copy,
        icon: icons.copy,
        run: () => this.copySource(),
      });
      out.push({
        key: "download",
        scope: "block",
        label: L.download,
        icon: icons.download,
        disabled: this.state !== "ready",
        run: () => this.downloadSvg(),
      });
    }
    return out.concat(this.visual.entityActions());
  }

  private renderBar(): void {
    const rt = this.rt;
    if (!rt || this.dead) return;
    const bar = this.bar;
    bar.replaceChildren();
    if (rt.options.bar === false) {
      bar.hidden = true;
      return;
    }
    const L = rt.labels;
    const actions = this.actions().filter((a) => a.scope === "block");
    const press = (b: HTMLButtonElement, run: () => void): void => {
      b.addEventListener("pointerdown", keepFocus);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        run();
      });
    };

    const mode = this.mode();
    if (actions.some((a) => a.key === "mode")) {
      const seg = el("div", "ce-mermaid-switch");
      seg.setAttribute("role", "group");
      for (const m of ["diagram", "code"] as const) {
        const b = el("button", "ce-mermaid-seg");
        b.type = "button";
        b.innerHTML = `${m === "diagram" ? icons.diagram : icons.code}<span>${m === "diagram" ? L.diagram : L.code}</span>`;
        b.setAttribute("aria-pressed", String(mode === m));
        b.dataset.mode = m;
        press(b, () => this.setMode(m));
        seg.appendChild(b);
      }
      bar.appendChild(seg);
    }

    for (const a of actions) {
      if (a.key === "mode" || a.key === "copy" || a.key === "download") continue;
      const b = el("button", "ce-mermaid-btn");
      b.type = "button";
      b.dataset.action = a.key;
      // The one action a newcomer needs is spelled out; the rest are icons.
      b.innerHTML = a.key === "add" ? `${a.icon}<span>${a.label}</span>` : a.icon;
      b.title = a.label;
      b.setAttribute("aria-label", a.label);
      press(b, a.run);
      bar.appendChild(b);
    }

    // What applies to the node or edge selected in the diagram. In the bar,
    // not floating beside the selection, so it never covers a neighbour.
    const entity = this.actions().filter((a) => a.scope === "entity");
    if (entity.length > 0) {
      const group = el("div", "ce-mermaid-entity");
      group.setAttribute("role", "group");
      const small = (
        a: { label: string; icon: string; on?: boolean; run(): void },
        key: string,
      ): HTMLButtonElement => {
        const b = el("button", "ce-mermaid-btn ce-mermaid-icon");
        b.type = "button";
        b.dataset.action = key;
        b.innerHTML = a.icon;
        b.title = a.label;
        b.setAttribute("aria-label", a.label);
        if (a.on) b.setAttribute("aria-pressed", "true");
        press(b, a.run);
        return b;
      };
      for (const a of entity) {
        if (a.choices) {
          const choices = el("div", "ce-mermaid-choices");
          choices.setAttribute("role", "group");
          choices.setAttribute("aria-label", a.label);
          for (const c of a.choices) choices.appendChild(small(c, `${a.key}:${c.key}`));
          group.appendChild(choices);
        } else {
          group.appendChild(small(a, a.key));
        }
      }
      bar.appendChild(group);
    }

    const info = el("div", "ce-mermaid-info");
    if (this.note) {
      info.textContent = this.note.text;
      info.dataset.kind = "note";
    } else if (entity.length === 0 && this.visual.kit && this.interactive()) {
      info.textContent = L.hint;
    }
    bar.appendChild(info);

    for (const a of actions) {
      if (a.key !== "copy" && a.key !== "download") continue;
      const b = el("button", "ce-mermaid-btn");
      b.type = "button";
      b.dataset.action = a.key;
      b.innerHTML = a.icon;
      b.title = a.label;
      b.setAttribute("aria-label", a.label);
      b.disabled = a.disabled === true;
      press(b, a.run);
      bar.appendChild(b);
    }
  }

  private copySource(): void {
    const text = this.current();
    const done = (): void => this.toast(this.rt?.labels.copied ?? "Copied");
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clip?.writeText) void clip.writeText(text).then(done, () => {});
  }

  private downloadSvg(): void {
    const svg = this.canvas.querySelector("svg");
    if (!svg) return;
    const copy = svg.cloneNode(true) as SVGElement;
    // Chrome of ours has no business in a file.
    for (const n of Array.from(copy.querySelectorAll(".ce-mmd-hit"))) n.remove();
    for (const n of Array.from(copy.querySelectorAll("[data-ce-entity]"))) {
      n.removeAttribute("data-ce-entity");
      n.classList.remove("ce-mmd-selected", "ce-mmd-target");
    }
    copy.style.opacity = "";
    if (!copy.getAttribute("xmlns")) copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const blob = new Blob([copy.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "diagram.svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
