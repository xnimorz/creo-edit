import type { Block } from "../model/types";

const byType = new Map<string, (b: Block) => string>();

export function registerPlainText(type: string, fn: (b: Block) => string): void {
  byType.set(type, fn);
}

export function lookupPlainText(type: string): ((b: Block) => string) | null {
  return byType.get(type) ?? null;
}
