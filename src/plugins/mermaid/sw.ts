// ---------------------------------------------------------------------------
// creo-edit/mermaid/sw — cache the diagram engine in a host's service worker.
//
// You probably do not need this. If your app BUNDLES `pele` and
// `@visimer/core` (the plugin loads both with `import()`, so a bundler emits
// them as separate hashed files), they are ordinary built files and whatever
// already precaches your build caches them too.
//
// This is for the other case: the engine comes from a CDN or another origin,
// outside your precache list. A library cannot register a service worker —
// the file has to be served from your origin, and its scope and update policy
// are yours — so this is a handler to call from the worker you already have:
//
//   import { cacheMermaidEngine } from "creo-edit/mermaid/sw";
//   const mermaid = cacheMermaidEngine();
//   self.addEventListener("fetch", (event) => {
//     if (mermaid(event)) return;
//     // …the rest of your routing
//   });
//
// Cache-first, and never revalidated: it only takes URLs that carry a version
// (`…/pele@1.13.0/…`), which never change what they serve.
//
// This file imports nothing, on purpose — it runs in a worker, where the
// editor does not.
// ---------------------------------------------------------------------------

export type MermaidCacheOptions = {
  /** Which requests to take. Default: a versioned `pele@x` or
   *  `@visimer/core@x` path on any origin. */
  match?: (url: URL) => boolean;
  /** Cache Storage name. Default "creo-edit-mermaid-v1". */
  cacheName?: string;
};

/** The parts of a `FetchEvent` the handler uses. */
export type FetchEventLike = {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
  waitUntil?(work: Promise<unknown>): void;
};

/** A path segment naming one of the two packages at a pinned version. */
const VERSIONED = /\/(pele|@visimer\/core)@\d[^/]*\//;

export const defaultMermaidMatch = (url: URL): boolean => VERSIONED.test(url.pathname);

/**
 * Build a fetch handler. It returns `true` when it took the request (and has
 * called `respondWith`), `false` when the request is not its to answer.
 */
export function cacheMermaidEngine(
  options: MermaidCacheOptions = {},
): (event: FetchEventLike) => boolean {
  const match = options.match ?? defaultMermaidMatch;
  const cacheName = options.cacheName ?? "creo-edit-mermaid-v1";

  return (event) => {
    const { request } = event;
    if (request.method !== "GET") return false;
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return false;
    }
    if (!match(url)) return false;

    event.respondWith(
      (async () => {
        const cache = await caches.open(cacheName);
        const hit = await cache.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        // Keep only what can be served again as is. An opaque response (a
        // no-cors request) has status 0 and may be an error page.
        if (response.ok) {
          const put = cache.put(request, response.clone()).catch(() => {});
          if (event.waitUntil) event.waitUntil(put);
          else await put;
        }
        return response;
      })(),
    );
    return true;
  };
}
