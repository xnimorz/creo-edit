// ---------------------------------------------------------------------------
// Anchor codec registry — DOM ↔ Anchor mapping per block kind.
//
// Text-bearing blocks (p/h*/li/code) share a default codec that walks visible
// text by character offset; blocks with nested cells (table, columns, future
// custom containers) register their own. The default also handles the
// code-block special case (implicit \n at every line break).
//
// This module is the single seam that `dom/anchorMap.ts` reads from. The
// public `domToAnchor` / `anchorToDom` keep the same call signature; lookups
// switch from a hardcoded if/else on `kind` to a Map.
// ---------------------------------------------------------------------------

import type { AnchorCodec, DomPoint } from "./types";

const codecByType = new Map<string, AnchorCodec>();

export function registerAnchorCodec(type: string, codec: AnchorCodec): void {
  codecByType.set(type, codec);
}

export function getAnchorCodec(type: string): AnchorCodec | null {
  return codecByType.get(type) ?? null;
}

// ---------------------------------------------------------------------------
// Default text-bearing codec — walks visible chars under the block element.
// Plugins can register the same codec for their own text-bearing blocks
// (or omit anchorCodec entirely; the consumer falls back to this default).
// ---------------------------------------------------------------------------

const ZWSP = "​";

/**
 * Marker attribute on an inline widget's root. Everything in this module —
 * and therefore every consumer of the default text codec — treats a subtree
 * carrying it as if it were not in the DOM at all: it contributes no
 * characters to the offset walk, and the caret is never placed inside it.
 *
 * This is THE contract for inline widgets. A block that ships its own anchor
 * codec must honour it too, or widgets in that block will shift every anchor
 * after them on the line.
 */
export const INLINE_WIDGET_ATTR = "data-ce-inline-widget";

function isWidget(node: Node): boolean {
  return (
    node.nodeType === 1 &&
    (node as HTMLElement).hasAttribute?.(INLINE_WIDGET_ATTR) === true
  );
}

// The four walks below are the hottest functions in the library: they are on
// the anchor path, the IME composition path and the selection path, and a
// syntax-highlighting host runs them tens of thousands of times per repaint.
// All of them iterate `firstChild` / `nextSibling` rather than
// `Array.from(node.childNodes)` — same traversal, but without allocating an
// array per element visited.

/** Sum of text-node lengths inside `el`, treating ZWSP placeholders as 0 and
 *  skipping inline-widget subtrees. */
function visibleTextLength(el: HTMLElement): number {
  let n = 0;
  const walk = (node: Node): void => {
    if (isWidget(node)) return;
    if (node.nodeType === 3) {
      const t = (node as Text).data;
      if (t !== ZWSP) n += t.length;
      return;
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(el);
  return n;
}

/**
 * Visible text of `el` as the model sees it — ZWSP placeholders and inline
 * widgets removed. Used by the IME composition diff, which compares the DOM
 * against the model and would otherwise read a widget's text as a phantom
 * insertion.
 */
export function visibleTextOf(el: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    if (isWidget(node)) return;
    if (node.nodeType === 3) {
      const t = (node as Text).data;
      if (t !== ZWSP) out += t;
      return;
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(el);
  return out;
}

/**
 * Visible-character offset from start of `scopeEl` to (hitNode, localOffset).
 *
 * Hand-rolled rather than `Range.toString()` because the walk has to skip
 * inline-widget subtrees, and a Range has no way to exclude a sub-tree from
 * its own text.
 */
export function offsetWithinScope(
  scopeEl: HTMLElement,
  hitNode: Node,
  localOffset: number,
): number {
  if (!scopeEl.contains(hitNode) && hitNode !== scopeEl) {
    const cmp = scopeEl.compareDocumentPosition(hitNode);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return visibleTextLength(scopeEl);
    return 0;
  }
  let count = 0;
  let result = 0;
  let done = false;

  const visit = (node: Node): void => {
    if (done) return;
    if (isWidget(node)) {
      // A hit inside a widget resolves to the position just before it — the
      // caret can never sit "inside" zero-width content.
      if (node === hitNode || node.contains(hitNode)) {
        result = count;
        done = true;
      }
      return;
    }
    if (node.nodeType === 3) {
      const data = (node as Text).data;
      if (node === hitNode) {
        result =
          count + (data === ZWSP ? 0 : Math.min(Math.max(0, localOffset), data.length));
        done = true;
        return;
      }
      if (data !== ZWSP) count += data.length;
      return;
    }
    if (node === hitNode) {
      // Element hit: `localOffset` is a child index.
      const stop = Math.min(Math.max(0, localOffset), node.childNodes.length);
      let i = 0;
      for (let k = node.firstChild; k && i < stop; k = k.nextSibling, i++) {
        visit(k);
        if (done) return;
      }
      result = count;
      done = true;
      return;
    }
    for (let k = node.firstChild; k; k = k.nextSibling) {
      visit(k);
      if (done) return;
    }
  };

  visit(scopeEl);
  return done ? result : count;
}

/** Walk descendant text nodes to find the (node, offset) at `charOffset`,
 *  skipping inline-widget subtrees so the caret never lands inside one. */
export function findTextPoint(scopeEl: HTMLElement, charOffset: number): DomPoint {
  let remaining = charOffset;
  let last: DomPoint | null = null;
  const walk = (node: Node): DomPoint | null => {
    if (isWidget(node)) return null;
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
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  const direct = walk(scopeEl);
  if (direct) return direct;
  if (last) return last;
  return { node: scopeEl, offset: 0 };
}

/**
 * `findTextPoint` for many offsets at once, in ONE pass over `scopeEl`.
 *
 * `offsets` must be ascending. Resolving k offsets on the same line
 * separately re-walks that line's text nodes k times, and a tokenizer puts
 * ~12 endpoints on every line — so this is the difference between visiting a
 * line's nodes once per repaint and once per token. Results are positionally
 * aligned with `offsets`.
 */
export function findTextPoints(
  scopeEl: HTMLElement,
  offsets: readonly number[],
): DomPoint[] {
  const out: DomPoint[] = new Array(offsets.length);
  if (offsets.length === 0) return out;
  let i = 0; // next offset to satisfy
  let seen = 0; // visible chars consumed so far
  let last: DomPoint | null = null;

  const walk = (node: Node): void => {
    if (i >= offsets.length) return;
    if (isWidget(node)) return;
    if (node.nodeType === 3) {
      const text = node as Text;
      const data = text.data;
      const len = data === ZWSP ? 0 : data.length;
      // Every offset landing inside this node (or exactly at its end) is
      // answered before moving on — the cursor never goes backwards.
      while (i < offsets.length && offsets[i]! - seen <= len) {
        const local = offsets[i]! - seen;
        out[i] = { node: text, offset: data === ZWSP ? 0 : local };
        i++;
      }
      seen += len;
      last = { node: text, offset: data === ZWSP ? 0 : data.length };
      return;
    }
    for (let c = node.firstChild; c && i < offsets.length; c = c.nextSibling) {
      walk(c);
    }
  };
  walk(scopeEl);

  // Offsets past the end of the scope clamp to its last text position, which
  // is what the single-offset walk does too.
  const tail: DomPoint = last ?? { node: scopeEl, offset: 0 };
  for (; i < offsets.length; i++) out[i] = tail;
  return out;
}

/** Default codec — text-bearing blocks land here when they don't register
 *  their own. Path encoding: [charOffset]. */
export const defaultTextCodec: AnchorCodec = {
  domToAnchor(blockEl, hit, off) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    const charOff = offsetWithinScope(blockEl, hit, off);
    return { blockId, path: [charOff], offset: charOff };
  },
  anchorToDom(blockEl, a) {
    const charOff = a.path[0] ?? 0;
    return findTextPoint(blockEl, charOff);
  },
  anchorsToDom(blockEl, anchors) {
    const out: (DomPoint | null)[] = new Array(anchors.length);
    if (anchors.length === 0) return out;
    const idx = anchors.map((_a, i) => i);
    const offs = anchors.map((a) => Math.max(0, a.path[0] ?? 0));
    idx.sort((x, y) => offs[x]! - offs[y]!);
    const points = findTextPoints(blockEl, idx.map((i) => offs[i]!));
    for (let k = 0; k < idx.length; k++) out[idx[k]!] = points[k]!;
    return out;
  },
  domScope(blockEl, _a) {
    return blockEl;
  },
};

// Code-block flavor — model treats `\n` as a real char at end of every
// non-last line, but the DOM uses one <div class="ce-code-line"> per line
// with no actual `\n` text.
//
// Resolving an anchor therefore means finding the line that owns a character
// offset. Done by walking lines from zero and summing their lengths, that is
// O(lines) DOM subtree walks per anchor — and a syntax-highlighting host
// resolves two anchors per token range, thousands of times per repaint, which
// makes the repaint quadratic in file size.
//
// So `CodeBlockView` publishes each line's model start offset as
// `data-line-start` (it computed the split anyway, the prefix sum is free) and
// the codec binary-searches it: O(log lines) to find the line, then one walk
// of that line alone. `domToAnchor` is the mirror — walk up to the owning
// line and read the same attribute instead of re-summing everything above it.
//
// The attribute is additive: a host rendering its own code-block view without
// it still resolves correctly, through the original linear walk below.

/** Model start offset published on each `.ce-code-line` by `CodeBlockView`. */
export const LINE_START_ATTR = "data-line-start";

const CODE_LINE_CLASS = "ce-code-line";

function isCodeLine(node: Node | null | undefined): node is HTMLElement {
  return (
    !!node &&
    node.nodeType === 1 &&
    (node as HTMLElement).classList?.contains(CODE_LINE_CLASS) === true
  );
}

/** The line's declared model start, or null when this isn't an annotated
 *  line — which sends the caller down the linear fallback. */
export function declaredLineStart(node: Node | null | undefined): number | null {
  if (!isCodeLine(node)) return null;
  const raw = node.getAttribute(LINE_START_ATTR);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Last line element whose declared start is <= `offset`.
 *
 * `undefined` means "these children aren't uniformly annotated lines" — the
 * caller falls back to the linear walk rather than trusting a partial index.
 *
 * The binary search only probes O(log n) children, so it would happily run to
 * completion over a child list that has non-line elements in it (spacers, a
 * host's own chrome) and return a confidently wrong answer. Checking both ends
 * first makes "every child is an annotated line" a precondition that is
 * actually tested rather than assumed, for two extra attribute reads.
 */
function lineAtOffset(
  blockEl: HTMLElement,
  offset: number,
): { el: HTMLElement; start: number } | undefined {
  const kids = blockEl.children;
  if (kids.length === 0) return undefined;
  if (declaredLineStart(kids[0]) === null) return undefined;
  if (declaredLineStart(kids[kids.length - 1]) === null) return undefined;
  let lo = 0;
  let hi = kids.length - 1;
  let best: { el: HTMLElement; start: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const el = kids[mid];
    const start = declaredLineStart(el);
    if (start === null) return undefined;
    if (start <= offset) {
      best = { el: el as HTMLElement, start };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // First line always declares 0, so a non-negative offset always lands.
  return best ?? undefined;
}

export const codeBlockCodec: AnchorCodec = {
  domToAnchor(blockEl, hit, off) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    // Fast path: the hit is inside an annotated line, so its start offset is
    // one attribute read away.
    let cur: Node | null = hit;
    while (cur && cur !== blockEl) {
      if (isCodeLine(cur)) {
        const start = declaredLineStart(cur);
        if (start !== null) {
          const inLine = start + offsetWithinScope(cur, hit, off);
          return { blockId, path: [inLine], offset: inLine };
        }
        break;
      }
      cur = cur.parentNode;
    }
    const lines = blockEl.querySelectorAll<HTMLElement>(`.${CODE_LINE_CLASS}`);
    if (lines.length === 0) {
      const charOff = offsetWithinScope(blockEl, hit, off);
      return { blockId, path: [charOff], offset: charOff };
    }
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === hit || line.contains(hit)) {
        const inLine = total + offsetWithinScope(line, hit, off);
        return { blockId, path: [inLine], offset: inLine };
      }
      total += visibleTextLength(line);
      if (i < lines.length - 1) total += 1;
    }
    return { blockId, path: [total], offset: total };
  },
  anchorToDom(blockEl, a) {
    const charOffset = Math.max(0, a.path[0] ?? 0);
    const found = lineAtOffset(blockEl, charOffset);
    // `findTextPoint` clamps past the end of the line, which is exactly the
    // right answer for the offset of the newline that terminates it.
    if (found) return findTextPoint(found.el, charOffset - found.start);
    const lines = blockEl.querySelectorAll<HTMLElement>(`.${CODE_LINE_CLASS}`);
    if (lines.length === 0) return findTextPoint(blockEl, charOffset);
    let remaining = charOffset;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineLen = visibleTextLength(line);
      if (remaining <= lineLen) return findTextPoint(line, remaining);
      remaining -= lineLen + 1;
    }
    const last = lines[lines.length - 1]!;
    return findTextPoint(last, visibleTextLength(last));
  },
  anchorsToDom(blockEl, anchors) {
    const out: (DomPoint | null)[] = new Array(anchors.length).fill(null);
    if (anchors.length === 0) return out;
    // Order the batch by offset so one forward pass over the lines answers
    // all of it, then group runs of offsets that share a line and hand each
    // group to `findTextPoints` — one walk per line rather than per anchor.
    const idx = anchors.map((_a, i) => i);
    const offs = anchors.map((a) => Math.max(0, a.path[0] ?? 0));
    idx.sort((x, y) => offs[x]! - offs[y]!);

    let i = 0;
    while (i < idx.length) {
      const found = lineAtOffset(blockEl, offs[idx[i]!]!);
      if (!found) {
        // Not an annotated line list (a host's own code view, or a partially
        // rendered one) — fall back to the single-anchor path for the rest.
        for (; i < idx.length; i++) {
          out[idx[i]!] = codeBlockCodec.anchorToDom(blockEl, anchors[idx[i]!]!);
        }
        break;
      }
      // `lineEnd` is the next line's start; the last line has no successor,
      // so everything left belongs to it.
      const nextStart = declaredLineStart(found.el.nextElementSibling);
      let j = i;
      const local: number[] = [];
      while (
        j < idx.length &&
        (nextStart === null || offs[idx[j]!]! < nextStart)
      ) {
        local.push(offs[idx[j]!]! - found.start);
        j++;
      }
      const points = findTextPoints(found.el, local);
      for (let k = 0; k < points.length; k++) out[idx[i + k]!] = points[k]!;
      i = j;
    }
    return out;
  },
  domScope(blockEl, _a) {
    return blockEl;
  },
};

// Generic atomic-block codec — used by any non-editable block whose only
// valid caret positions are "before" (side 0) and "after" (side 1). The
// block view should render `contenteditable="false"` so the browser places
// the native caret around the block, not inside.
//
// Plugins can mark explicit before/after slots with sentinel elements
// (`<span data-side="0">`/`<span data-side="1">`) — useful when you need
// the browser to land the caret at a precise visual position, e.g. on a
// new line below the block. When no sentinels are present we fall back to
// "first half / second half" of the block bounds: hits where the offset is
// past the midpoint of the block element become side 1, otherwise side 0.
export const atomicCodec: AnchorCodec = {
  domToAnchor(blockEl, node, offset) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    let side: 0 | 1 = 0;
    // Walk up from the hit looking for an explicit data-side marker.
    let cur: Node | null = node;
    while (cur && cur !== blockEl) {
      if (cur.nodeType === 1) {
        const el = cur as HTMLElement;
        const sideAttr = el.getAttribute("data-side");
        if (sideAttr === "0" || sideAttr === "1") {
          side = sideAttr === "1" ? 1 : 0;
          return { blockId, path: [side], offset: side };
        }
      }
      cur = cur.parentNode;
    }
    // Fallback: compare against block's child count midpoint when the hit
    // is the block element itself, or sniff by getBoundingClientRect for
    // hits inside child content (rare under contenteditable=false).
    if (node === blockEl) {
      const childCount = blockEl.childNodes.length;
      side = offset >= Math.ceil(childCount / 2) ? 1 : 0;
    } else {
      // For hits inside the block, side is decided by which half of the
      // block bounds the hit-node sits in. This handles cases where the
      // browser places the selection on a child element.
      try {
        const blockRect = blockEl.getBoundingClientRect();
        const targetEl =
          node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
        if (targetEl) {
          const r = targetEl.getBoundingClientRect();
          const midY = blockRect.top + blockRect.height / 2;
          side = r.top + r.height / 2 >= midY ? 1 : 0;
        }
      } catch {
        // happy-dom / non-laid-out nodes — leave side at 0.
      }
    }
    return { blockId, path: [side], offset: side };
  },
  anchorToDom(blockEl, a) {
    const side = a.path[0] === 1 ? 1 : 0;
    const marker = blockEl.querySelector<HTMLElement>(`[data-side="${side}"]`);
    if (marker) return { node: marker, offset: 0 };
    // Fallback: anchor outside the block (parent before/after the block).
    // Putting the caret on `blockEl` itself with offset 0/childCount is
    // less reliable because contenteditable=false blocks the caret from
    // landing there in some browsers.
    const parent = blockEl.parentNode;
    if (parent) {
      const idx = Array.from(parent.childNodes).indexOf(blockEl);
      if (idx >= 0) return { node: parent, offset: side === 0 ? idx : idx + 1 };
    }
    return { node: blockEl, offset: side === 1 ? blockEl.childNodes.length : 0 };
  },
  domScope(blockEl, _a) {
    return blockEl;
  },
};

// Image codec — the caret only has two valid positions: side 0 (before)
// or side 1 (after). The block element is contenteditable=false, so the
// browser already declines to put the caret inside it.
//
// Kept as a separate export (instead of dropping into atomicCodec) because
// ImageView doesn't emit data-side sentinels — the codec falls back to the
// `<img>` tag's index in the block's child list.
export const imageCodec: AnchorCodec = {
  domToAnchor(blockEl, node, offset) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    let side: 0 | 1 = 0;
    if (node === blockEl) {
      const children = Array.from(blockEl.childNodes);
      const imgIdx = children.findIndex(
        (c) =>
          c.nodeType === 1 &&
          (c as HTMLElement).tagName.toLowerCase() === "img",
      );
      side = imgIdx >= 0 && offset > imgIdx ? 1 : 0;
    } else {
      let cur: Node | null = node;
      while (cur && cur !== blockEl) {
        if (cur.nodeType === 1) {
          const el = cur as HTMLElement;
          const sideAttr = el.getAttribute("data-side");
          if (sideAttr === "0" || sideAttr === "1") {
            side = sideAttr === "1" ? 1 : 0;
            break;
          }
          if (el.tagName.toLowerCase() === "img") {
            side = 0;
            break;
          }
        }
        cur = cur.parentNode;
      }
    }
    return { blockId, path: [side], offset: side };
  },
  anchorToDom(blockEl, a) {
    const side = a.path[0] === 1 ? 1 : 0;
    const marker = blockEl.querySelector<HTMLElement>(`[data-side="${side}"]`);
    if (marker) return { node: marker, offset: 0 };
    const children = Array.from(blockEl.childNodes);
    const imgIdx = children.findIndex(
      (c) =>
        c.nodeType === 1 && (c as HTMLElement).tagName.toLowerCase() === "img",
    );
    if (imgIdx < 0) return { node: blockEl, offset: 0 };
    return { node: blockEl, offset: side === 1 ? imgIdx + 1 : imgIdx };
  },
  domScope(blockEl, _a) {
    return blockEl;
  },
};

// ---------------------------------------------------------------------------
// findOwningBlockEl — hoisted here so the registry-driven anchorMap can
// share the same walk that the table / columns codecs use.
// ---------------------------------------------------------------------------

export function findOwningBlockEl(node: Node): HTMLElement | null {
  let cur: Node | null = node;
  while (cur && cur.nodeType !== 1) cur = cur.parentNode;
  while (cur && cur.nodeType === 1) {
    const el = cur as HTMLElement;
    if (el.hasAttribute("data-block-kind")) return el;
    cur = el.parentElement;
  }
  return null;
}

/** Pluggable anchor → which is just looking up the registered codec.
 *  Centralized here so anchorMap.ts and other consumers share one path. */
export function lookupAnchorCodec(kind: string): AnchorCodec | null {
  return getAnchorCodec(kind);
}

// Re-export for external/internal types that used to import DomPoint from
// dom/anchorMap directly.
export type { DomPoint };
