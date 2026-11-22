import { blockTextOf, isTextBearing, type Block, type DocState, type Editor } from "creo-edit";
import type { RailPoint } from "./types";

export type HeadingPointsOptions = {
  /** Which levels get a tick. Default 1–3. */
  levels?: number[];
  /** Put the first lines under each heading in its card. Default true. */
  detail?: boolean;
};

const HEADING = /^h([1-6])$/;

/**
 * `points` for a document: a tick per heading, longer the higher the heading.
 *
 *   railPlugin({ points: headingPoints({ levels: [1, 2] }) })
 */
export function headingPoints(
  options: HeadingPointsOptions = {},
): (doc: DocState, editor?: Editor) => RailPoint[] {
  const levels = new Set(options.levels ?? [1, 2, 3]);
  const withDetail = options.detail !== false;
  const deepest = Math.max(...levels);
  return (doc) => {
    const points: RailPoint[] = [];
    let open: RailPoint | null = null;
    for (const id of doc.order) {
      const block = doc.byId.get(id);
      if (!block) continue;
      const level = levelOf(block);
      if (level !== null) {
        // Any heading closes the section, a level without a tick included.
        open = null;
        if (!levels.has(level)) continue;
        const label = blockTextOf(block).trim();
        if (label.length === 0) continue;
        open = { blockId: id, label, size: deepest === 1 ? 1 : 1 - (level - 1) / deepest };
        points.push(open);
        continue;
      }
      if (withDetail && open !== null && open.detail === undefined && isTextBearing(block)) {
        const text = blockTextOf(block).trim();
        if (text.length > 0) open.detail = text;
      }
    }
    return points;
  };
}

function levelOf(block: Block): number | null {
  const match = HEADING.exec(block.type);
  return match ? Number(match[1]) : null;
}
