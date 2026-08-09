import type { Store } from "creo";
import { maybeRebalance } from "./doc";
import type { BlockId, DocState } from "./types";

/**
 * Watch a docStore and schedule a microtask rebalance whenever any
 * fractional index grows past the soft threshold.
 *
 * Rebalance assigns fresh, evenly-spaced indices to every block (preserving
 * order). It's O(n) and runs at most once per microtask, so worst-case a
 * 600k-block doc rebalances in ~50ms — and only ever triggers under
 * adversarial insertion patterns.
 *
 * The *check* is O(n) too, and it used to run after every mutation — so on a
 * document of one block per line, typing a character scanned every line in
 * the file to conclude nothing had changed. It can't have: a fractional index
 * is only ever minted by an insert, and an insert always produces a new
 * `order` array, while a text edit hands the same array through untouched
 * (`updateBlock` reuses the reference when the index is unchanged). So the
 * array's identity is an exact "could any key have grown?" test.
 */
export function attachAutoRebalance(
  docStore: Store<DocState>,
): () => void {
  let scheduled = false;
  let lastScanned: BlockId[] | null = null;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const cur = docStore.get();
      if (cur.order === lastScanned) return;
      lastScanned = cur.order;
      const next = maybeRebalance(cur);
      if (next !== cur) {
        // The rebalance rewrote every index, so what we just scanned is not
        // what the store now holds — track the replacement instead.
        lastScanned = next.order;
        docStore.set(next);
      }
    });
  };
  return docStore.subscribe(schedule);
}
