import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A package of its own: it must use the editor the way any outside plugin
// does, through `creo-edit` and nothing behind it. In this repository the
// editor's sources are one directory up, so a relative import into them would
// compile, pass every test here, and fail for everyone installing from npm.
describe("rail plugin — import boundary", () => {
  test("imports only its own files and creo-edit", () => {
    const dir = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      const specs = [
        ...text.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1]!);
      for (const s of specs) if (!s.startsWith("./") && s !== "creo-edit") offenders.push(`${f}: ${s}`);
    }
    expect(offenders).toEqual([]);
  });
});
