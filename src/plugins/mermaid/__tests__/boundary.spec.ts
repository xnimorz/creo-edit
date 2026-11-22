import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The mermaid plugin is a separate entry point (`creo-edit/mermaid`) and is
// meant to be liftable into its own package. That only stays true if it uses
// the editor the way any outside plugin must: through `src/index.ts`. A
// relative import that reaches past it into the editor's internals would
// work today and break the day the plugin moves.
describe("mermaid plugin — import boundary", () => {
  const dir = join(import.meta.dir, "..");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const ALLOWED = new Set(["creo", "pele/lazy", "@visimer/core", "../../index"]);

  test("imports only its own files, the public entry, creo, and its two engines", () => {
    const offenders: string[] = [];
    for (const f of files) {
      // Usage examples in comments name the package itself; they are not imports.
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const specs = [
        ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1]!);
      for (const s of specs) {
        const own = s.startsWith("./");
        if (!own && !ALLOWED.has(s)) offenders.push(`${f}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the service-worker helper imports nothing at all", () => {
    // It runs in a worker, where the editor (and the DOM it assumes) is not.
    const text = readFileSync(join(dir, "sw.ts"), "utf8");
    expect(text).not.toMatch(/^\s*import\s/m);
  });

  test("the engines are reached only by dynamic import", () => {
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      // A static import would put Pele in every page that loads the plugin,
      // diagram or not.
      expect(text).not.toMatch(/^import\s[^;]*from\s+["'](pele[^"']*|@visimer\/core)["']/m);
    }
  });
});
