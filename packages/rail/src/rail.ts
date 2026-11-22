import type { BlockId, Editor } from "creo-edit";
import type { RailController, RailPluginOptions, RailPoint } from "./types";

// ---------------------------------------------------------------------------
// The rail: a tick per point down one edge of the scroller the document
// scrolls in. The point being read is lit; hovering or focusing a tick shows
// a card with its label and detail; a click scrolls its block to the top.
//
// The layer is a sibling of the editor's root, as the editor's own decoration
// layer is, and `position: fixed` over the scroller's box. The scroller's box
// does not move when its content scrolls, so the rail stays put without
// following every scroll frame (which would lag the compositor by a frame),
// and is re-placed only when the layout moves it. Living inside the host's
// tree, it is hidden with the editor and sits under the host's dialogs.
// ---------------------------------------------------------------------------

const DEFAULT_READING_LINE = 0.4;
const DEFAULT_JUMP_OFFSET = 16;
const DEFAULT_SIZE = 0.5;
/** Frames a virtualized document gets to draw a block it was scrolled to. */
const JUMP_FRAMES = 12;
/** Within this of either end of the scroll, that end's point is the one lit. */
const END_SLACK = 4;

export type Runtime = {
  controller: RailController;
  mount(root: HTMLElement): () => void;
  destroy(): void;
};

const runtimes = new WeakMap<Editor, Runtime>();

export function runtimeOf(editor: Editor): Runtime | undefined {
  return runtimes.get(editor);
}

export function createRuntime(editor: Editor, options: RailPluginOptions): Runtime {
  let points: RailPoint[] = [];
  /** Each point's place in the document, read with the points. */
  let places: number[] = [];
  /** Every block's place, to tell where a mounted block stands. */
  let order = new Map<BlockId, number>();
  let active = -1;
  let readFrame = 0;
  let destroyed = false;
  let view: View | null = null;

  const read = (): void => {
    readFrame = 0;
    if (destroyed) return;
    const doc = editor.docStore.get();
    order = new Map(doc.order.map((id, index) => [id, index]));
    points = options.points(doc, editor).filter((point) => order.has(point.blockId));
    points.sort((a, b) => order.get(a.blockId)! - order.get(b.blockId)!);
    places = points.map((point) => order.get(point.blockId)!);
    view?.draw();
  };

  const scheduleRead = (): void => {
    if (readFrame !== 0 || destroyed) return;
    readFrame = requestAnimationFrame(read);
  };

  const unsubscribe = editor.docStore.subscribe(scheduleRead);
  read();

  const setActive = (next: number): void => {
    if (next === active) return;
    active = next;
    view?.lightActive();
  };

  const jump = (blockId: BlockId): void => {
    const index = points.findIndex((point) => point.blockId === blockId);
    if (index < 0) return;
    setActive(index);
    view?.jump(points[index]!);
  };

  const controller: RailController = {
    points: () => points,
    active: () => active,
    jump,
    refresh: read,
  };

  const runtime: Runtime = {
    controller,
    mount(root) {
      view?.destroy();
      const mounted = createView(root, {
        options,
        points: () => points,
        places: () => places,
        order: () => order,
        active: () => active,
        setActive,
        jump,
        editor,
      });
      view = mounted;
      mounted.draw();
      return () => {
        mounted.destroy();
        if (view === mounted) view = null;
      };
    },
    destroy() {
      destroyed = true;
      if (readFrame !== 0) cancelAnimationFrame(readFrame);
      unsubscribe();
      view?.destroy();
      view = null;
      runtimes.delete(editor);
    },
  };
  runtimes.set(editor, runtime);
  return runtime;
}

type ViewDeps = {
  options: RailPluginOptions;
  points: () => RailPoint[];
  places: () => number[];
  order: () => Map<BlockId, number>;
  active: () => number;
  setActive: (index: number) => void;
  jump: (blockId: BlockId) => void;
  editor: Editor;
};

type View = {
  draw(): void;
  lightActive(): void;
  jump(point: RailPoint): void;
  destroy(): void;
};

function createView(root: HTMLElement, deps: ViewDeps): View {
  const { options } = deps;
  const side = options.side ?? "left";
  const minPoints = options.minPoints ?? 2;
  const scroller = options.scroller ? options.scroller(root) : scrollerOf(root);
  /** The page itself scrolls: the rail is down the window's edge. */
  const page = scroller === null || scroller === document.scrollingElement || scroller === document.body;

  const layer = document.createElement("div");
  layer.className = `creo-rail creo-rail--${side}`;
  layer.setAttribute("contenteditable", "false");
  const nav = document.createElement("nav");
  nav.className = "creo-rail__ticks";
  nav.setAttribute("aria-label", options.label ?? "Jump to");
  const card = document.createElement("div");
  card.className = "creo-rail__card";
  card.hidden = true;
  card.setAttribute("aria-hidden", "true");
  layer.append(nav, card);
  (root.parentElement ?? root).appendChild(layer);

  let ticks: HTMLButtonElement[] = [];
  let peeked = -1;
  let trackFrame = 0;
  let jumpTurn = 0;
  let destroyed = false;

  // ---- Placement ----------------------------------------------------------

  const place = (): void => {
    const box = page
      ? { top: 0, left: 0, width: document.documentElement.clientWidth, height: window.innerHeight }
      : scroller!.getBoundingClientRect();
    // `clientWidth` leaves out the scrollbar, which the rail must not sit on.
    const width = page ? box.width : scroller!.clientWidth;
    const height = page ? box.height : scroller!.clientHeight;
    Object.assign(layer.style, {
      top: `${box.top}px`,
      left: `${box.left}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    // A transformed ancestor makes `fixed` relative to itself: take the error back out.
    const at = layer.getBoundingClientRect();
    const dx = at.left - box.left;
    const dy = at.top - box.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      layer.style.left = `${box.left - dx}px`;
      layer.style.top = `${box.top - dy}px`;
    }
  };

  const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
  sizes?.observe(page ? document.documentElement : scroller!);
  sizes?.observe(root);

  // ---- The point being read ----------------------------------------------

  const track = (): void => {
    trackFrame = 0;
    if (destroyed) return;
    const places = deps.places();
    if (places.length === 0) return deps.setActive(-1);
    const view = page
      ? { top: 0, bottom: window.innerHeight, height: window.innerHeight }
      : scroller!.getBoundingClientRect();
    const scrolling = page ? document.scrollingElement ?? document.documentElement : scroller!;
    const atEnd = scrolling.scrollHeight - scrolling.scrollTop - scrolling.clientHeight < END_SLACK;
    const line = atEnd ? view.bottom : view.top + view.height * (options.readingLine ?? DEFAULT_READING_LINE);

    // The last block whose top is above the line: in a windowed document the
    // blocks on the page are the only ones with a place to measure.
    const order = deps.order();
    let reached = -1;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-block-id]"))) {
      const at = order.get(el.getAttribute("data-block-id")!);
      if (at === undefined) continue;
      if (el.getBoundingClientRect().top > line) break;
      reached = at;
    }
    let index = -1;
    for (let i = 0; i < places.length && places[i]! <= reached; i++) index = i;
    // As the end lights the last point, the start lights the first: several
    // near the top would otherwise leave the first one never lit.
    if (scrolling.scrollTop < END_SLACK && index > 0) index = 0;
    deps.setActive(index);
  };

  const scheduleTrack = (): void => {
    if (trackFrame === 0 && !destroyed) trackFrame = requestAnimationFrame(track);
  };

  /** Any scroll: the scroller's own moves what is read; one around it moves the scroller. */
  const onScroll = (event: Event): void => {
    if (page || event.target === scroller) scheduleTrack();
    else place();
  };
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  const onResize = (): void => {
    place();
    scheduleTrack();
  };
  window.addEventListener("resize", onResize);

  // ---- Ticks and the card -------------------------------------------------

  const show = (index: number): void => {
    const point = deps.points()[index];
    const tick = ticks[index];
    if (!point || !tick) return hide();
    peeked = index;
    card.replaceChildren();
    const label = document.createElement("div");
    label.className = "creo-rail__label";
    label.textContent = point.label;
    card.appendChild(label);
    if (point.detail) {
      const detail = document.createElement("div");
      detail.className = "creo-rail__detail";
      detail.textContent = point.detail;
      card.appendChild(detail);
    }
    card.hidden = false;
    const rect = tick.getBoundingClientRect();
    const box = layer.getBoundingClientRect();
    card.style.top = `${rect.top + rect.height / 2 - box.top}px`;
    for (const [i, el] of ticks.entries()) el.classList.toggle("is-peeked", i === index);
  };

  const hide = (): void => {
    peeked = -1;
    card.hidden = true;
    for (const el of ticks) el.classList.remove("is-peeked");
  };

  /** The one tick in the tab order: the lit one, or the first. */
  const rove = (): void => {
    const keep = Math.max(0, deps.active());
    for (const [i, el] of ticks.entries()) el.tabIndex = i === keep ? 0 : -1;
  };

  const lightActive = (): void => {
    const active = deps.active();
    for (const [i, el] of ticks.entries()) {
      el.classList.toggle("is-active", i === active);
      if (i === active) el.setAttribute("aria-current", "location");
      else el.removeAttribute("aria-current");
    }
    if (!nav.contains(document.activeElement)) rove();
    // The lit tick stays in sight when there are more than the rail has room for.
    const tick = ticks[active];
    if (tick) {
      const top = tick.offsetTop - nav.offsetTop;
      if (top < nav.scrollTop) nav.scrollTop = top;
      else if (top + tick.offsetHeight > nav.scrollTop + nav.clientHeight) {
        nav.scrollTop = top + tick.offsetHeight - nav.clientHeight;
      }
    }
  };

  const draw = (): void => {
    if (destroyed) return;
    const points = deps.points();
    layer.hidden = points.length < minPoints;
    // Rebuilt only when the points differ, so a hover survives typing elsewhere.
    const same =
      ticks.length === points.length &&
      ticks.every((el, i) => el.dataset["blockId"] === points[i]!.blockId && el.dataset["label"] === points[i]!.label);
    if (!same) {
      ticks = points.map((point, index) => {
        const tick = document.createElement("button");
        tick.type = "button";
        tick.className = "creo-rail__tick";
        tick.dataset["blockId"] = point.blockId;
        tick.dataset["label"] = point.label;
        tick.setAttribute("aria-label", point.label);
        const size = Math.min(1, Math.max(0, point.size ?? DEFAULT_SIZE));
        tick.style.setProperty("--creo-rail-size", String(size));
        const mark = document.createElement("span");
        mark.className = "creo-rail__mark";
        tick.appendChild(mark);
        tick.addEventListener("pointerenter", () => show(index));
        tick.addEventListener("focus", () => show(index));
        tick.addEventListener("blur", hide);
        tick.addEventListener("click", () => deps.jump(point.blockId));
        return tick;
      });
      nav.replaceChildren(...ticks);
      if (peeked >= ticks.length) hide();
      else if (peeked >= 0) show(peeked);
    } else if (peeked >= 0) {
      // Same ticks, newer words: a detail that grew as the document did.
      show(peeked);
    }
    lightActive();
    place();
    scheduleTrack();
  };

  const onNavKey = (event: KeyboardEvent): void => {
    const at = ticks.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let next = -1;
    if (event.key === "ArrowDown") next = Math.min(ticks.length - 1, at + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ticks.length - 1;
    else if (event.key === "Escape") {
      hide();
      return;
    } else return;
    event.preventDefault();
    for (const [i, el] of ticks.entries()) el.tabIndex = i === next ? 0 : -1;
    ticks[next]!.focus();
  };
  nav.addEventListener("keydown", onNavKey);
  nav.addEventListener("pointerleave", () => {
    if (!nav.contains(document.activeElement)) hide();
  });
  // A press on a tick must not take the caret out of the document.
  nav.addEventListener("pointerdown", (event) => event.preventDefault());

  // ---- Jumping ------------------------------------------------------------

  const jumpTo = (point: RailPoint): void => {
    const turn = ++jumpTurn;
    deps.editor.scrollToBlock(point.blockId, { block: "start" });
    const scrolling = page ? document.scrollingElement ?? document.documentElement : scroller!;
    let frames = 0;
    // A windowed document draws the block only once it is scrolled to; it is
    // then put just below the top, which `block: "start"` leaves flush.
    const settle = (): void => {
      if (destroyed || turn !== jumpTurn) return;
      const el = root.querySelector<HTMLElement>(`[data-block-id="${cssEscape(point.blockId)}"]`);
      if (el === null) {
        if (++frames < JUMP_FRAMES) requestAnimationFrame(settle);
        return;
      }
      const top = page ? 0 : scroller!.getBoundingClientRect().top;
      scrolling.scrollTop += el.getBoundingClientRect().top - top - (options.jumpOffset ?? DEFAULT_JUMP_OFFSET);
      if (options.flash !== false) {
        el.animate?.(
          [
            { boxShadow: "0 0 0 2px var(--creo-rail-flash, currentColor)" },
            { boxShadow: "0 0 0 2px transparent" },
          ],
          { duration: 900, easing: "ease-out" },
        );
      }
    };
    requestAnimationFrame(settle);
    options.onJump?.(point);
  };

  return {
    draw,
    lightActive,
    jump: jumpTo,
    destroy() {
      destroyed = true;
      if (trackFrame !== 0) cancelAnimationFrame(trackFrame);
      sizes?.disconnect();
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      layer.remove();
    },
  };
}

/** The nearest ancestor that scrolls vertically; null for the page. */
function scrollerOf(root: HTMLElement): HTMLElement | null {
  for (let el = root.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return el;
  }
  return null;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}
