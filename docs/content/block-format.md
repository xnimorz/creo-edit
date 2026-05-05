---
title: "Block format"
slug: "block-format"
---

# Block format

A document is a flat list of blocks. You provide it through `setDoc()` or as the `initial` option, and read it back via `toJSON()`. Each block has:

- `type` — discriminator: `"p"`, `"h1"`–`"h6"`, `"li"`, `"code"`, `"img"`, `"table"`, `"columns"`, or any plugin-registered type.
- `id` — *optional on input, always present on output*. Stable identity across `setDoc()` calls — see "Reordering rows" below.
- Per-type fields (`runs`, `cells`, `src`, etc.).

## The id field

Pass the same `id` for the same logical block across calls and the editor preserves block identity: caret stays put, scroll position stays put, render reconciliation skips the block. Omit `id` and the editor allocates a fresh one — useful for blocks the host app doesn't otherwise track.

```ts
const blocks = [
  { id: "intro", type: "h1", runs: [{ text: "Hello" }] },
  { id: "body",  type: "p",  runs: [{ text: "World" }] },
];
editor.setDoc({ blocks });
```

## Reordering rows

The simplest way to move a block is to reorder the array while keeping the same `id` for each block:

```ts
const reordered = [blocks[1], blocks[0]]; // swap intro/body
editor.setDoc({ blocks: reordered });
```

Because the ids are stable, the renderer treats this as a reorder, not a delete-plus-insert — internal fractional indices are recomputed to match the new order, and any decoration plugin (drag handles, etc.) sees the same blocks in their new position.

## Block reference

### Paragraph (`p`)

```ts
{ id?, type: "p", runs: SerializedRun[] }
```

### Headings (`h1`–`h6`)

```ts
{ id?, type: "h1" | ... | "h6", runs: SerializedRun[] }
```

### List item (`li`)

```ts
{
  id?,
  type: "li",
  ordered: boolean,
  depth?: 0 | 1 | 2 | 3,
  runs: SerializedRun[],
}
```

The renderer groups consecutive `li` blocks of the same `ordered` flag into a single `<ul>` or `<ol>`.

### Code (`code`)

```ts
{ id?, type: "code", runs: SerializedRun[], lang?: string }
```

A multi-line region. Newlines are stored as literal `\n` characters inside `runs[].text`; Enter inside a code block inserts a newline rather than splitting the block.

### Image (`img`)

```ts
{ id?, type: "img", src: string, alt?: string, width?: number, height?: number }
```

### Table (`table`)

```ts
{
  id?,
  type: "table",
  rows: number,
  cols: number,
  cells: SerializedRun[][][], // cells[row][col] = inline runs
}
```

### Columns (`columns`)

```ts
{
  id?,
  type: "columns",
  cols: number,
  cells: SerializedRun[][], // cells[colIndex] = inline runs
}
```

## Inline runs

```ts
type SerializedRun = {
  text: string;
  marks?: ("b" | "i" | "u" | "s" | "code")[];
};
```

A block's text is an array of contiguous runs. Adjacent runs with the same `marks` set are equivalent to a single combined run; you don't need to merge them yourself.

## Plugin block types

Plugins can register their own block types via `BlockDef.serializeCodec`. The wire shape can be anything serializable — when reading back via `toJSON()`, the plugin's `serialize` decides what fields appear. Hosts that store docs to a backend should be aware that the set of valid `type` strings expands with the plugin set the editor was constructed with.
