import {
  view,
  div,
  section,
  h1,
  h2,
  h3,
  p,
  a,
  span,
  _,
} from "creo";
import { EditorDemo } from "./EditorDemo";

const features = [
  {
    title: "No contentEditable",
    text:
      "A hidden <textarea> captures every keystroke, IME composition, mobile soft keyboard, and clipboard event. The visible document is just rendered output.",
  },
  {
    title: "Cursor outside the doc",
    text:
      "Selection lives in its own store. Caret motion never dirties document subscribers, and document edits never dirty selection subscribers.",
  },
  {
    title: "O(1) per keystroke",
    text:
      "Block immutability + identity-based shouldUpdate makes the keyed reconciler skip every untouched block, regardless of document size.",
  },
  {
    title: "CRDT-friendly ordering",
    text:
      "Base-62 fractional indices for block order — insert-between is O(log n), no renumbering, microtask auto-rebalance under adversarial patterns.",
  },
  {
    title: "Optional virtualization",
    text:
      "Only blocks intersecting the viewport are mounted, with measured heights stored in a Fenwick tree. Hundreds of thousands of blocks stay responsive.",
  },
  {
    title: "Mobile-first",
    text:
      "Caret-following hidden input, visualViewport tracking, tap/scroll/long-press classifier, custom selection handles, floating mobile toolbar.",
  },
];

export const Landing = view(() => ({
  render() {
    div({ class: "landing" }, () => {
      // ----------- Hero (left: copy, right: live editor) -----------
      section({ class: "hero" }, () => {
        div({ class: "hero-inner" }, () => {
          div({ class: "hero-copy" }, () => {
            h1(_, () => {
              span({ class: "hero-accent" }, "Rich text");
              span({}, ", ");
              span({ class: "hero-accent" }, "minus the magic");
              span({}, ".");
            });
            p(
              { class: "hero-tagline" },
              "Row-based, no-contentEditable rich-text editor for the Creo UI framework. Type into the editor on the right — it's the real thing, not a mockup.",
            );

            div({ class: "hero-cta" }, () => {
              a(
                { href: "#/getting-started", class: "btn btn-primary" },
                "Get started",
              );
              a({ href: "#/demo", class: "btn btn-ghost" }, "Open full demo");
            });
          });

          div({ class: "hero-editor" }, () => {
            EditorDemo({ class: "hero-editor-inner" });
          });
        });
      });

      // ----------------------- Features ----------------------------
      section({ class: "features" }, () => {
        h2({ class: "section-title" }, "Why this editor");
        div({ class: "feature-grid" }, () => {
          for (const f of features) {
            div({ key: f.title, class: "feature-card" }, () => {
              h3(_, f.title);
              p(_, f.text);
            });
          }
        });
      });

      // ------------------------- CTA -------------------------------
      section({ class: "cta-strip" }, () => {
        div({ class: "cta-inner" }, () => {
          h2(_, "Read the docs");
          p(
            _,
            "createEditor options, the Command vocabulary, virtualization, mobile UX, and the architecture behind it.",
          );
          a(
            { href: "#/getting-started", class: "btn btn-primary" },
            "Start reading",
          );
        });
      });
    });
  },
}));
