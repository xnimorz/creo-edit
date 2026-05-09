import { createRouter } from "creo-router";
import { view } from "creo";
import { docs } from "virtual:docs-index";
import { Landing } from "./views/Landing";
import { NotFound } from "./views/NotFound";
import { DocPage } from "./views/DocPage";
import { Demo } from "./views/Demo";
import { AtomicBlocksDemo } from "./views/AtomicBlocksDemo";
import { navSections } from "./nav";

const DocRoute = view<{ slug: string }>(({ props }) => ({
  render() {
    const slug = props().slug;
    const doc = docs[slug];
    if (!doc) {
      NotFound();
      return;
    }
    DocPage({ doc, slug });
  },
}));

const slugs = new Set<string>();
for (const s of navSections) for (const i of s.items) slugs.add(i.slug);
for (const k of Object.keys(docs)) slugs.add(k);

const routes: { path: string; view: () => void }[] = [
  { path: "/", view: () => Landing() },
  { path: "/demo", view: () => Demo() },
  { path: "/non-editable-blocks", view: () => AtomicBlocksDemo() },
];

const STANDALONE_SLUGS = new Set(["demo", "non-editable-blocks"]);
for (const slug of slugs) {
  if (!slug) continue;
  if (STANDALONE_SLUGS.has(slug)) continue;
  routes.push({ path: "/" + slug, view: () => DocRoute({ slug }) });
}

export const { routeStore, navigate, RouterView, Link } = createRouter({
  routes,
  fallback: () => NotFound(),
});

// Scroll to the top of the page on route change. The router's hash-based
// nav doesn't reset scroll like a full page load does — without this,
// clicking a sidebar entry while scrolled deep on the previous page leaves
// you mid-page on the new one.
//
// In-page heading anchors (e.g. clicking a TOC link) use `replaceState`
// from anchor.ts, which doesn't trigger `hashchange` → doesn't fire this
// subscription. So heading anchors still scroll to their target without
// us clobbering them.
//
// The initial load is also fine: on first subscribe, `lastPath` is already
// the current path, so the no-op guard skips the first synchronous emit
// (if any). DocPage's `consumePendingAnchor` then handles deep links into
// a heading on the page.
{
  let lastPath = routeStore.get().path;
  routeStore.subscribe(() => {
    const path = routeStore.get().path;
    if (path === lastPath) return;
    lastPath = path;
    window.scrollTo(0, 0);
  });
}
