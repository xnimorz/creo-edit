import { createApp, HtmlRender, _ } from "creo";
import "./anchor";
import { Layout } from "./views/Layout";
import { RouterView } from "./router";
import "./styles.css";
// Default stylesheet for first-party plugins (slash menu, drag handle,
// add-block button). Optional — plugins set only positional styles inline;
// appearance lives in this stylesheet and is overridable.
import "../../src/plugins/styles.css";
import "highlight.js/styles/github.css";

const el = document.getElementById("app")!;

createApp(
  () => {
    Layout(_, () => {
      RouterView();
    });
  },
  new HtmlRender(el),
).mount();
