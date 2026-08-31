// ---------------------------------------------------------------------------
// Mark set — the inline formatting carried on an `InlineRun`.
//
// A mark is a NAME plus optional ATTRS. `"b"` / `"i"` / `"u"` / `"s"` /
// `"code"` are boolean marks and carry `null`; `"link"` carries
// `{ href, title? }`. The container is a `ReadonlyMap<MarkName, MarkAttrs>`
// rather than a `Set<string>` precisely so a mark can carry data — a set of
// strings has nowhere to put an href, and encoding one into the key makes
// every lookup a scan.
//
// Everything in here is pure and allocation-light: `marksEqual` is called
// once per adjacent run pair by `normalizeRuns`, which runs on every
// keystroke, so it early-outs on identity and size before comparing entries.
// ---------------------------------------------------------------------------

import type { MarkAttrs, MarkName, MarkSet } from "./types";

/** The empty mark set. Shared — never mutate. */
export const NO_MARKS: MarkSet = new Map<MarkName, MarkAttrs>();

/** Build a mark set from names (all attr-less) or [name, attrs] entries. */
export function marksOf(
  entries: readonly (MarkName | readonly [MarkName, MarkAttrs])[],
): MarkSet {
  const m = new Map<MarkName, MarkAttrs>();
  for (const e of entries) {
    if (typeof e === "string") m.set(e, null);
    else m.set(e[0], e[1]);
  }
  return m;
}

export function hasMark(marks: MarkSet | undefined, name: MarkName): boolean {
  return marks != null && marks.has(name);
}

/** Attrs for `name`, or `undefined` when the mark isn't present. `null` is a
 *  present-but-attr-less mark, so callers must distinguish the two. */
export function markAttrs(
  marks: MarkSet | undefined,
  name: MarkName,
): MarkAttrs | undefined {
  return marks?.get(name);
}

/** Convenience for the built-in link mark. */
export function linkHref(marks: MarkSet | undefined): string | null {
  const a = marks?.get("link");
  if (a && typeof (a as { href?: unknown }).href === "string") {
    return (a as { href: string }).href;
  }
  return null;
}

/** A copy of `marks` with `name` set to `attrs`. */
export function withMark(
  marks: MarkSet | undefined,
  name: MarkName,
  attrs: MarkAttrs = null,
): MarkSet {
  const next = new Map(marks ?? NO_MARKS);
  next.set(name, attrs);
  return next;
}

/** A copy of `marks` without `name`. Returns the input when absent. */
export function withoutMark(
  marks: MarkSet | undefined,
  name: MarkName,
): MarkSet {
  if (!marks || !marks.has(name)) return marks ?? NO_MARKS;
  const next = new Map(marks);
  next.delete(name);
  return next;
}

/**
 * Shallow structural equality for mark attrs. Values are compared with
 * `===`, which is exact for the string/number/boolean payloads marks
 * actually carry (`href`, `title`, a comment id). A mark whose attrs nest
 * objects should either flatten them or supply a stable identity.
 */
export function attrsEqual(a: MarkAttrs, b: MarkAttrs): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Whether two runs carry the same marks with the same attrs. */
export function marksEqual(
  a: MarkSet | undefined,
  b: MarkSet | undefined,
): boolean {
  if (a === b) return true;
  const an = a ? a.size : 0;
  const bn = b ? b.size : 0;
  if (an !== bn) return false;
  if (an === 0) return true;
  for (const [name, attrs] of a!) {
    if (!b!.has(name)) return false;
    if (!attrsEqual(attrs, b!.get(name)!)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Wire form
// ---------------------------------------------------------------------------

/**
 * Serialized marks. The current form is an object keyed by mark name whose
 * value is the mark's attrs (`null` for boolean marks). The legacy
 * `string[]` form — every mark boolean — is still accepted on read so
 * documents saved before marks carried data load unchanged.
 */
export type SerializedMarks = Record<string, unknown> | string[];

export function serializeMarks(
  marks: MarkSet | undefined,
): Record<string, unknown> | undefined {
  if (!marks || marks.size === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, attrs] of marks) out[name] = attrs ?? null;
  return out;
}

export function deserializeMarks(s: unknown): MarkSet | undefined {
  if (s == null) return undefined;
  const m = new Map<MarkName, MarkAttrs>();
  if (Array.isArray(s)) {
    // Legacy: ["b", "i"].
    for (const name of s) {
      if (typeof name === "string" && name.length > 0) m.set(name, null);
    }
  } else if (typeof s === "object") {
    for (const [name, attrs] of Object.entries(s as Record<string, unknown>)) {
      if (name.length === 0) continue;
      m.set(
        name,
        attrs != null && typeof attrs === "object" && !Array.isArray(attrs)
          ? (attrs as Record<string, unknown>)
          : null,
      );
    }
  } else {
    return undefined;
  }
  return m.size === 0 ? undefined : m;
}
