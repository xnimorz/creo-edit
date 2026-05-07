import {
  view,
  div,
  header,
  nav,
  aside,
  main,
  a,
  ul,
  li,
  span,
  button,
} from "creo";
import { navSections } from "../nav";
import { routeStore } from "../router";

function isFullBleed(slug: string): boolean {
  return slug === "" || slug === "demo";
}

export const Layout = view(({ slot, use }) => {
  const route = use(routeStore);
  const mobileOpen = use(false);

  const toggleMobile = () => mobileOpen.update((v) => !v);
  const closeMobile = () => mobileOpen.set(false);

  return {
    render() {
      const currentSlug = route.get().path.replace(/^\/+/, "");
      const fullBleed = isFullBleed(currentSlug);

      const layoutClass =
        "layout" +
        (mobileOpen.get() ? " nav-open" : "") +
        (fullBleed ? " layout-full" : " layout-docs");

      div({ class: layoutClass }, () => {
        header({ class: "site-header" }, () => {
          div({ class: "header-inner" }, () => {
            a({ href: "#/", class: "brand", "aria-label": "creo-edit" }, () => {
              span({ class: "brand-wordmark" }, () => {
                span({ class: "brand-bracket" }, "[");
                span({ class: "brand-c" }, "C");
                span({ class: "brand-tail" }, "reo");
                span({ class: "brand-slash" }, "-");
                span({ class: "brand-tail" }, "edit");
                span({ class: "brand-bracket" }, "]");
              });
            });

            nav({ class: "header-nav" }, () => {
              a({ href: "#/getting-started" }, "Docs");
              a({ href: "#/demo" }, "Demo");
              a(
                {
                  href: "https://github.com/xnimorz/creo-editor",
                  target: "_blank",
                },
                "GitHub",
              );
            });

            button(
              {
                class: "mobile-toggle",
                onClick: toggleMobile,
                "aria-label": "Toggle navigation",
              },
              () => {
                span({ class: "mobile-toggle-bar" });
                span({ class: "mobile-toggle-bar" });
                span({ class: "mobile-toggle-bar" });
              },
            );
          });
        });

        div({ class: "body-shell" }, () => {
          aside({ class: "sidebar" }, () => {
            for (const section of navSections) {
              div({ key: section.title, class: "nav-section" }, () => {
                div({ class: "nav-section-title" }, section.title);
                ul({ class: "nav-list" }, () => {
                  for (const item of section.items) {
                    const isActive = currentSlug === item.slug;
                    li({ key: item.slug }, () => {
                      a(
                        {
                          href: `#/${item.slug}`,
                          class: "nav-link" + (isActive ? " active" : ""),
                          onClick: closeMobile,
                        },
                        item.title,
                      );
                    });
                  }
                });
              });
            }
          });

          main({ class: "content" }, slot);
        });
      });
    },
  };
});
