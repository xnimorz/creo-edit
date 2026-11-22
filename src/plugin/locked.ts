import type { Block } from "../model/types";

const byType = new Map<string, (b: Block) => boolean>();

export function registerLocked(type: string, fn: (b: Block) => boolean): void {
  byType.set(type, fn);
}

/** The block's `locked` flag, or its type's `BlockDef.locked`. */
export function isLockedBlock(b: Block): boolean {
  if (b.locked === true) return true;
  return byType.get(b.type)?.(b) === true;
}

/**
 * Attributes for a block view's outer element: a locked block is not
 * editable text to the browser, so neither typing nor an IME composition
 * can reach its DOM. Spread into the element's props.
 */
export function lockedAttrs(b: Block): { contenteditable?: "false"; "data-locked"?: "true" } {
  return isLockedBlock(b) ? { contenteditable: "false", "data-locked": "true" } : {};
}
