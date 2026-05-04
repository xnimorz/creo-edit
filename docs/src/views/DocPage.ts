import { view, div, aside, ul, li, a, span, _ } from "creo";
import { RawHtml } from "./RawHtml";
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

    // Package-manager tab widget (used in install instructions).
    const tab = target.closest<HTMLElement>(".pkg-tab[data-pkg]");
    if (tab) {
      const root = tab.closest<HTMLElement>(".pkg-tabs");
      const key = tab.dataset.pkg;
      if (root && key) {
        root.querySelectorAll<HTMLElement>(".pkg-tab").forEach((t) =>
          t.classList.toggle("active", t.dataset.pkg === key),
        );
        root.querySelectorAll<HTMLElement>(".pkg-panel").forEach((p) =>
          p.classList.toggle("active", p.dataset.pkg === key),
        );
      }
      return;
    }

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
  requestAnimationFrame(() => {
    doScroll();
    if (document.readyState !== "complete") {
      window.addEventListener("load", doScroll, { once: true });
    } else {
      setTimeout(doScroll, 120);
    }
  });
};

export const DocPage = view<{ doc: CompiledDoc; slug: string }>(({ props }) => {
  return {
    onMount: onDocMount,
    render() {
      const { doc, slug } = props();

      div({ class: "doc-page" }, () => {
        div({ class: "doc-article" }, () => {
          RawHtml({ html: doc.html, class: "markdown-body" });

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
