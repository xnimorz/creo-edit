# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `bun run build` — runs `build.ts` (Bun bundle to `dist/index.js` ESM, then `tsc -p tsconfig.build.json` to emit `.d.ts`).
- `bun test src/` — runs the suite. Tests live in `src/**/__tests__/*.spec.ts`. Each test file explicitly `import "./setup"` (or `../__tests__/setup`) to install happy-dom globals — there is no global preload, so a new test file must do the same.
- Single file: `bun test src/__tests__/caret.spec.ts`. Single test: `bun test --test-name-pattern "<name>"`.
- `bun run typecheck` — `tsc --noEmit -p tsconfig.json`.
- `src/__perf__/` holds perf-style specs that also run under `bun test`.

`creo` is declared as a peer-dep (`>=0.2.5`); the published package has no other runtime deps. The root `package.json` still lists `creo: workspace:*` as a devDep — historical from the monorepo, not currently installed.

## Sub-projects

- **`docs/`** — Vite-built documentation site (markdown + hash router). Aliases `creo-editor` → `../src/index.ts` so it tracks editor source live, and aliases `creo` → its own `node_modules/creo/dist/index.js` so editor source's `import "creo"` resolves when Rollup walks into `../src/`. The landing page embeds a real `createEditor()` so users can try it without leaving the page; `/demo` is a full-bleed version. Deployed to GitHub Pages by `.github/workflows/deploy-docs.yml`. Run with `cd docs && bun run dev`.
- **`examples/editor/`** — Vite + Playwright example app, primarily used for E2E tests (`bun run test`). Same alias setup as docs (`creo-editor` → local source, `creo` → local node_modules). Dev server on port 5183.

## Architecture

**Two independent stores.** `docStore: Store<DocState>` holds the document; `selStore: Store<Selection>` holds the cursor/range. They are deliberately separate so caret motion does not dirty document subscribers and vice versa. Every command function takes `{ docStore, selStore }` and mutates whichever stores it needs.

**No `contentEditable`.** A hidden `<textarea>` (`input/HiddenInput.ts`) captures all keystrokes, IME composition, mobile soft keyboards, and clipboard events. `input/inputPipeline.ts` wires the textarea to commands; `input/keymap.ts` maps chords to `Command`s. `pointToAnchor` (`render/measure.ts`) hit-tests pointer events back to model anchors. The editor root sets `cursor:text` and `white-space:pre-wrap` (the latter is required — `normal` collapses trailing spaces so typing space at end-of-line wouldn't render).

**Block model** (`model/types.ts`). `DocState = { byId: Map<BlockId, Block>; order: BlockId[] }` where `order` is sorted by each block's `index: FracIndex` — a base-62 fractional key so insert-between is O(log n) with no renumbering (`model/fractional.ts`). `attachAutoRebalance` runs a microtask check after each mutation and rebalances only when a key has outgrown the soft threshold. Block kinds: `p`, `h1..h6`, `li` (with `ordered`/`depth`), `img`, `table`, `columns`.

**Anchors** are `{ blockId, path: number[], offset }`. Path encoding by block type:
- text-bearing (`p`/`h*`/`li`): `[charOffset]`
- `table`: `[row, col, charOffset]`
- `columns`: `[colIndex, charOffset]`
- `img`: `[side]` where `side` is 0 (before) or 1 (after)

`runsAt(block, anchor)` (`model/cellAccess.ts`) is the canonical way to walk into the right runs slot regardless of block kind — prefer it over hand-rolled path indexing.

**Commands and history.** `createEditor.dispatch(cmd)` is the single mutation entry point. It calls `history.record(tag)` *before* applying the command; matching tags coalesce into one undo step (`textCommands` insert/deleteBackward/deleteForward use `text:insert`, `text:deleteBack`, `text:deleteFwd` so consecutive typing collapses). New commands live under `src/commands/<group>Commands.ts` and are wired into the `Command` union and `dispatch` switch in `createEditor.ts`.

**Render layer.** `render/DocView.ts` is the keyed reconciler over `doc.order`. Block immutability + identity-based `shouldUpdate` makes per-keystroke render cost O(1) blocks — only the touched block re-renders. `render/blocks/` contains one view per block type. `CaretOverlay`, `SelectionHandles`, and `MobileToolbar` are absolute-positioned overlays driven by `selStore`. Views are built with Creo's public API (`view`, `use`, `store`, primitive functions); raw DOM listeners are reserved for events Creo's event map doesn't expose (composition, drag/drop, clipboard, `mousedown` for focus-preserve, `visualViewport`).

**Virtualization** (`virtual/`). When `virtualized: true`, `VirtualDoc` mounts only blocks intersecting `[scrollTop − overscan, scrollTop + viewport + overscan]`; `HeightIndex` is a Fenwick tree of measured per-block heights for O(log n) viewport resolution. The host page must provide a scroll container.

**Clipboard / HTML** (`clipboard/`). `htmlParser.ts` → blocks for paste and `setDocFromHTML`; `htmlSerializer.ts` ← selection for copy/cut. `drop.ts` handles drag-and-drop including image upload via `opts.uploadImage`.

**Mobile.** `input/mobile.ts` — coarse-pointer detection, `visualViewport` tracking to keep the caret visible when the soft keyboard opens. The hidden textarea is positioned at the caret (so iOS scroll-into-view targets the right spot) and uses `font-size:16px` to prevent iOS auto-zoom. `MobileToolbar` replaces the action menu lost by not being `contentEditable`.

**Public API surface** is `src/index.ts` — anything exported there is part of the package contract; internal helpers should not be re-exported casually.
