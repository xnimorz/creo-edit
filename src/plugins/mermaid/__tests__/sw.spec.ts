import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cacheMermaidEngine, defaultMermaidMatch } from "../sw";

// A worker has `caches` and `fetch`; a test has neither the way a worker
// does. Both are replaced with the smallest thing that behaves the same.
type Store = Map<string, Response>;
const stores = new Map<string, Store>();
let fetched: string[] = [];
const realFetch = globalThis.fetch;
const g = globalThis as unknown as { caches?: unknown; fetch: unknown };

beforeEach(() => {
  stores.clear();
  fetched = [];
  g.caches = {
    async open(name: string) {
      let s = stores.get(name);
      if (!s) stores.set(name, (s = new Map()));
      const store = s;
      return {
        match: async (req: Request) => store.get(req.url)?.clone(),
        put: async (req: Request, res: Response) => void store.set(req.url, res),
      };
    },
  };
  g.fetch = async (req: Request) => {
    fetched.push(req.url);
    return req.url.includes("missing")
      ? new Response("no", { status: 404 })
      : new Response(`body of ${req.url}`, { status: 200 });
  };
});
afterEach(() => {
  delete g.caches;
  g.fetch = realFetch;
});

async function run(handle: ReturnType<typeof cacheMermaidEngine>, url: string, method = "GET") {
  let answer: Promise<Response> | null = null;
  const pending: Promise<unknown>[] = [];
  const took = handle({
    request: new Request(url, { method }),
    respondWith: (r) => void (answer = r),
    waitUntil: (w) => void pending.push(w),
  });
  const response = answer ? await (answer as Promise<Response>) : null;
  await Promise.all(pending);
  return { took, text: response ? await response.text() : null, status: response?.status };
}

const PELE = "https://cdn.jsdelivr.net/npm/pele@1.13.0/dist/esm/lazy.js";

describe("creo-edit/mermaid/sw", () => {
  test("takes versioned engine URLs and nothing else", () => {
    expect(defaultMermaidMatch(new URL(PELE))).toBe(true);
    expect(defaultMermaidMatch(new URL("https://esm.sh/@visimer/core@1.1.4/dist/index.js"))).toBe(true);
    // Unversioned: what it serves can change, so cache-first would pin a stale copy.
    expect(defaultMermaidMatch(new URL("https://cdn.jsdelivr.net/npm/pele/dist/pele.js"))).toBe(false);
    expect(defaultMermaidMatch(new URL("https://example.com/api/pele"))).toBe(false);
  });

  test("first request goes to the network and is kept; the second never leaves", async () => {
    const handle = cacheMermaidEngine();
    const first = await run(handle, PELE);
    expect(first.took).toBe(true);
    expect(first.text).toBe(`body of ${PELE}`);
    expect(fetched).toEqual([PELE]);
    const second = await run(handle, PELE);
    expect(second.text).toBe(`body of ${PELE}`);
    expect(fetched).toEqual([PELE]);
  });

  test("leaves other requests, and non-GET, to the host's own routing", async () => {
    const handle = cacheMermaidEngine();
    expect((await run(handle, "https://example.com/app.js")).took).toBe(false);
    expect((await run(handle, PELE, "POST")).took).toBe(false);
    expect(fetched).toEqual([]);
  });

  test("a failed response is passed through but not kept", async () => {
    const handle = cacheMermaidEngine();
    const url = "https://cdn.jsdelivr.net/npm/pele@9.9.9/missing.js";
    expect((await run(handle, url)).status).toBe(404);
    await run(handle, url);
    expect(fetched).toEqual([url, url]);
  });

  test("match and cacheName are the host's to set", async () => {
    const handle = cacheMermaidEngine({ match: (u) => u.pathname.startsWith("/vendor/"), cacheName: "mine" });
    expect((await run(handle, "https://app.test/vendor/engine.js")).took).toBe(true);
    expect(stores.has("mine")).toBe(true);
    expect((await run(handle, PELE)).took).toBe(false);
  });
});
