// ---------------------------------------------------------------------------
// Per-editor runtime.
//
// The block's view is registered once per block TYPE, in a module-global
// registry shared by every editor on the page — so the view cannot close over
// one editor's options. What is per editor lives here instead, keyed by the
// editor, and a block's UI finds it by walking up from its own element
// (`closestEditor`).
//
// It also owns the two lazy loads. Both are remembered as a promise AND as a
// plain value once resolved: a block scrolled back into a virtualized window
// must draw synchronously, and "await an already-resolved promise" is still a
// microtask too late for that.
// ---------------------------------------------------------------------------

import { store, type Store } from "creo";
import type { BlockId, Editor } from "../../index";
import { loadPeleEngine } from "./engine";
import type { VisimerModule } from "./kits";
import { defaultMermaidTemplates } from "./templates";
import type {
  MermaidEngine,
  MermaidLabels,
  MermaidMode,
  MermaidPluginOptions,
  MermaidTemplate,
} from "./types";

export const defaultLabels: MermaidLabels = {
  diagram: "Diagram",
  code: "Code",
  copy: "Copy source",
  copied: "Copied",
  download: "Download SVG",
  direction: "Change direction",
  edit: "Edit text",
  shape: "Shape",
  line: "Line",
  reverse: "Reverse",
  delete: "Delete",
  emptyTitle: "Start a diagram",
  emptyHint: "Pick a starting point, or switch to Code and write your own.",
  sourceLabel: "Mermaid source",
  hint: "Double-click to rename · drag a dot to connect · + adds a connected one · Tab adds the next",
  rejected: "That change would break the diagram, so it was not applied.",
};

/** What a block's UI should do once it exists (a block that was just
 *  inserted has no element to act on yet). */
export type BlockIntent = {
  mode?: MermaidMode;
  focus?: boolean;
};

/** The slice of a block's UI the runtime and the action list reach. */
export type BlockUiHandle = {
  actions(): import("./types").MermaidAction[];
};

export type MermaidRuntime = {
  readonly editor: Editor;
  readonly options: MermaidPluginOptions;
  readonly labels: MermaidLabels;
  readonly templates: readonly MermaidTemplate[];
  readonly modes: Store<ReadonlyMap<BlockId, MermaidMode>>;
  mode(id: BlockId): MermaidMode;
  setMode(id: BlockId, mode: MermaidMode): void;
  /** The engine if it has loaded, else null. */
  engineNow(): MermaidEngine | null;
  engine(): Promise<MermaidEngine>;
  /** The source rewriter if it has loaded, else null. */
  visimerNow(): VisimerModule | null;
  visimer(): Promise<VisimerModule>;
  /** Last drawn height per block, so a block still waiting for the engine
   *  holds its place instead of jumping when the diagram arrives. */
  readonly heights: Map<BlockId, number>;
  readonly uis: Map<BlockId, BlockUiHandle>;
  readonly intents: Map<BlockId, BlockIntent>;
  /** Start the warm-up now. Idempotent. */
  preload(): void;
  destroy(): void;
};

const runtimes = new WeakMap<Editor, MermaidRuntime>();

export const runtimeOf = (editor: Editor | null | undefined): MermaidRuntime | null =>
  (editor && runtimes.get(editor)) ?? null;

export function createRuntime(
  editor: Editor,
  options: MermaidPluginOptions,
): MermaidRuntime {
  const modes =
    options.modes ?? store.new<ReadonlyMap<BlockId, MermaidMode>>(new Map());

  let engineValue: MermaidEngine | null = null;
  let enginePromise: Promise<MermaidEngine> | null = null;
  const engine = (): Promise<MermaidEngine> =>
    (enginePromise ??= (
      options.engine
        ? options.engine()
        : loadPeleEngine({ links: options.links, images: options.images })
    ).then(
      (e) => (engineValue = e),
      (err) => {
        // Let a later block try again rather than caching the failure.
        enginePromise = null;
        throw err;
      },
    ));

  let visimerValue: VisimerModule | null = null;
  let visimerPromise: Promise<VisimerModule> | null = null;
  const visimer = (): Promise<VisimerModule> =>
    (visimerPromise ??= (
      import("@visimer/core") as unknown as Promise<VisimerModule>
    ).then(
      (m) => (visimerValue = m),
      (err) => {
        visimerPromise = null;
        throw err;
      },
    ));

  let preloaded = false;
  let idleHandle: number | null = null;
  const warm = (): void => {
    if (preloaded) return;
    preloaded = true;
    void engine()
      .then((e) => e.preload?.(options.preloadTypes ?? ["flowchart", "sequence"]))
      .catch(() => {});
    if (options.visualEditing !== false && editor.isEditable()) {
      void visimer().catch(() => {});
    }
  };

  const rt: MermaidRuntime = {
    editor,
    options,
    labels: { ...defaultLabels, ...options.labels },
    templates: options.templates ?? defaultMermaidTemplates,
    modes,
    mode(id) {
      if (options.code === false) return "diagram";
      return modes.get().get(id) ?? "diagram";
    },
    setMode(id, mode) {
      if (rt.mode(id) === mode) return;
      const next = new Map(modes.get());
      if (mode === "diagram") next.delete(id);
      else next.set(id, mode);
      modes.set(next);
    },
    engineNow: () => engineValue,
    engine,
    visimerNow: () => visimerValue,
    visimer,
    heights: new Map(),
    uis: new Map(),
    intents: new Map(),
    preload: warm,
    destroy() {
      if (idleHandle !== null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleHandle);
      }
      rt.uis.clear();
      rt.intents.clear();
      runtimes.delete(editor);
    },
  };
  runtimes.set(editor, rt);

  const how = options.preload ?? "idle";
  const saveData =
    typeof navigator !== "undefined" &&
    (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
  if (how === "eager") warm();
  else if (how === "idle" && !saveData && typeof window !== "undefined") {
    if (typeof requestIdleCallback === "function") {
      idleHandle = requestIdleCallback(() => warm(), { timeout: 4000 });
    } else {
      setTimeout(warm, 1500);
    }
  }
  return rt;
}
