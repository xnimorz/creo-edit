import { $ } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

const root = import.meta.dir;
const outDir = resolve(root, "dist");
const editor = resolve(root, "../..");

await $`rm -rf ${outDir}`;

// Declarations are checked against the editor's BUILT declarations
// (`tsconfig.build.json`): its sources would be pulled in and emitted here.
if (!existsSync(resolve(editor, "dist/index.d.ts"))) {
  console.log("creo-edit is not built yet — building it first…");
  await $`bun run build`.cwd(editor);
}

// The editor is the host's: one copy, shared with the host's own imports.
const main = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["creo-edit"],
});
if (!main.success) {
  console.error("Build failed (creo-edit-rail-plugin):");
  for (const log of main.logs) console.error(log);
  process.exit(1);
}

await $`bunx tsc -p tsconfig.build.json`.cwd(root);
await $`cp ${resolve(root, "src/styles.css")} ${resolve(outDir, "styles.css")}`;

console.log("\n✓ Build complete → dist/");
console.log(`  index.js  ${(Bun.file(resolve(outDir, "index.js")).size / 1024).toFixed(1)} KB`);
