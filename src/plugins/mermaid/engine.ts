// ---------------------------------------------------------------------------
// The default engine: Pele (https://github.com/obsidianmd/pele).
//
// Pele is synchronous, has no dependencies, and tags every node and edge in
// its SVG with the id it has in the source — which is what makes the visual
// editor a lookup rather than a guess. It is reached only through a dynamic
// import, so nothing here is in the editor's main bundle and a host's bundler
// splits it into chunks of its own (which a service worker then caches).
//
// `pele/lazy` loads one chunk per diagram TYPE on first use. That makes the
// adapter's one real job: make sure a source's type is loaded before handing
// it to Pele's synchronous `mount` / `update`.
// ---------------------------------------------------------------------------

import type {
  EngineHooks,
  EngineMounted,
  MermaidDiagnostic,
  MermaidEngine,
} from "./types";

/** The slice of `pele/lazy` the adapter uses. Structural, so the plugin's
 *  own typings never mention the package. */
export type PeleLike = {
  detectType(text: string): string | null;
  registered(type: never): boolean;
  load(type: never): Promise<boolean>;
  parse(text: string): unknown;
  mount(
    el: HTMLElement,
    text: string,
    options: Record<string, unknown>,
  ): {
    update(text: string): void;
    refresh(): void;
    destroy(): void;
    readonly error: unknown;
  };
};

export function toDiagnostic(e: unknown): MermaidDiagnostic {
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; line?: unknown; column?: unknown };
    const out: MermaidDiagnostic = {
      message: typeof o.message === "string" ? o.message : String(e),
    };
    if (typeof o.line === "number" && o.line > 0) out.line = o.line;
    if (typeof o.column === "number" && o.column > 0) out.column = o.column;
    return out;
  }
  return { message: String(e) };
}

export type PeleEngineOptions = {
  links?: boolean;
  images?: boolean;
};

export function createPeleEngine(
  pele: PeleLike,
  opts: PeleEngineOptions = {},
): MermaidEngine {
  const loaded = (source: string): boolean => {
    const type = pele.detectType(source);
    // An unknown type has nothing to load; Pele reports it as an error.
    return type === null || pele.registered(type as never);
  };

  return {
    mount(el: HTMLElement, source: string, hooks: EngineHooks): EngineMounted {
      let handle: ReturnType<PeleLike["mount"]> | null = null;
      let latest = source;
      let dead = false;

      const options: Record<string, unknown> = {
        // Zoom and pan would compete with the visual editor's gestures.
        zoom: false,
        links: opts.links === true,
        images: opts.images === true,
        onRender: (r: { type?: string; width: number; height: number }) => {
          hooks.onRender({
            type: r.type ?? null,
            width: r.width,
            height: r.height,
          });
        },
        onError: (e: unknown) => hooks.onError(toDiagnostic(e)),
      };

      const draw = (): void => {
        if (dead) return;
        try {
          if (!handle) handle = pele.mount(el, latest, options);
          else handle.update(latest);
        } catch (e) {
          // Pele rethrows what a host's `onRender` threw. The drawing is in
          // place; report rather than take the block down.
          hooks.onError(toDiagnostic(e));
        }
      };

      const go = (): void => {
        if (loaded(latest)) {
          draw();
          return;
        }
        const want = latest;
        const type = pele.detectType(want);
        void pele.load(type as never).then(
          // Only the newest source is worth drawing once its code arrives.
          () => want === latest && draw(),
          () => want === latest && draw(),
        );
      };

      go();
      return {
        update(next: string): void {
          if (dead) return;
          latest = next;
          go();
        },
        refresh(): void {
          handle?.refresh();
        },
        destroy(): void {
          dead = true;
          handle?.destroy();
          handle = null;
        },
      };
    },

    check(source: string): MermaidDiagnostic | null {
      if (!loaded(source)) return null;
      try {
        pele.parse(source);
        return null;
      } catch (e) {
        return toDiagnostic(e);
      }
    },

    async preload(types = []): Promise<void> {
      await Promise.all(
        types.map((t) => pele.load(t as never).catch(() => false)),
      );
    },
  };
}

/** Load Pele and wrap it. The import specifier is a literal so bundlers can
 *  see it and split it out. */
export async function loadPeleEngine(
  opts: PeleEngineOptions = {},
): Promise<MermaidEngine> {
  const pele = (await import("pele/lazy")) as unknown as PeleLike;
  return createPeleEngine(pele, opts);
}
