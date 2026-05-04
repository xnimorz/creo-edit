import { defineConfig } from "vite";
import path from "path";

// `creo-editor` is aliased to the local source so the example tracks the
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
      "creo-editor": path.resolve(__dirname, "../../src/index.ts"),
      // Editor source files do `import { ... } from "creo"`. Without this
      // alias, Rollup can't find creo when walking into ../../src/ — there's
      // no node_modules/creo at the editor repo root, only the example
      // installs one. Pin both editor source AND example to the same copy.
      creo: path.resolve(__dirname, "node_modules/creo/dist/index.js"),
    },
  },
});
