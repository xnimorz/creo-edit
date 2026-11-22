import { $ } from "bun";
import { resolve } from "path";

const root = import.meta.dir;
const outDir = resolve(root, "dist");

await $`rm -rf ${outDir}`;

const fail = (what: string, logs: unknown[]): never => {
  console.error(`Build failed (${what}):`);
  for (const log of logs) console.error(log);
  process.exit(1);
};

// 1. The main entry — one self-contained file, as it has always been.
const main = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["creo"],
});
if (!main.success) fail("creo-edit", main.logs);

// 2. `creo-edit/mermaid` — a second entry that must share ONE copy of the
// editor with the first.
//
// It registers its block into module-global registries (views, codecs, the
// atomic set) that the main entry reads. Bundled on its own it would carry a
// private copy of them and register into a registry nobody consults. So its
// one import of the editor — `../../index`, which a spec holds it to — is
// left as an import of the BUILT main entry, `../../index.js`: the same
// module instance at runtime, whoever loads it first.
//
// (Bun's `splitting: true` over both entries was the obvious way to say this.
// As of Bun 1.2.8 it emits a main entry with a duplicate `export` for every
// name the second entry imports from it, which does not parse.)
//
// `pele` and `@visimer/core` are optional peers, loaded with `import()` at
// runtime; they stay external so the host's bundler splits and hashes them.
const mermaidOut = resolve(outDir, "plugins/mermaid");
const mermaid = await Bun.build({
  entrypoints: [resolve(root, "src/plugins/mermaid/index.ts")],
  outdir: mermaidOut,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["creo", "pele", "pele/*", "@visimer/core"],
  plugins: [
    {
      name: "share-the-main-entry",
      setup(build) {
        build.onResolve({ filter: /^\.\.\/\.\.\/index$/ }, () => ({
          path: "../../index.js",
          external: true,
        }));
      },
    },
  ],
});
if (!mermaid.success) fail("creo-edit/mermaid", mermaid.logs);

// Bun keeps an external's specifier as it was written — `../../index`, with
// no extension — whatever path the resolve hook returns. A bundler would
// resolve that; a browser or Node loading the file directly would not. Give
// it the extension, and fail loudly if the shape ever changes under us.
{
  const file = resolve(mermaidOut, "index.js");
  const built = await Bun.file(file).text();
  const fixed = built.replaceAll(/(from\s*)"\.\.\/\.\.\/index"/g, '$1"../../index.js"');
  if (fixed === built || /["']\.\.\/\.\.\/index["']/.test(fixed)) {
    fail("creo-edit/mermaid", ["could not point the mermaid entry at ../../index.js"]);
  }
  await Bun.write(file, fixed);
}

// 3. `creo-edit/mermaid/sw` — for a host's service worker. It imports
// nothing, and has to stay one file: a worker cannot be handed chunks.
const sw = await Bun.build({
  entrypoints: [resolve(root, "src/plugins/mermaid/sw.ts")],
  outdir: mermaidOut,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
});
if (!sw.success) fail("creo-edit/mermaid/sw", sw.logs);

await $`bunx tsc -p tsconfig.build.json`;

// Copy the optional plugin stylesheet so consumers can
//   import "creo-edit/plugins/styles.css";
await $`mkdir -p ${resolve(outDir, "plugins")}`;
await $`cp ${resolve(root, "src/plugins/styles.css")} ${resolve(outDir, "plugins/styles.css")}`;
//   import "creo-edit/mermaid/styles.css";
await $`mkdir -p ${resolve(outDir, "plugins/mermaid")}`;
await $`cp ${resolve(root, "src/plugins/mermaid/styles.css")} ${resolve(outDir, "plugins/mermaid/styles.css")}`;

console.log("\n✓ Build complete → dist/");
const stat = Bun.file(resolve(outDir, "index.js"));
console.log(`  index.js  ${(stat.size / 1024).toFixed(1)} KB`);
const mermaidStat = Bun.file(resolve(outDir, "plugins/mermaid/index.js"));
console.log(`  plugins/mermaid/index.js  ${(mermaidStat.size / 1024).toFixed(1)} KB`);
