// ---------------------------------------------------------------------------
// Native (contentEditable) input pipeline
//
// The contentEditable approach uses the browser's native selection + IME,
// while keeping the editor in full control of mutations: every `beforeinput`
// event is preventDefaulted and translated into an editor command. The browser
// is allowed to write to the DOM only during IME composition, which is
// reconciled against the model on `compositionend`.
// ---------------------------------------------------------------------------

import type { Store } from "creo";
import type {
  Anchor,
  DocState,
  Selection,
  Mark,
} from "../model/types";
import type { DispatchableCommand } from "../createEditor";
import { caret as caretSel, range as rangeSel } from "../controller/selection";
import { matchKeymap } from "./keymap";
import { anchorToDom, domToAnchor, findBlockElementById } from "../dom/anchorMap";
import { parseHTML, parsePlainText } from "../clipboard/htmlParser";
import { selectionToClipboard } from "../clipboard/htmlSerializer";
import { insertBlocks } from "../commands/insertCommands";
import {
  insertImageFiles,
  type UploadFn,
} from "../commands/imageCommands";
import { deleteSelectedAtomic } from "../commands/imageCommands";
import { isAtomicBlockType } from "../plugin/atomic";
import { lookupAnchorCodec, visibleTextOf } from "../plugin/anchorCodec";
import { runsLengthAt } from "../plugin/runsAt";
import { matchPluginKeymap } from "../plugin/keymapMatch";
import type { Registry } from "../plugin/registry";
import type { CommandCtx } from "../plugin/types";
import type { TriggerManager } from "../plugin/triggers";

/**
 * Schedule `cb` after the current render flush. Production: requestAnimationFrame
 * runs after Creo's microtask scheduler. Test (happy-dom): rAF isn't exposed
 * as a global; queueMicrotask is the closest equivalent and runs in the same
 * tick so we don't lose timing.
 */
const scheduleAfterRender = (cb: () => void): void => {
  if (typeof requestAnimationFrame !== "undefined") {
    requestAnimationFrame(cb);
  } else {
    queueMicrotask(cb);
  }
};

export type NativeInputStores = {
  docStore: Store<DocState>;
  selStore: Store<Selection>;
};

export type NativeInputOptions = {
  dispatch: (cmd: DispatchableCommand) => boolean;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  /** Optional upload hook for pasted / dropped image files. */
  uploadImage?: UploadFn;
  /** Plugin registry — keymap matching, command dispatch for plugin chords. */
  registry: Registry;
  /** The editor's command context — handed to plugin keymap predicates and
   *  commands so they get `dispatch` / `change` / `editor`, not just stores. */
  commandCtx: CommandCtx;
  /** Plugin paste hooks, in registration order. The first one returning true
   *  claims the event and the built-in clipboard path is skipped. */
  onPaste?: (e: ClipboardEvent) => boolean;
  /** Trigger manager — watches text insertion + key events for plugin
   *  triggers (slash commands, mentions, etc.). */
  triggers: TriggerManager;
  /**
   * Whether the document currently accepts input. Re-read (never cached) so
   * a host thunk can flip without recreating the editor. Defaults to always
   * editable when omitted.
   */
  isEditable?: () => boolean;
};

export type NativeInputHandle = {
  destroy: () => void;
  /** Re-read `isEditable()` and reflect it onto the root's contenteditable
   *  attribute. Called by `editor.setEditable`, and on focus / pointerdown so
   *  a thunk-driven flip lands before the user can type. */
  syncEditable: () => void;
};

// ---------------------------------------------------------------------------
// Selection sync — bidirectional
//
// We use a sequence number rather than a boolean "suppressing" flag because
// selectionchange fires asynchronously after a programmatic write; a boolean
// would race with subsequent user-driven changes.
// ---------------------------------------------------------------------------

export function attachNativeInput(
  root: HTMLElement,
  stores: NativeInputStores,
  options: NativeInputOptions,
): NativeInputHandle {
  const { docStore, selStore } = stores;

  // Read-only support. `contenteditable` reflects `isEditable()`, but the
  // attribute alone is not enough — `dispatch()` is public, so the command
  // dispatcher gates too (see createEditor). Here we only stop the browser
  // from originating edits.
  const isEditable = (): boolean => options.isEditable?.() !== false;

  // Pasted images insert through the dispatcher once their upload settles —
  // and not at all if this handle was torn down in the meantime.
  let attached = true;
  const imageTarget = {
    dispatch: options.dispatch,
    isLive: (): boolean => attached,
  };

  const syncEditable = (): void => {
    root.setAttribute("contenteditable", isEditable() ? "true" : "false");
  };

  // Make the root editable. Browser default = false, so we set it explicitly.
  // We also set spellcheck off for now — can be exposed as an option later.
  syncEditable();
  root.setAttribute("spellcheck", "false");
  // A thunk-valued `editable` can change without telling us. Re-sync on the
  // events that precede any possible edit, so the attribute is never stale
  // by the time a keystroke arrives.
  root.addEventListener("focusin", syncEditable);
  root.addEventListener("pointerdown", syncEditable, true);

  // -------------------------------------------------------------------------
  // Selection sync: native ↔ Anchor
  //
  // Two coordination devices keep the loop free of feedback bugs:
  //
  //   1. `programmaticSeq` / `lastObservedSeq` — a sequence-number guard.
  //      Every programmatic write to native selection bumps `programmaticSeq`;
  //      the next selectionchange event is the echo of that write and is
  //      ignored (we advance `lastObservedSeq` to match). User-driven
  //      changes (where seqs already match) are forwarded to selStore.
  //
  //   2. `renderPending` — a render-window flag. When the renderer replaces
  //      text nodes for a mutated block, native selection collapses onto
  //      detached nodes and the browser fires a SECOND selectionchange that
  //      would otherwise corrupt selStore (typing one char would jump the
  //      caret to start of doc). On every docStore change we set the flag,
  //      and clear it in the next rAF after re-applying native selection
  //      from the (correct) selStore. selectionchange events that fire
  //      while pending are dropped.
  // -------------------------------------------------------------------------

  let programmaticSeq = 0;
  let lastObservedSeq = 0;
  let renderPending = false;

  // -------------------------------------------------------------------------
  // IME composition state (Phase 3)
  //
  // During an active composition, the browser writes intermediate (and final)
  // text directly into the DOM. The model is held frozen until compositionend,
  // at which point we diff the affected scope's textContent against the
  // pre-composition snapshot and dispatch a single `insertText` command — this
  // keeps the entire composition under a single undo step and preserves marks
  // outside the composition range automatically.
  // -------------------------------------------------------------------------

  let composing = false;
  let compositionSnapshot: {
    anchor: Anchor;
    /** Text length of the relevant scope (block / table cell / column cell). */
    preLength: number;
  } | null = null;

  /** Convert the current native selection to an editor Selection. */
  const readNativeSelection = (): Selection | null => {
    const native = document.getSelection();
    if (!native || native.rangeCount === 0) return null;
    const a = native.anchorNode;
    const ao = native.anchorOffset;
    const f = native.focusNode;
    const fo = native.focusOffset;
    if (!a || !f) return null;
    // Reject selections that escape the editor.
    if (!root.contains(a) || !root.contains(f)) return null;
    const anchor = domToAnchor(a, ao, root);
    const focus = domToAnchor(f, fo, root);
    if (!anchor || !focus) return null;
    if (
      anchor.blockId === focus.blockId &&
      anchor.offset === focus.offset &&
      anchor.path.length === focus.path.length &&
      anchor.path.every((v, i) => v === focus.path[i])
    ) {
      return caretSel(anchor);
    }
    return rangeSel(anchor, focus);
  };

  /** Apply an editor Selection to native window.getSelection(). */
  const applyNativeSelection = (sel: Selection): void => {
    const native = document.getSelection();
    if (!native) return;
    const anchorPoint =
      sel.kind === "caret"
        ? anchorToDom(sel.at, root)
        : anchorToDom(sel.anchor, root);
    const focusPoint =
      sel.kind === "caret"
        ? anchorPoint
        : anchorToDom(sel.focus, root);
    // Virtualization escape hatch: when a range endpoint lives in a block
    // that isn't currently mounted (Cmd+A across a 7,500-paragraph doc, only
    // ~60 viewport blocks in the DOM), neither setBaseAndExtent nor a
    // hand-rolled root-edge Range reliably renders a visible highlight
    // (browsers collapse on cross-tree containment quirks). Fall back to
    // selectAllChildren(root) — it always selects the mounted content. The
    // model selection stays canonical for commands.
    if (sel.kind === "range" && (!anchorPoint || !focusPoint)) {
      try {
        programmaticSeq++;
        native.removeAllRanges();
        native.selectAllChildren(root);
      } catch {
        // Headless environments may throw; nothing more to do.
      }
      return;
    }
    if (!anchorPoint || !focusPoint) return;
    // Don't bump programmaticSeq when writing the same selection the
    // browser already has — `setBaseAndExtent(...)` to the current
    // position is a no-op and fires no `selectionchange`. If we bump
    // anyway, the next user-driven selectionchange is mistakenly
    // consumed as the "missing" echo and the user's click is dropped.
    if (
      native.anchorNode === anchorPoint.node &&
      native.anchorOffset === anchorPoint.offset &&
      native.focusNode === focusPoint.node &&
      native.focusOffset === focusPoint.offset
    ) {
      return;
    }
    try {
      native.setBaseAndExtent(
        anchorPoint.node,
        anchorPoint.offset,
        focusPoint.node,
        focusPoint.offset,
      );
    } catch {
      // happy-dom / older browsers may throw on cross-tree ranges; fall back
      // to collapsed caret at the anchor.
      try {
        native.removeAllRanges();
        const range = document.createRange();
        range.setStart(anchorPoint.node, anchorPoint.offset);
        range.collapse(true);
        native.addRange(range);
      } catch {
        // Truly headless — nothing more we can do.
      }
    }
    // Bump programmaticSeq ONLY if the write actually moved the native
    // selection. If the call was a no-op (target nodes detached, or the
    // browser silently rejected the write), `selectionchange` won't
    // fire — bumping the seq anyway would consume the next user-driven
    // event as a phantom echo.
    if (
      native.anchorNode !== anchorPoint.node ||
      native.anchorOffset !== anchorPoint.offset ||
      native.focusNode !== focusPoint.node ||
      native.focusOffset !== focusPoint.offset
    ) {
      // Selection didn't actually move — don't expect an echo.
      return;
    }
    programmaticSeq++;
  };

  const onSelectionChange = (): void => {
    // Drop while composing — the IME advances native selection through
    // intermediate positions; we only care about the final state, captured
    // on compositionend.
    if (composing) return;
    // Drop selectionchange while a render is pending — the browser will fire
    // an extra event when the mutated block's text nodes get replaced, and
    // it points at detached nodes that map to bogus offsets.
    if (renderPending) return;
    // The first selectionchange after a programmatic write is the echo;
    // advance lastObservedSeq and ignore. Subsequent events (user-driven,
    // when seqs match) are forwarded.
    if (programmaticSeq !== lastObservedSeq) {
      lastObservedSeq = programmaticSeq;
      return;
    }
    // Logical-only range guard: if selStore currently holds a range with at
    // least one endpoint in an unmounted block (e.g. Cmd+A across a
    // virtualized doc), native selection can never fully represent it.
    // Render-induced selectionchange events would otherwise collapse the
    // model range to a caret in the visible portion every time VirtualDoc
    // re-mounts. We treat the model as canonical in that state.
    const current = selStore.get();
    if (current.kind === "range") {
      const anchorMounted = !!anchorToDom(current.anchor, root);
      const focusMounted = !!anchorToDom(current.focus, root);
      if (!anchorMounted || !focusMounted) return;
    }
    const sel = readNativeSelection();
    if (sel) selStore.set(sel);
  };

  document.addEventListener("selectionchange", onSelectionChange);

  // Sync the initial selection on mount.
  applyNativeSelection(selStore.get());

  // selStore-only changes (user drag, programmatic selection without doc
  // mutation): apply native selection synchronously. NO deferred re-apply
  // here — re-applying via setBaseAndExtent during an in-progress user
  // drag-selection in the browser disturbs the drag, breaking selection
  // entirely. The deferred path is only needed when the model holds a
  // logical-only range (one endpoint in an unmounted block) AND VirtualDoc
  // is about to re-render and collapse our selectAllChildren fallback.
  const unsubSel = selStore.subscribe(() => {
    if (composing) return;
    if (renderPending) return;
    const current = readNativeSelection();
    const target = selStore.get();
    if (current && selectionsEqual(current, target)) return;
    applyNativeSelection(target);
    // Targeted deferred re-apply for the logical-only case.
    if (target.kind === "range") {
      const aOK = !!anchorToDom(target.anchor, root);
      const fOK = !!anchorToDom(target.focus, root);
      if (!aOK || !fOK) {
        renderPending = true;
        scheduleAfterRender(() => {
          applyNativeSelection(selStore.get());
          renderPending = false;
        });
      }
    }
  });

  // docStore changes mean the renderer is about to replace the touched
  // block's text nodes. Native selection collapses onto the detached nodes;
  // restore it from the canonical selStore on the next animation frame, by
  // which time the reconciler has produced fresh nodes.
  const unsubDoc = docStore.subscribe(() => {
    if (composing) return;
    if (renderPending) return;
    renderPending = true;
    scheduleAfterRender(() => {
      applyNativeSelection(selStore.get());
      renderPending = false;
    });
  });

  // -------------------------------------------------------------------------
  // beforeinput → command dispatch
  //
  // Every inputType is preventDefaulted and translated. The browser is not
  // allowed to mutate the DOM (except during IME composition — see below).
  // -------------------------------------------------------------------------

  // Backspace / Delete need to choose between within-block delete and block
  // merging at boundaries. The split: a caret at offset 0 of a non-first
  // text-bearing block, or a range that crosses block boundaries, dispatches
  // mergeBackward; otherwise plain deleteBackward. (mergeBackward also
  // collapses cross-block ranges via its own range-collapse logic.) Symmetric
  // pair for deleteForward / mergeForward at end-of-block.
  const handleBackspace = (): void => {
    const sel = selStore.get();
    if (sel.kind === "range") {
      if (sel.anchor.blockId !== sel.focus.blockId) {
        options.dispatch({ t: "mergeBackward" });
        return;
      }
      options.dispatch({ t: "deleteBackward" });
      return;
    }
    const at = sel.at;
    // Caret on an atomic (non-editable) block: delete the whole block.
    const block = docStore.get().byId.get(at.blockId);
    if (block && isAtomicBlockType(block.type)) {
      deleteSelectedAtomic({ docStore, selStore });
      return;
    }
    const lastPathEntry = at.path[at.path.length - 1] ?? 0;
    if (lastPathEntry === 0 && at.path.length === 1) {
      // Top-level text-bearing block at offset 0 — try merge with prior block.
      const doc = docStore.get();
      const idx = doc.order.indexOf(at.blockId);
      if (idx > 0) {
        options.dispatch({ t: "mergeBackward" });
        return;
      }
    }
    options.dispatch({ t: "deleteBackward" });
  };

  const handleDelete = (): void => {
    const sel = selStore.get();
    if (sel.kind === "range") {
      if (sel.anchor.blockId !== sel.focus.blockId) {
        options.dispatch({ t: "mergeForward" });
        return;
      }
      options.dispatch({ t: "deleteForward" });
      return;
    }
    const at = sel.at;
    // Caret on an atomic block: forward-delete just removes the block.
    const block = docStore.get().byId.get(at.blockId);
    if (block && isAtomicBlockType(block.type)) {
      deleteSelectedAtomic({ docStore, selStore });
      return;
    }
    if (at.path.length === 1) {
      const doc = docStore.get();
      const tb = doc.byId.get(at.blockId);
      if (tb && "runs" in tb) {
        const len = tb.runs.reduce((n, r) => n + r.text.length, 0);
        const off = at.path[0] ?? 0;
        const idx = doc.order.indexOf(at.blockId);
        if (off === len && idx >= 0 && idx < doc.order.length - 1) {
          options.dispatch({ t: "mergeForward" });
          return;
        }
      }
    }
    options.dispatch({ t: "deleteForward" });
  };

  const onBeforeInput = (e: InputEvent): void => {
    const t = e.inputType;

    // Read-only: swallow everything, including composition, so the browser
    // never writes into the DOM behind the model's back.
    if (!isEditable()) {
      e.preventDefault();
      return;
    }

    // IME composition — let the browser write into the DOM; we reconcile the
    // affected scope against the model on compositionend.
    if (
      t === "insertCompositionText" ||
      t === "insertFromComposition" ||
      t === "deleteCompositionText"
    ) {
      return;
    }

    e.preventDefault();

    switch (t) {
      case "insertText": {
        if (e.data) {
          options.dispatch({ t: "insertText", text: e.data });
          // Notify trigger manager AFTER the text has been spliced into
          // the model — slash menus / mentions match against the just-
          // inserted character(s).
          options.triggers.onTextInserted(e.data);
        }
        return;
      }
      case "insertParagraph":
        options.dispatch({ t: "splitBlock" });
        return;
      case "insertLineBreak": {
        // Inside a code block a soft break inserts "\n" (code blocks never
        // split on Enter); every other text-bearing block splits.
        const sel = selStore.get();
        const focusId = sel.kind === "caret" ? sel.at.blockId : sel.focus.blockId;
        if (docStore.get().byId.get(focusId)?.type === "code") {
          options.dispatch({ t: "insertText", text: "\n" });
        } else {
          options.dispatch({ t: "splitBlock" });
        }
        return;
      }
      case "deleteContentBackward":
      case "deleteWordBackward":
      case "deleteSoftLineBackward":
      case "deleteHardLineBackward":
        handleBackspace();
        return;
      case "deleteContentForward":
      case "deleteWordForward":
      case "deleteSoftLineForward":
      case "deleteHardLineForward":
        handleDelete();
        return;
      case "formatBold":
        options.dispatch({ t: "toggleMark", mark: "b" });
        return;
      case "formatItalic":
        options.dispatch({ t: "toggleMark", mark: "i" });
        return;
      case "formatUnderline":
        options.dispatch({ t: "toggleMark", mark: "u" });
        return;
      case "formatStrikeThrough":
        options.dispatch({ t: "toggleMark", mark: "s" });
        return;
      case "historyUndo":
        options.undo();
        return;
      case "historyRedo":
        options.redo();
        return;
      case "insertReplacementText": {
        // iOS autocorrect — replace targetRanges with new text.
        if (!e.data) return;
        const ranges = (e as InputEvent & {
          getTargetRanges?: () => StaticRange[];
        }).getTargetRanges?.();
        if (ranges && ranges.length > 0) {
          const target = ranges[0]!;
          const startA = domToAnchor(
            target.startContainer,
            target.startOffset,
            root,
          );
          const endA = domToAnchor(
            target.endContainer,
            target.endOffset,
            root,
          );
          if (startA && endA && startA.blockId === endA.blockId) {
            // Move selection over the replaced range, then delete and
            // re-insert. Avoids needing a dedicated replaceRange command.
            // Cross-block target ranges fall through to the plain insert
            // below — deleteBackward can't collapse those, so doing it here
            // would duplicate text.
            selStore.set(rangeSel(startA, endA));
            options.dispatch({ t: "deleteBackward" });
            options.dispatch({ t: "insertText", text: e.data });
            return;
          }
        }
        // Fallback: replace at current selection.
        options.dispatch({ t: "insertText", text: e.data });
        return;
      }
      case "insertFromPaste":
      case "insertFromPasteAsQuotation":
      case "insertFromYank":
      case "insertFromDrop": {
        // Paste / drop are routed through their dedicated event handlers
        // (paste / drop), where we have access to the clipboard payload.
        // beforeinput here arrives WITHOUT data on most browsers, so the
        // dedicated handlers are authoritative.
        return;
      }
      default:
        // Unknown formatting commands are swallowed silently. Logging here
        // would be noisy on browsers that fire vendor-specific inputTypes.
        return;
    }
  };

  root.addEventListener("beforeinput", onBeforeInput as EventListener);

  // -------------------------------------------------------------------------
  // keydown → keymap chords
  //
  // beforeinput covers most editing operations on modern browsers, but
  // chord matching for navigation extensions (Cmd+ArrowLeft, Option+Arrow,
  // etc.) and feature shortcuts (Cmd+Shift+S for strikethrough on macOS)
  // still flow through keydown.
  // -------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent): void => {
    // Active trigger (slash menu, @-mention, etc.) consumes keys first —
    // arrow nav, Enter pick, Escape cancel are all owned by the trigger UI.
    if (options.triggers.handleKeyDown(e)) return;

    // Plugin keymap entries get the next shot — table cell navigation and
    // any user-registered chord. The matcher checks chord + `when`
    // predicate; the command may still no-op (return false), in which case
    // we fall through to the built-in keymap and browser default.
    const ctx = options.commandCtx;
    const hit = matchPluginKeymap(e, options.registry.keymap, ctx);
    if (hit) {
      const ok = options.registry.runCommand(
        hit.command.t,
        hit.command.payload,
        ctx,
      );
      if (ok) {
        e.preventDefault();
        return;
      }
      // Plugin command was a no-op (e.g. ArrowLeft at start of cell with
      // no previous cell) — fall through so the browser handles natively.
      // We intentionally do NOT preventDefault here.
    }

    const builtin = matchKeymap(e);
    if (!builtin) return;
    switch (builtin.kind) {
      case "toggleMark":
        e.preventDefault();
        options.dispatch({ t: "toggleMark", mark: builtin.mark as Mark });
        return;
      case "setBlockType":
        e.preventDefault();
        options.dispatch({ t: "setBlockType", payload: builtin.payload });
        return;
      case "indent":
        e.preventDefault();
        options.dispatch({ t: "indentList" });
        return;
      case "outdent":
        e.preventDefault();
        options.dispatch({ t: "outdentList" });
        return;
      case "undo":
        e.preventDefault();
        options.undo();
        return;
      case "redo":
        e.preventDefault();
        options.redo();
        return;
      case "selectAll":
        e.preventDefault();
        options.selectAll();
        return;
      case "moveWord":
      case "moveLineEdge":
      case "moveDocEdge":
        // Let the browser handle these natively; selectionchange syncs to
        // selStore. We trust the browser's word-boundary and line-edge
        // logic to match the platform.
        return;
    }
  };

  root.addEventListener("keydown", onKeyDown);

  // -------------------------------------------------------------------------
  // IME composition handlers
  //
  // Strategy: snapshot the current caret + scope text length on
  // compositionstart, allow the browser to mutate the DOM during composition,
  // then on compositionend diff the scope's textContent against the snapshot
  // and dispatch ONE `insertText` command with the inserted text. Coalesces
  // into a single undo step; preserves marks outside the composition range
  // because the existing insertText command splices into runs correctly.
  //
  // Range-selection-as-composition-start: if the user had a range selected
  // when composition began, we collapse it to the start anchor first and
  // delete the range, so the composition snapshot is always taken against a
  // caret in a known state. Edge-case for v1; matches Slate / ProseMirror.
  // -------------------------------------------------------------------------

  /** Length of the model text that owns `anchor` (block / cell / column).
   *  Routed through the plugin runsAt registry so blocks with nested runs
   *  containers (table cells, columns cells, future plugin blocks) work
   *  without per-kind branches here. */
  const modelScopeLength = (a: Anchor): number | null => {
    const block = docStore.get().byId.get(a.blockId);
    if (!block) return null;
    return runsLengthAt(block, a);
  };

  /** DOM scope (element + visible text) for the given anchor.
   *  Pulls the scope via the AnchorCodec.domScope hook (table → <td>,
   *  columns → <div data-col>, default → block element itself).
   *
   *  `visibleTextOf` — not `textContent` — because inline widgets live in
   *  this subtree and are not in the model. Reading their text here would
   *  make the composition diff see a phantom insertion the size of the
   *  widget (ghost text is multi-line; that would be catastrophic). ZWSP
   *  placeholders are dropped by the same walk. */
  const domScope = (
    a: Anchor,
  ): { scope: HTMLElement; text: string } | null => {
    const blockEl = findBlockElementById(root, a.blockId);
    if (!blockEl) return null;
    const kind = blockEl.getAttribute("data-block-kind") ?? "";
    const codec = lookupAnchorCodec(kind);
    const scope = codec?.domScope?.(blockEl, a) ?? blockEl;
    return { scope, text: visibleTextOf(scope) };
  };

  const onCompositionStart = (): void => {
    if (!isEditable()) return;
    const sel = selStore.get();
    // If a range was selected, delete it first — we want a caret-only start
    // so the post-composition diff is unambiguous. Route through
    // handleBackspace so cross-block ranges actually collapse (a raw
    // deleteBackward no-ops across block boundaries).
    if (sel.kind === "range") {
      handleBackspace();
    }
    const after = selStore.get();
    if (after.kind !== "caret") return;
    // Snapshot length from the MODEL, not the DOM. We may have just
    // dispatched a range-delete and the renderer is async — DOM still shows
    // the pre-delete text. The model is canonical.
    const preLength = modelScopeLength(after.at);
    if (preLength === null) return;
    composing = true;
    compositionSnapshot = { anchor: after.at, preLength };
  };

  const onCompositionEnd = (): void => {
    composing = false;
    const snap = compositionSnapshot;
    compositionSnapshot = null;
    if (!snap) return;
    // For the post-composition read we use the DOM, because the browser
    // wrote IME output directly into it (the model is still pre-composition).
    const scope = domScope(snap.anchor);
    if (!scope) {
      docStore.set(docStore.get()); // force render to reconcile
      return;
    }
    const newLen = scope.text.length;
    const insertedLen = newLen - snap.preLength;
    if (insertedLen <= 0) {
      // Cancelled or no-op composition — re-render reconciles DOM to model.
      docStore.set(docStore.get());
      return;
    }
    const offsetInScope =
      snap.anchor.path.length === 1
        ? snap.anchor.path[0] ?? 0
        : snap.anchor.path[snap.anchor.path.length - 1] ?? 0;
    const insertedText = scope.text.slice(
      offsetInScope,
      offsetInScope + insertedLen,
    );
    // Move selStore back to the snapshot anchor so insertText splices at the
    // right position (the live native selection is at end-of-composition,
    // but the model still has pre-composition text).
    selStore.set(caretSel(snap.anchor));
    options.dispatch({ t: "insertText", text: insertedText });
  };

  root.addEventListener("compositionstart", onCompositionStart);
  root.addEventListener("compositionend", onCompositionEnd);

  // -------------------------------------------------------------------------
  // Clipboard: copy / cut / paste
  //
  // The clipboard event fires on the contenteditable root rather than a
  // hidden textarea. Selection is read from selStore (which is in sync via
  // the selectionchange listener), so the existing serializer/parser modules
  // work unchanged.
  // -------------------------------------------------------------------------

  /** True when the native selection (or its anchor/focus) lives inside our
   *  editor root. Used to gate document-level clipboard listeners so we
   *  don't intercept events targeted at other inputs on the page. */
  const selectionInRoot = (): boolean => {
    const sel = document.getSelection();
    if (!sel) return false;
    const a = sel.anchorNode;
    const f = sel.focusNode;
    if (a && root.contains(a)) return true;
    if (f && root.contains(f)) return true;
    return false;
  };

  const onCopy = (e: ClipboardEvent): void => {
    if (!selectionInRoot()) return;
    const sel = selStore.get();
    if (sel.kind === "caret") return;
    e.preventDefault();
    const payload = selectionToClipboard(docStore.get(), sel);
    e.clipboardData?.setData("text/html", payload.html);
    e.clipboardData?.setData("text/plain", payload.plain);
  };

  const onCut = (e: ClipboardEvent): void => {
    if (!selectionInRoot()) return;
    // Read-only: a cut would delete. Degrade to copy so the user still gets
    // the content on the clipboard.
    if (!isEditable()) {
      onCopy(e);
      return;
    }
    const sel = selStore.get();
    if (sel.kind === "caret") return;
    e.preventDefault();
    const payload = selectionToClipboard(docStore.get(), sel);
    e.clipboardData?.setData("text/html", payload.html);
    e.clipboardData?.setData("text/plain", payload.plain);
    // Route through handleBackspace so a cross-block range is actually removed
    // (a raw deleteBackward no-ops across block boundaries, leaving the cut
    // content in the document).
    handleBackspace();
  };

  // Shift state side-channel — many browsers don't expose `shiftKey` on
  // ClipboardEvent, so we observe keydown/up to know whether the user held
  // Shift while initiating the paste (forces plain-text insertion).
  let pasteShiftHeld = false;
  const onShiftKey = (e: KeyboardEvent): void => {
    pasteShiftHeld = e.shiftKey === true;
  };

  const onPaste = (e: ClipboardEvent): void => {
    if (!selectionInRoot()) return;
    if (!isEditable()) {
      e.preventDefault();
      return;
    }
    const data = e.clipboardData;
    if (!data) return;
    // Plugin paste hooks get first refusal — before preventDefault, so a hook
    // that declines leaves the event exactly as it found it.
    if (options.onPaste?.(e)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    // Image files take priority over text — copy-image-from-browser sets
    // both, but the user clearly wants the image when one is available.
    if (data.files && data.files.length > 0) {
      let hasImage = false;
      for (const f of Array.from(data.files)) {
        if (f.type.startsWith("image/")) {
          hasImage = true;
          break;
        }
      }
      if (hasImage) {
        void insertImageFiles(
          imageTarget,
          data.files,
          options.uploadImage,
        );
        return;
      }
    }
    const forcePlain = pasteShiftHeld;
    const html = data.getData("text/html");
    if (!forcePlain && html) {
      const blocks = parseHTML(html);
      if (blocks.length) {
        insertBlocks({ docStore, selStore }, blocks);
        return;
      }
    }
    const plain = data.getData("text/plain");
    if (plain) {
      const blocks = parsePlainText(plain);
      if (blocks.length) insertBlocks({ docStore, selStore }, blocks);
    }
  };

  // Listen at document level so clipboard events from the browser's
  // OS context menu (right-click → Cut / Copy / Paste) reach us. The
  // browser dispatches those on the document, not on the contenteditable
  // root, so a root-level listener would miss them. The handlers gate by
  // `selectionInRoot()` to ignore events targeted at other inputs on the
  // page.
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  root.addEventListener("keydown", onShiftKey, true);
  root.addEventListener("keyup", onShiftKey, true);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  return {
    syncEditable,
    destroy: () => {
      attached = false;
      document.removeEventListener("selectionchange", onSelectionChange);
      root.removeEventListener("focusin", syncEditable);
      root.removeEventListener("pointerdown", syncEditable, true);
      root.removeEventListener("beforeinput", onBeforeInput as EventListener);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("compositionstart", onCompositionStart);
      root.removeEventListener("compositionend", onCompositionEnd);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      root.removeEventListener("keydown", onShiftKey, true);
      root.removeEventListener("keyup", onShiftKey, true);
      unsubSel();
      unsubDoc();
      root.removeAttribute("contenteditable");
      root.removeAttribute("spellcheck");
    },
  };
}

// ---------------------------------------------------------------------------
// Selection equality — used to short-circuit redundant native writes.
// ---------------------------------------------------------------------------

function selectionsEqual(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "caret" && b.kind === "caret") {
    return anchorsEq(a.at, b.at);
  }
  if (a.kind === "range" && b.kind === "range") {
    return anchorsEq(a.anchor, b.anchor) && anchorsEq(a.focus, b.focus);
  }
  return false;
}

function anchorsEq(a: Anchor, b: Anchor): boolean {
  if (a.blockId !== b.blockId) return false;
  if (a.offset !== b.offset) return false;
  if (a.path.length !== b.path.length) return false;
  for (let i = 0; i < a.path.length; i++) {
    if (a.path[i] !== b.path[i]) return false;
  }
  return true;
}
