import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { Marked, type Tokens } from "marked";
import { markdownToDoc } from "./toEditorDoc";
import type { CompiledDoc, DocHeading } from "./types";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function parseFrontmatter(src: string): {
  body: string;
  data: Record<string, string>;
} {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { body: src, data: {} };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    data[key] = val;
  }
  return { body: src.slice(m[0].length), data };
}

function extractHeadings(src: string): DocHeading[] {
  // Use marked's lexer just to walk headings — same lexer that
  // markdownToDoc uses, so heading order matches what the editor renders.
  const lex = new Marked({ gfm: true });
  const tokens = lex.lexer(src);
  const headings: DocHeading[] = [];
  for (const tok of tokens) {
    if (tok.type === "heading") {
      const h = tok as Tokens.Heading;
      const plain = h.tokens.map((t: any) => t.text ?? "").join("");
      headings.push({ level: h.depth, text: plain, slug: slugify(plain) });
    }
  }
  return headings;
}

function compile(src: string, slug: string): CompiledDoc {
  const { body, data } = parseFrontmatter(src);

  const headings = extractHeadings(body);
  const doc = markdownToDoc(body);

  let title = data.title ?? "";
  if (!title) {
    const firstH1 = headings.find((h) => h.level === 1);
    title = firstH1?.text ?? slug;
  }

  return {
    meta: { title, slug },
    doc,
    headings,
  };
}

const VIRTUAL_INDEX = "virtual:docs-index";
const RESOLVED_VIRTUAL_INDEX = "\0" + VIRTUAL_INDEX;

export function markdownPlugin(): Plugin {
  let contentDir: string;

  return {
    name: "creo-edit-docs-markdown",
    enforce: "pre",
    configResolved(cfg) {
      contentDir = path.resolve(cfg.root, "content");
    },

    resolveId(id, importer) {
      if (id === VIRTUAL_INDEX) return RESOLVED_VIRTUAL_INDEX;
      if (id.endsWith(".md?doc")) {
        const clean = id.slice(0, -"?doc".length);
        if (path.isAbsolute(clean)) return id;
        if (importer) {
          const abs = path.resolve(path.dirname(importer), clean);
          return abs + "?doc";
        }
      }
    },

    load(id) {
      if (id === RESOLVED_VIRTUAL_INDEX) {
        const entries: { slug: string; file: string }[] = [];
        const walk = (dir: string, prefix: string) => {
          for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              walk(full, prefix + name + "/");
            } else if (name.endsWith(".md")) {
              const base = name.replace(/\.md$/, "");
              const slug =
                prefix === "" && base === "index" ? "" : prefix + base;
              entries.push({ slug, file: full });
            }
          }
        };
        walk(contentDir, "");

        const imports = entries
          .map(
            (e, i) =>
              `import d${i} from ${JSON.stringify(e.file + "?doc")};`,
          )
          .join("\n");

        const map = entries
          .map((e, i) => `  ${JSON.stringify(e.slug)}: d${i}`)
          .join(",\n");

        return `${imports}\nexport const docs = {\n${map}\n};\n`;
      }

      if (id.endsWith(".md?doc")) {
        const file = id.slice(0, -"?doc".length);
        const src = fs.readFileSync(file, "utf8");
        const rel = path.relative(contentDir, file).replace(/\\/g, "/");
        const withoutExt = rel.replace(/\.md$/, "");
        const slug = withoutExt === "index" ? "" : withoutExt;
        const compiled = compile(src, slug);
        return `export default ${JSON.stringify(compiled)};`;
      }
    },

    handleHotUpdate(ctx) {
      if (ctx.file.endsWith(".md") && ctx.file.startsWith(contentDir)) {
        const mod = ctx.server.moduleGraph.getModuleById(ctx.file + "?doc");
        if (mod) ctx.server.moduleGraph.invalidateModule(mod);
        return [
          ...(mod ? [mod] : []),
          ...(ctx.server.moduleGraph.getModulesByFile(ctx.file) ?? []),
        ];
      }
    },
  };
}
