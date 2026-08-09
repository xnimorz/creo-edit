// ---------------------------------------------------------------------------
// "The set of mounted block elements changed" signal.
//
// Overlay managers (range decorations, inline widgets) need to repaint when a
// block's DOM appears or disappears, because an anchor in an unmounted block
// resolves to nothing and has to be retried once it arrives. Under
// virtualization that happens on scroll, with no document change to hang off.
//
// This used to be inferred with a `MutationObserver` on the editor root with
// `subtree: true` — which does see block mounts, but also sees every text
// node the renderer touches while you type. So each keystroke bought a whole
// extra repaint that the docStore subscription had already covered.
//
// The renderer knows exactly when its mounted window changes, so it says so.
// Registered module-globally like the other cross-cutting registries, and
// scoped by editor root so two editors on one page don't repaint each other.
// ---------------------------------------------------------------------------

type Listener = (root: HTMLElement) => void;

const listeners = new Set<Listener>();

/** Subscribe to mount-set changes. Returns an unsubscribe fn. */
export function onMountedBlocksChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Announce that the blocks mounted under `root` changed. Called by
 * `VirtualDoc` after a render that added or removed block elements — NOT on
 * every render, or this would be the subtree observer again under a different
 * name.
 */
export function notifyMountedBlocksChanged(root: HTMLElement): void {
  if (listeners.size === 0) return;
  for (const fn of [...listeners]) {
    try {
      fn(root);
    } catch {
      // A throwing listener doesn't stop the others.
    }
  }
}
