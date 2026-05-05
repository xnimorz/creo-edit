// ---------------------------------------------------------------------------
// runsAt — re-exported from the plugin runsAt registry. The implementation
// itself moved to src/plugin/runsAt.ts so that block kinds with nested cells
// (table, columns, future plugin blocks) can register their own resolver
// without growing an if/else chain in the core.
//
// Default behavior (unchanged): blocks with a top-level `runs: InlineRun[]`
// field expose them directly; blocks with no runs slot return null. Built-in
// table / columns codecs are installed by the default plugin set.
// ---------------------------------------------------------------------------

export type { RunsCtx } from "../plugin/types";
export { runsAt, runsLengthAt } from "../plugin/runsAt";
