import { $ } from "bun";
import { resolve } from "path";

const root = import.meta.dir;
const outDir = resolve(root, "dist");

await $`rm -rf ${outDir}`;

const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["creo"],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await $`bunx tsc -p tsconfig.build.json`;

// Copy the optional plugin stylesheet so consumers can
//   import "creo-editor/dist/plugins/styles.css";
await $`mkdir -p ${resolve(outDir, "plugins")}`;
await $`cp ${resolve(root, "src/plugins/styles.css")} ${resolve(outDir, "plugins/styles.css")}`;

console.log("\n✓ Build complete → dist/");
const stat = Bun.file(resolve(outDir, "index.js"));
console.log(`  index.js  ${(stat.size / 1024).toFixed(1)} KB`);
