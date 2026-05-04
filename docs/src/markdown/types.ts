import type { SerializedDoc } from "creo-editor";

export type DocMeta = { title: string; slug: string };
export type DocHeading = { level: number; text: string; slug: string };

// Each compiled doc page carries:
// - meta:     title + slug (for nav, page title, etc.)
// - doc:      the SerializedDoc loaded into the editor on the page
// - headings: ordered list of headings as they appear in the source. Used
//             both for the right-hand TOC and to assign DOM ids to the
//             editor's rendered <h*> tags so anchor links resolve.
export type CompiledDoc = {
  meta: DocMeta;
  doc: SerializedDoc;
  headings: DocHeading[];
};
