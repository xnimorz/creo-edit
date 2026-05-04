import { view, div, aside, ul, li, a, span, _ } from "creo";
import { EditorPage } from "./EditorPage";
import type { CompiledDoc } from "../markdown/types";
import { prevNext } from "../nav";
import { consumePendingAnchor, scrollToAnchor } from "../anchor";

let anchorListenerAttached = false;

const attachAnchorListener = () => {
  if (anchorListenerAttached) return;
  anchorListenerAttached = true;
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const anchor = target.closest(
      "a[href^='#']",
    ) as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#/") || href === "#") return;
    const id = href.slice(1);
    if (!document.getElementById(id)) return;
    e.preventDefault();
    scrollToAnchor(id);
  });
};

const onDocMount = () => {
  attachAnchorListener();
  const pending = consumePendingAnchor();
  if (!pending) return;

  const doScroll = () => scrollToAnchor(pending, false);
  // Wait for the editor to paint before scrolling — heading ids are wired
  // in EditorPage's own rAF callback, so we do a slight delay then retry.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      doScroll();
      if (document.readyState !== "complete") {
        window.addEventListener("load", doScroll, { once: true });
      } else {
        setTimeout(doScroll, 120);
      }
    });
  });
};

export const DocPage = view<{ doc: CompiledDoc; slug: string }>(({ props }) => {
  return {
    onMount: onDocMount,
    render() {
      const { doc, slug } = props();

      div({ class: "doc-page" }, () => {
        // Article body — now a live editor over the page content.
        div({ class: "doc-article" }, () => {
          EditorPage({ doc });

          // Prev/next pager — outside the editor, regular nav.
          const { prev, next } = prevNext(slug);
          if (prev || next) {
            div({ class: "doc-pager" }, () => {
              if (prev) {
                a({ href: `#/${prev.slug}`, class: "pager-link prev" }, () => {
                  span({ class: "pager-label" }, "Previous");
                  span({ class: "pager-title" }, prev.title);
                });
              } else {
                span(_);
              }
              if (next) {
                a({ href: `#/${next.slug}`, class: "pager-link next" }, () => {
                  span({ class: "pager-label" }, "Next");
                  span({ class: "pager-title" }, next.title);
                });
              }
            });
          }
        });

        // Right-side TOC — outside the editor.
        if (doc.headings.length > 1) {
          aside({ class: "doc-toc" }, () => {
            div({ class: "toc-title" }, "On this page");
            ul({ class: "toc-list" }, () => {
              for (const h of doc.headings) {
                if (h.level < 2 || h.level > 3) continue;
                li({ key: h.slug, class: `toc-level-${h.level}` }, () => {
                  a({ href: `#${h.slug}` }, h.text);
                });
              }
            });
          });
        }
      });
    },
  };
});
