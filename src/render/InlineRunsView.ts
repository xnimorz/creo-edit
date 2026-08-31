import { html, span, view } from "creo";
import { orderedMarkDefs } from "../plugin/markRegistry";
import type { InlineRun } from "../model/types";

/**
 * Render a sequence of inline runs as keyed spans.
 *
 * Each run becomes one DOM span with `data-run-index` for caret math, then the
 * spans are wrapped from inside-out by their marks. Wrapping order comes from
 * the mark registry's `order` (code → b → i → u → s → link by default) and is
 * fixed, so toggling a mark never reshuffles the DOM tree under a run.
 *
 * A mark's `domAttrs(attrs)` supplies the wrapper's attributes — that is how
 * `link` gets its `href`. A registered mark with no `tag` renders nothing of
 * its own; it exists in the model only.
 *
 * Empty runs are skipped — but if all runs are empty / list is empty, we emit
 * a single zero-width-space span so the block keeps a measurable line box.
 */

// Creo builds one view per tag; cache them so a repaint doesn't allocate a
// fresh view identity per marked run (which would defeat reconciliation).
const tagViews = new Map<string, ReturnType<typeof html>>();
function tagView(tag: string): ReturnType<typeof html> {
  let v = tagViews.get(tag);
  if (!v) {
    v = html(tag);
    tagViews.set(tag, v);
  }
  return v;
}

const ZWSP = "​";

const RunView = view<{ run: InlineRun; index: number; empty?: boolean }>(({ props }) => ({
  shouldUpdate(next) {
    const cur = props();
    return (
      next.run !== cur.run ||
      next.index !== cur.index ||
      next.empty !== cur.empty
    );
  },
  render() {
    const { run, index, empty } = props();
    const t = run.text.length === 0 ? ZWSP : run.text;
    // `data-empty` lets host CSS show a placeholder ("+ Write…") on empty
    // paragraphs without the framework knowing about it. The flag is
    // only on the synthetic placeholder run, never on real (even empty
    // textually) runs the model stores.
    const sentinelAttrs = empty ? { "data-empty": "true" } : {};
    // View-only per-run styling (syntax tokens, diagnostics …). It lands on
    // the run span itself rather than a wrapper, so it never changes the
    // element count the anchor map walks.
    const cls = run.attrs?.class;
    const classAttr = cls ? { class: cls } : {};
    let inner = () => {
      span(
        { "data-run-index": String(index), ...classAttr, ...sentinelAttrs },
        t,
      );
    };
    if (run.marks && run.marks.size) {
      for (const def of orderedMarkDefs()) {
        if (!def.tag) continue;
        const attrs = run.marks.get(def.name);
        if (attrs === undefined) continue; // mark absent (null = present, no attrs)
        const child = inner;
        const El = tagView(def.tag);
        const domAttrs = def.domAttrs?.(attrs) ?? {};
        inner = () => {
          El(domAttrs as never, child);
        };
      }
    }
    inner();
  },
}));

// Stable singleton placeholder run for empty-runs blocks. Reusing the same
// reference means RunView's identity-based shouldUpdate skips re-renders when
// the block stays empty. Its empty text triggers RunView's ZWSP substitution,
// giving the line a measurable box without leaking any visible glyph.
const EMPTY_PLACEHOLDER_RUN: InlineRun = { text: "" };

export const InlineRunsView = view<{ runs: InlineRun[] }>(({ props }) => ({
  shouldUpdate(next) {
    return next.runs !== props().runs;
  },
  render() {
    const runs = props().runs;
    // Always render via RunView so the children-shape stays stable across
    // empty <-> non-empty transitions. An earlier version branched into a
    // raw <span> placeholder for empty runs; that flipped the children
    // type (primitive <-> composite) and the reconciler ended up keeping
    // the placeholder span around forever instead of swapping it for the
    // RunView with the new text.
    if (runs.length === 0) {
      RunView({ run: EMPTY_PLACEHOLDER_RUN, index: 0, empty: true, key: 0 });
      return;
    }
    for (let i = 0; i < runs.length; i++) {
      RunView({ run: runs[i]!, index: i, key: i });
    }
  },
}));
