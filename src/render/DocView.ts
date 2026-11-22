import { _ } from "creo";
import { ol, ul, view } from "creo";
import type { Block, BlockId, DocState, ListItemBlock } from "../model/types";
import { getView } from "../plugin/registry";

/**
 * BlockView — single dispatch view, looks the renderer up by `block.type`
 * in the plugin view registry. The previous switch statement is gone;
 * registering a new block kind is a `registerView` call from a plugin.
 *
 * `shouldUpdate` is an identity check on `block`. Because doc updates produce
 * a fresh top-level DocState but reuse references for unchanged blocks, this
 * lets the reconciler skip every block that wasn't touched.
 */
const BlockView = view<{ block: Block; selected?: boolean }>(({ props }) => ({
  shouldUpdate(next) {
    const cur = props();
    return next.block !== cur.block || next.selected !== cur.selected;
  },
  render() {
    const { block: b, selected } = props();
    const v = getView(b.type);
    if (!v) return; // Unknown block kind — silently skip; plugin missing.
    v(selected ? { block: b, key: b.id, selected } : { block: b, key: b.id });
  },
}));

/**
 * Group consecutive `li` blocks of the same `ordered` flag into a single
 * `<ul>`/`<ol>`. Returns spans `[start, end)` over `doc.order`.
 */
type Span = { kind: "single"; pos: number } | {
  kind: "list";
  ordered: boolean;
  start: number;
  end: number;
};

function planSpans(doc: DocState): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < doc.order.length) {
    const block = doc.byId.get(doc.order[i]!)!;
    if (block.type === "li") {
      const ordered = (block as ListItemBlock).ordered;
      let j = i + 1;
      while (j < doc.order.length) {
        const b2 = doc.byId.get(doc.order[j]!)!;
        if (b2.type !== "li") break;
        if ((b2 as ListItemBlock).ordered !== ordered) break;
        j++;
      }
      out.push({ kind: "list", ordered, start: i, end: j });
      i = j;
    } else {
      out.push({ kind: "single", pos: i });
      i++;
    }
  }
  return out;
}

/** `selected`: the atomic block the selection covers whole, told to its view. */
export const DocView = view<{ doc: DocState; selected?: BlockId | null }>(({ props }) => ({
  shouldUpdate(next) {
    const cur = props();
    return next.doc !== cur.doc || next.selected !== cur.selected;
  },
  render() {
    const { doc, selected } = props();
    const spans = planSpans(doc);
    for (const span of spans) {
      if (span.kind === "single") {
        const b = doc.byId.get(doc.order[span.pos]!)!;
        BlockView({ block: b, key: b.id, selected: b.id === selected });
      } else {
        // Group key spans the included ids — stable as long as the same
        // contiguous run keeps the same start/end ids in order.
        const firstId = doc.order[span.start]!;
        const lastId = doc.order[span.end - 1]!;
        const groupKey = `list:${span.ordered ? "o" : "u"}:${firstId}:${lastId}`;
        const renderItems = () => {
          for (let i = span.start; i < span.end; i++) {
            const b = doc.byId.get(doc.order[i]!)!;
            BlockView({ block: b, key: b.id, selected: b.id === selected });
          }
        };
        if (span.ordered) {
          ol({ class: "ce-list", key: groupKey }, renderItems);
        } else {
          ul({ class: "ce-list", key: groupKey }, renderItems);
        }
      }
    }
    void _;
  },
}));
