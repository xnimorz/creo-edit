import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

const root = import.meta.dir;
const outDir = resolve(root, "dist");
const editor = resolve(root, "../..");

const fail = (what: string, logs: unknown[]): never => {
  console.error(`Build failed (${what}):`);
  for (const log of logs) console.error(log);
  process.exit(1);
};

await $`rm -rf ${outDir}`;

// The plugin's declarations are checked against the editor's BUILT
// declarations (`tsconfig.build.json` maps `creo-edit` to them): pointing at
// the editor's sources would pull them into this program and emit them here.
if (!existsSync(resolve(editor, "dist/index.d.ts"))) {
  console.log("creo-edit is not built yet — building it first…");
  await $`bun run build`.cwd(editor);
}

// Everything the plugin is NOT is external: the editor and creo are the
// host's (peer dependencies — one copy, shared with the host's own imports,
// which is what makes the block register into the registries the editor
// reads), and the two engines are this package's dependencies, reached with
// `import()` so a host's bundler splits them out and loads them on demand.
const main = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["creo", "creo-edit", "pele", "pele/*", "@visimer/core"],
});
if (!main.success) fail("creo-edit-mermaid-plugin", main.logs);

// For a host's service worker. It imports nothing and must stay one file.
const sw = await Bun.build({
  entrypoints: [resolve(root, "src/sw.ts")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
});
if (!sw.success) fail("creo-edit-mermaid-plugin/sw", sw.logs);

await $`bunx tsc -p tsconfig.build.json`.cwd(root);
await $`cp ${resolve(root, "src/styles.css")} ${resolve(outDir, "styles.css")}`;

console.log("\n✓ Build complete → dist/");
console.log(`  index.js  ${(Bun.file(resolve(outDir, "index.js")).size / 1024).toFixed(1)} KB`);
