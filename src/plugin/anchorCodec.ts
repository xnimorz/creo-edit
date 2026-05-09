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

import type { Anchor } from "../model/types";
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

/** Sum of text-node lengths inside `el`, treating ZWSP placeholders as 0. */
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

/** Visible-character offset from start of `scopeEl` to (hitNode, localOffset). */
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

/** Walk descendant text nodes to find the (node, offset) at `charOffset`. */
export function findTextPoint(scopeEl: HTMLElement, charOffset: number): DomPoint {
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
  return { node: scopeEl, offset: 0 };
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
  domScope(blockEl, _a) {
    return blockEl;
  },
};

// Code-block flavor — model treats `\n` as a real char at end of every
// non-last line, but the DOM uses one <div class="ce-code-line"> per line
// with no actual `\n` text. Walk lines manually + add 1 per implicit \n.
export const codeBlockCodec: AnchorCodec = {
  domToAnchor(blockEl, hit, off) {
    const blockId = blockEl.getAttribute("data-block-id");
    if (!blockId) return null;
    const lines = blockEl.querySelectorAll<HTMLElement>(".ce-code-line");
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
    const lines = blockEl.querySelectorAll<HTMLElement>(".ce-code-line");
    const charOffset = a.path[0] ?? 0;
    if (lines.length === 0) return findTextPoint(blockEl, charOffset);
    let remaining = charOffset;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineLen = visibleTextLength(line);
      if (remaining <= lineLen) return findTextPoint(line, remaining);
      remaining -= lineLen;
      if (i < lines.length - 1) {
        if (remaining === 0) return findTextPoint(lines[i + 1]!, 0);
        remaining -= 1;
      }
    }
    const last = lines[lines.length - 1]!;
    return findTextPoint(last, visibleTextLength(last));
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
