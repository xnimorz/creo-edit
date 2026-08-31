// ---------------------------------------------------------------------------
// InlineRun ↔ SerializedRun. One implementation, shared by every block
// serialize codec (built-ins, cells, plugins) so the wire format for runs is
// defined in exactly one place.
// ---------------------------------------------------------------------------

import { deserializeMarks, serializeMarks } from "./marks";
import type { InlineRun } from "./types";

export type SerializedRun = {
  text: string;
  /**
   * Marks as `{ name: attrs }` — attrs is `null` for the boolean marks.
   * The legacy `string[]` form is still accepted on read, so documents
   * written before marks carried data load unchanged.
   */
  marks?: Record<string, unknown> | string[];
};

export function serializeRun(r: InlineRun): SerializedRun {
  const marks = serializeMarks(r.marks);
  return marks ? { text: r.text, marks } : { text: r.text };
}

export function deserializeRun(r: SerializedRun): InlineRun {
  const marks = deserializeMarks(r.marks);
  return marks ? { text: r.text, marks } : { text: r.text };
}

export function serializeRuns(runs: InlineRun[]): SerializedRun[] {
  return runs.map(serializeRun);
}

export function deserializeRuns(runs: readonly SerializedRun[] | undefined): InlineRun[] {
  return (runs ?? []).map(deserializeRun);
}
