import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// This is a package of its own: it must use the editor the way any outside
// plugin does, through the `creo-edit` package and nothing behind it. In this
// repository the editor's sources are one directory up, so a relative import
// that reached into them would compile, pass every test here — and fail for
// everyone who installs the package from npm.
describe("mermaid plugin — import boundary", () => {
  const dir = join(import.meta.dir, "..");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const ALLOWED = new Set(["creo", "creo-edit", "pele/lazy", "@visimer/core"]);

  test("imports only its own files, creo-edit, creo, and its two engines", () => {
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
