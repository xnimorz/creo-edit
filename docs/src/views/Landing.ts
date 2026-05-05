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
    title: "Controlled contentEditable",
    text:
      "Native browser selection and IME, but every beforeinput is intercepted and translated into a command. The model is the source of truth; the DOM is rendered output.",
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
    title: "First-class mobile support",
    text:
      "Native long-press OS menu, native selection handles, IME composition reconciled into one undo step, visualViewport-aware caret-keeping.",
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
              span({ class: "hero-accent" }, "A text editor framework");
              span({}, ", ");
              span({ class: "hero-accent" }, "based on creo");
              span({}, ".");
            });
            p(
              { class: "hero-tagline" },
              "Row-based rich-text editor for the Creo UI framework, on a controlled contentEditable. Type into the editor on the right — it's the real thing, not a mockup.",
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
