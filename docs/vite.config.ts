import { defineConfig } from "vite";
import path from "path";
import { markdownPlugin } from "./src/markdown/plugin";

// `base: "./"` so the same build works at any subpath — gh-pages serves
// the site under `/creo-edit/` (or whatever the repo name is) and a local
// `vite preview` serves it at `/`.
export default defineConfig({
  base: "./",
  plugins: [markdownPlugin()],
  resolve: {
    alias: {
      // The mermaid plugin is its own package (`packages/mermaid`), aliased
      // to its source like the editor is. It goes FIRST: aliases match by
      // prefix, in order, and the bare "creo-edit" below would otherwise
      // swallow "creo-edit-mermaid-plugin". Its two engines (pele,
      // @visimer/core) resolve from `packages/mermaid/node_modules` — run
      // `bun install` there once.
      "creo-edit-mermaid-plugin": path.resolve(
        __dirname,
        "../packages/mermaid/src/index.ts",
      ),
      // Pull `creo-edit` straight from this repo's source. Vite bundles
      // the result, so the deployed docs site is self-contained.
      "creo-edit": path.resolve(__dirname, "../src/index.ts"),
      // The editor's source files do `import { ... } from "creo"`. Without
      // this alias, Rollup can't resolve those imports when walking into
      // ../src/ — there's no node_modules/creo at the repo root, only the
      // docs site has one installed. Pin both editor source AND docs site
      // to the same copy so we don't bundle creo twice.
      creo: path.resolve(__dirname, "node_modules/creo/dist/index.js"),
    },
  },
  server: {
    fs: {
      // Allow Vite to read files from the parent directory (the editor src).
      allow: [path.resolve(__dirname, "..")],
    },
  },
});
