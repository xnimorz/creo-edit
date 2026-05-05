// ---------------------------------------------------------------------------
// runsAt registry — pluggable lookup for the "runs slot at this anchor"
// abstraction that every text command goes through.
//
// Hot path: called on every keystroke, so we avoid an if/else chain by going
// through a Map<type, fn>. The default fallback handles text-bearing blocks
// (anything with a `runs: InlineRun[]` field at the top level), so plugins
// only need to register `runsAt` for blocks with nested cells.
//
// This module is the single seam that `model/cellAccess.ts` re-exports from
// — keeping the public `runsAt(block, anchor)` callable signature unchanged
// for every text command in the codebase.
// ---------------------------------------------------------------------------

import type { Anchor, Block, InlineRun } from "../model/types";
import type { RunsCtx } from "./types";

type RunsAtFn = (b: Block, a: Anchor) => RunsCtx | null;

const fnByType = new Map<string, RunsAtFn>();

export function registerRunsAt(type: string, fn: RunsAtFn): void {
  fnByType.set(type, fn);
}

/** Default for any block exposing a top-level `runs` array. */
function defaultTextBearing(b: Block, _a: Anchor): RunsCtx | null {
  if ("runs" in b && Array.isArray((b as { runs?: InlineRun[] }).runs)) {
    const tb = b as Block & { runs: InlineRun[] };
    return {
      runs: tb.runs,
      setRuns: (newRuns) => ({ ...tb, runs: newRuns } as Block),
    };
  }
  return null;
}

export function runsAt(block: Block, anchor: Anchor): RunsCtx | null {
  const fn = fnByType.get(block.type);
  if (fn) return fn(block, anchor);
  return defaultTextBearing(block, anchor);
}

/** Total length of the runs container at `anchor` — convenience helper used
 *  by both text commands and the IME composition diff. */
export function runsLengthAt(block: Block, anchor: Anchor): number {
  const ctx = runsAt(block, anchor);
  if (!ctx) return 0;
  let n = 0;
  for (const r of ctx.runs) n += r.text.length;
  return n;
}
