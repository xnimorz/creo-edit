// ---------------------------------------------------------------------------
// embedPlugin — an atomic block whose inside belongs to the host.
//
// The editor draws one non-editable shell per block and hands it to `mount`;
// what goes in it (an iframe, a chart, a widget with its own controls) is the
// host's, built with plain DOM. The shell declares no children, so the
// renderer leaves what `mount` appended alone — the pattern the mermaid
// plugin established. The editor never sandboxes: a host putting untrusted
// content in an embed decides how (an iframe on another origin, a sandbox).
// ---------------------------------------------------------------------------

import { div, view, type RefObject } from "creo";
import { closestEditor } from "../../dom/editorRef";
import { isolateInput } from "../../input/isolate";
import { lockedAttrs } from "../../plugin/locked";
import type { Editor } from "../../createEditor";
import type { MarkdownBlockCodec } from "../../markdown/blockCodec";
import type { Block, BlockId, BlockSpec } from "../../model/types";
import type { BlockDef, EditorPlugin, HtmlBlockCodec, SerializeCodec } from "../../plugin/types";

export type EmbedContext = {
  /** The editor the block is drawn in; null if the shell is not under one. */
  editor: Editor | null;
  /** Whether the selection covers the block whole. */
  selected: boolean;
};

/** What `mount` hands back: how to follow the block, and how to let go. */
export type EmbedInstance = {
  /** The block changed (a new object for the same id), or its selection did. */
  update?(block: Block, ctx: EmbedContext): void;
  destroy?(): void;
};

export type EmbedDef = {
  type: string;
  /** Build the block's inside in `shell`. Runs when the block is mounted,
   *  again after it is unmounted (scrolled out of a virtualized window). */
  mount(block: Block, shell: HTMLElement, ctx: EmbedContext): EmbedInstance | void;
  /** Extra classes on the shell, after `ce-block ce-embed`. */
  className?: string;
  /** JSON round-trip. Default: every field of the block but its index. */
  serializeCodec?: SerializeCodec;
  htmlCodec?: HtmlBlockCodec;
  markdownCodec?: MarkdownBlockCodec;
  plainText?(block: Block): string;
  locked?(block: Block): boolean;
  /**
   * Stop the shell's input events reaching the editor (`isolateInput`), for
   * an embed with its own fields. Default true; an embed holding only an
   * iframe needs nothing, since a frame's events never reach the page.
   */
  isolate?: boolean;
};

const defaultCodec: SerializeCodec = {
  serialize(b: Block): unknown {
    const { index: _index, ...rest } = b as Block & { index: unknown };
    return rest;
  },
  deserialize(s: unknown, id: BlockId): BlockSpec {
    return { ...(s as object), id } as BlockSpec;
  },
};

function shellView(def: EmbedDef) {
  return view<{ block: Block; selected?: boolean }>(({ props }) => {
    const shell: RefObject<HTMLElement> = { current: null };
    let instance: EmbedInstance | null = null;
    let release: (() => void) | null = null;
    const ctx = (): EmbedContext => ({
      editor: closestEditor(shell.current),
      selected: props().selected === true,
    });

    return {
      shouldUpdate(next) {
        return next.block !== props().block || next.selected !== props().selected;
      },
      render() {
        const { block, selected } = props();
        div({
          "data-block-id": block.id,
          "data-block-kind": def.type,
          contenteditable: "false",
          class: `ce-block ce-embed${def.className ? ` ${def.className}` : ""}`,
          "data-selected": selected ? "true" : undefined,
          ...lockedAttrs(block),
          ref: shell,
        });
      },
      onMount() {
        const el = shell.current;
        if (!el || instance) return;
        if (def.isolate !== false) release = isolateInput(el);
        instance = def.mount(props().block, el, ctx()) ?? {};
      },
      onUpdateAfter() {
        instance?.update?.(props().block, ctx());
      },
      dispose() {
        instance?.destroy?.();
        instance = null;
        release?.();
        release = null;
      },
    };
  });
}

/**
 * An atomic block type whose inside the host draws. The caret goes around
 * it, never in it; Backspace or Delete next to it selects it first (and the
 * shell carries `data-selected` while it is), then deletes it.
 */
export function embedPlugin(def: EmbedDef): EditorPlugin {
  const block: BlockDef = {
    type: def.type as Block["type"],
    view: shellView(def) as never,
    isAtomic: true,
    serializeCodec: def.serializeCodec ?? defaultCodec,
    ...(def.htmlCodec ? { htmlCodec: def.htmlCodec } : {}),
    ...(def.markdownCodec ? { markdownCodec: def.markdownCodec } : {}),
    ...(def.plainText ? { plainText: def.plainText } : {}),
    ...(def.locked ? { locked: def.locked } : {}),
  };
  return { name: `embed:${def.type}`, blocks: [block] };
}
