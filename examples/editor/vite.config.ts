import { defineConfig } from "vite";
import path from "path";

// `creo-edit` is aliased to the local source so the example tracks the
// editor as you edit it — no rebuild step in the dev loop. `creo` resolves
// from this example's `node_modules` (declared in package.json).
export default defineConfig({
  server: {
    port: 5183,
    strictPort: true,
    fs: {
      allow: [path.resolve(__dirname, "../..")],
    },
  },
  resolve: {
    alias: {
      // The mermaid plugin is its own package (`packages/mermaid`). Aliased to
      // its source like the editor is, so the example tracks both live. It
      // goes FIRST: aliases match by prefix, in order, and the bare
      // "creo-edit" below would otherwise swallow "creo-edit-mermaid-plugin".
      // Its two engines (pele, @visimer/core) resolve from
      // `packages/mermaid/node_modules` — run `bun install` there once.
      "creo-edit-mermaid-plugin": path.resolve(
        __dirname,
        "../../packages/mermaid/src/index.ts",
      ),
      // Same for the rail plugin, and FIRST for the same reason.
      "creo-edit-rail-plugin": path.resolve(
        __dirname,
        "../../packages/rail/src/index.ts",
      ),
      "creo-edit": path.resolve(__dirname, "../../src/index.ts"),
      // Editor source files do `import { ... } from "creo"`. Without this
      // alias, Rollup can't find creo when walking into ../../src/ — there's
      // no node_modules/creo at the editor repo root, only the example
      // installs one. Pin both editor source AND example to the same copy.
      creo: path.resolve(__dirname, "node_modules/creo/dist/index.js"),
    },
  },
});
