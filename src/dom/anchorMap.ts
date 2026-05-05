// ---------------------------------------------------------------------------
// DOM ↔ Anchor mapping
//
// The Anchor model ({ blockId, path, offset }) is the canonical selection
// representation. To inter-operate with native browser selection (the
// contentEditable migration), we need to translate between Anchors and DOM
// (Node, offset) pairs in both directions.
//
// This module is pure DOM — it reads `data-block-id` / `data-block-kind` /
// `data-cell` / `data-col` attributes emitted by the block views, and walks
// text descendants to count visible characters. It does NOT need DocState.
//
// Path encoding by block kind:
//   - text-bearing (p / h1..h6 / li / code): [charOffset]
//   - table:                                  [row, col, charOffset]
//   - columns:                                [colIndex, charOffset]
//   - img:                                    [side]   side: 0 = before, 1 = after
// ---------------------------------------------------------------------------

import type { Anchor, BlockId } from "../model/types";

const ZWSP = "​";

export type BlockKind = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "code" | "img" | "table" | "columns";

const TEXT_BEARING_KINDS: ReadonlySet<BlockKind> = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "code",
]);

function isTextBearingKind(k: BlockKind): boolean {
  return TEXT_BEARING_KINDS.has(k);
}

// ---------------------------------------------------------------------------
// Block / cell / col element lookups
// ---------------------------------------------------------------------------

/**
 * Walk up to the nearest element with `data-block-kind` — i.e. the outer
 * block container.
 *
 * Note: table `<td>` and columns `<.ce-col>` ALSO carry `data-block-id`
 * (they share the owning block's id), but only the OUTER block element
 * carries `data-block-kind`. Walking by `data-block-id` would stop at a
 * cell and miss the block; walking by `data-block-kind` lands on the
 * actual block container.
 */
function findOwningBlockEl(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  while (cur && cur.nodeType === 1) {
    const el = cur as HTMLElement;
    if (el.hasAttribute("data-block-kind")) return el;
    cur = el.parentElement;
  }
  return null;
}

/** Walk up to the nearest `<td data-cell="r:c">`. */
function findOwningCellEl(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  while (cur && cur.nodeType === 1) {
    const el = cur as HTMLElement;
    if (el.tagName.toLowerCase() === "td" && el.hasAttribute("data-cell")) {
      return el;
    }
    cur = el.parentElement;
  }
  return null;
}

/** Walk up to the nearest element with `data-col`. */
function findOwningColEl(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  while (cur && cur.nodeType === 1) {
    const el = cur as HTMLElement;
    if (el.hasAttribute("data-col")) return el;
    cur = el.parentElement;
  }
  return null;
}

/**
 * Find the OUTER block element with the given block id, scoped under `root`.
 *
 * Required filter: both `data-block-id` and `data-block-kind` — the latter
 * disambiguates the block container from inner cells (table cells / column
 * cells share the owning block's `data-block-id`).
 */
export function findBlockElementById(
  root: HTMLElement,
  blockId: BlockId,
): HTMLElement | null {
  return root.querySelector(
    `[data-block-kind][data-block-id="${cssEscape(blockId)}"]`,
  ) as HTMLElement | null;
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// Visible-text length helpers
// ---------------------------------------------------------------------------

/** Sum of text node lengths inside `el`, treating ZWSP placeholders as 0. */
function visibleTextLength(el: HTMLElement): number {
  let n = 0;
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const t = (node as Text).data;
      if (t !== ZWSP) n += t.length;
      return;
    }
    for (const c of Array.from(node.childNodes)) walk(c);
  };
  walk(el);
  return n;
}

// ---------------------------------------------------------------------------
// DOM → Anchor (forward)
// ---------------------------------------------------------------------------

/**
 * Convert a (DOM node, offset) selection point into an editor Anchor.
 *
 * Returns null when the node is outside any block element (e.g. user clicked
 * editor chrome). Coarse but never crashes.
 */
export function domToAnchor(
  node: Node,
  offset: number,
  root: HTMLElement,
): Anchor | null {
  // Reject hits outside the editor root.
  if (!root.contains(node) && node !== root) return null;

  const blockEl = findOwningBlockEl(node);
  if (!blockEl) return null;
  const blockId = blockEl.getAttribute("data-block-id");
  const kind = blockEl.getAttribute("data-block-kind") as BlockKind | null;
  if (!blockId || !kind) return null;

  if (isTextBearingKind(kind)) {
    if (kind === "code") {
      const off = offsetWithinCode(blockEl, node, offset);
      return { blockId, path: [off], offset: off };
    }
    const off = offsetWithinScope(blockEl, node, offset);
    return { blockId, path: [off], offset: off };
  }

  if (kind === "table") {
    const td = findOwningCellEl(node);
    if (td) {
      const cellAttr = td.getAttribute("data-cell");
      if (cellAttr) {
        const [rs, cs] = cellAttr.split(":");
        const r = Number(rs);
        const c = Number(cs);
        if (Number.isFinite(r) && Number.isFinite(c)) {
          const off = offsetWithinScope(td, node, offset);
          return { blockId, path: [r, c, off], offset: off };
        }
      }
    }
    return { blockId, path: [0, 0, 0], offset: 0 };
  }

  if (kind === "columns") {
    const colEl = findOwningColEl(node);
    if (colEl) {
      const ci = Number(colEl.getAttribute("data-col"));
      if (Number.isFinite(ci)) {
        const off = offsetWithinScope(colEl, node, offset);
        return { blockId, path: [ci, off], offset: off };
      }
    }
    return { blockId, path: [0, 0], offset: 0 };
  }

  // img — coarse anchor. side=0 unless caret is positioned after the img
  // child within the block element.
  if (kind === "img") {
    const side = imgSideForHit(blockEl, node, offset);
    return { blockId, path: [side], offset: side };
  }

  return null;
}

/**
 * Compute the visible-character offset from the start of `scopeEl` to the
 * (hitNode, localOffset) caret position. Built around `Range.toString()`,
 * which gives us the textual prefix verbatim — we then strip ZWSPs.
 *
 * Works whether the hit is on a text node or an element (e.g. a click on a
 * `<li>` bullet returns `(li, childIndex)`).
 */
function offsetWithinScope(
  scopeEl: HTMLElement,
  hitNode: Node,
  localOffset: number,
): number {
  // Defensive: hit outside scope.
  if (!scopeEl.contains(hitNode) && hitNode !== scopeEl) {
    const cmp = scopeEl.compareDocumentPosition(hitNode);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return visibleTextLength(scopeEl);
    return 0;
  }
  const range = document.createRange();
  try {
    range.selectNodeContents(scopeEl);
    range.setEnd(hitNode, Math.max(0, localOffset));
    const text = range.toString();
    return text.replace(new RegExp(ZWSP, "g"), "").length;
  } catch {
    return 0;
  } finally {
    range.detach?.();
  }
}

/**
 * Code-block flavor of `offsetWithinScope`. The model treats `\n` as a real
 * character at the END of every non-last line, but the DOM uses one
 * `<div class="ce-code-line">` per line with no actual `\n` text — so
 * `Range.toString()` would undercount by one per crossed line. Walk lines
 * manually and add 1 per implicit boundary.
 */
function offsetWithinCode(
  blockEl: HTMLElement,
  hitNode: Node,
  localOffset: number,
): number {
  const lines = blockEl.querySelectorAll<HTMLElement>(".ce-code-line");
  if (lines.length === 0) {
    return offsetWithinScope(blockEl, hitNode, localOffset);
  }
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === hitNode || line.contains(hitNode)) {
      return total + offsetWithinScope(line, hitNode, localOffset);
    }
    total += visibleTextLength(line);
    if (i < lines.length - 1) total += 1; // implicit newline
  }
  // Hit wasn't in any line — clamp to end.
  return total;
}

/**
 * For an img-block hit: decide which side of the img the caret is on.
 * Returns 0 (before) or 1 (after).
 */
function imgSideForHit(
  blockEl: HTMLElement,
  node: Node,
  offset: number,
): 0 | 1 {
  // If the hit is the block element itself, `offset` is a child-index.
  if (node === blockEl) {
    // Find img child index; offset > imgIdx means after.
    const children = Array.from(blockEl.childNodes);
    const imgIdx = children.findIndex(
      (c) => c.nodeType === 1 && (c as HTMLElement).tagName.toLowerCase() === "img",
    );
    if (imgIdx < 0) return 0;
    return offset > imgIdx ? 1 : 0;
  }
  // Otherwise: walk up — if the hit is on/inside the img, treat as side 0.
  // For markers (zero-width spans) we read `data-side`.
  let cur: Node | null = node;
  while (cur && cur !== blockEl) {
    if (cur.nodeType === 1) {
      const el = cur as HTMLElement;
      const sideAttr = el.getAttribute("data-side");
      if (sideAttr === "0" || sideAttr === "1") {
        return sideAttr === "1" ? 1 : 0;
      }
      if (el.tagName.toLowerCase() === "img") return 0;
    }
    cur = cur.parentNode;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Anchor → DOM (reverse)
// ---------------------------------------------------------------------------

export type DomPoint = { node: Node; offset: number };

/**
 * Convert an editor Anchor into a (DOM node, offset) pair suitable for
 * `Range.setStart` / `Selection.collapse`. Returns null when the block can't
 * be found in the DOM (not yet rendered, virtualized off-screen, etc.).
 */
export function anchorToDom(
  anchor: Anchor,
  root: HTMLElement,
): DomPoint | null {
  const blockEl = findBlockElementById(root, anchor.blockId);
  if (!blockEl) return null;
  const kind = blockEl.getAttribute("data-block-kind") as BlockKind | null;
  if (!kind) return null;

  if (isTextBearingKind(kind)) {
    const charOffset = anchor.path[0] ?? 0;
    if (kind === "code") {
      return findCodePoint(blockEl, charOffset);
    }
    return findTextPoint(blockEl, charOffset);
  }

  if (kind === "table") {
    const r = anchor.path[0] ?? 0;
    const c = anchor.path[1] ?? 0;
    const charOffset = anchor.path[2] ?? 0;
    const td = blockEl.querySelector<HTMLElement>(
      `td[data-cell="${r}:${c}"]`,
    );
    if (!td) return null;
    return findTextPoint(td, charOffset);
  }

  if (kind === "columns") {
    const ci = anchor.path[0] ?? 0;
    const charOffset = anchor.path[1] ?? 0;
    const colEl = blockEl.querySelector<HTMLElement>(
      `[data-col="${ci}"]`,
    );
    if (!colEl) return null;
    return findTextPoint(colEl, charOffset);
  }

  if (kind === "img") {
    const side = anchor.path[0] === 1 ? 1 : 0;
    // Place the caret on a `data-side` marker if present, otherwise on the
    // block element at child-index = (imgIdx ± side).
    const marker = blockEl.querySelector<HTMLElement>(
      `[data-side="${side}"]`,
    );
    if (marker) return { node: marker, offset: 0 };
    const children = Array.from(blockEl.childNodes);
    const imgIdx = children.findIndex(
      (c) => c.nodeType === 1 && (c as HTMLElement).tagName.toLowerCase() === "img",
    );
    if (imgIdx < 0) return { node: blockEl, offset: 0 };
    return { node: blockEl, offset: side === 1 ? imgIdx + 1 : imgIdx };
  }

  return null;
}

/**
 * Walk the descendant text nodes of `scopeEl` (in document order) and find
 * the one that contains the `charOffset`-th visible character. ZWSP
 * placeholders count as 0. If the offset is past the end, return the last
 * text node at its end. If there is no text node, return (scopeEl, 0).
 */
function findTextPoint(
  scopeEl: HTMLElement,
  charOffset: number,
): DomPoint {
  let remaining = charOffset;
  let last: DomPoint | null = null;

  const walk = (node: Node): DomPoint | null => {
    if (node.nodeType === 3) {
      const text = node as Text;
      const data = text.data;
      const len = data === ZWSP ? 0 : data.length;
      if (remaining <= len) {
        return { node: text, offset: data === ZWSP ? 0 : remaining };
      }
      remaining -= len;
      last = { node: text, offset: data === ZWSP ? 0 : data.length };
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };

  const direct = walk(scopeEl);
  if (direct) return direct;
  if (last) return last;
  // Empty scope (no text nodes): collapse on the element itself.
  return { node: scopeEl, offset: 0 };
}

/**
 * Code-block flavor of `findTextPoint`. The model offset embeds `\n` between
 * lines; the DOM does not — walk lines and account for the implicit `\n`.
 */
function findCodePoint(
  blockEl: HTMLElement,
  charOffset: number,
): DomPoint {
  const lines = blockEl.querySelectorAll<HTMLElement>(".ce-code-line");
  if (lines.length === 0) return findTextPoint(blockEl, charOffset);
  let remaining = charOffset;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineLen = visibleTextLength(line);
    if (remaining <= lineLen) {
      return findTextPoint(line, remaining);
    }
    remaining -= lineLen;
    if (i < lines.length - 1) {
      if (remaining === 0) {
        // Boundary between lines — start of next line.
        return findTextPoint(lines[i + 1]!, 0);
      }
      remaining -= 1;
    }
  }
  // Past end — clamp to end of last line.
  const last = lines[lines.length - 1]!;
  return findTextPoint(last, visibleTextLength(last));
}
