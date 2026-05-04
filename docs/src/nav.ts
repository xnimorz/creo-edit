export type NavItem = { title: string; slug: string };
export type NavSection = { title: string; items: NavItem[] };

export const navSections: NavSection[] = [
  {
    title: "Introduction",
    items: [
      { title: "Overview", slug: "" },
      { title: "Getting Started", slug: "getting-started" },
    ],
  },
  {
    title: "API",
    items: [
      { title: "Editor API", slug: "editor-api" },
      { title: "Commands", slug: "commands" },
      { title: "Keybindings", slug: "keybindings" },
    ],
  },
  {
    title: "How-to",
    items: [
      { title: "HTML interop", slug: "html-interop" },
      { title: "Virtualization", slug: "virtualization" },
      { title: "Mobile", slug: "mobile" },
    ],
  },
  {
    title: "Internals",
    items: [{ title: "Architecture", slug: "architecture" }],
  },
  {
    title: "Demo",
    items: [{ title: "Try the editor", slug: "demo" }],
  },
];

export function findNavItem(slug: string): NavItem | null {
  for (const s of navSections) {
    for (const i of s.items) if (i.slug === slug) return i;
  }
  return null;
}

export function prevNext(slug: string): {
  prev: NavItem | null;
  next: NavItem | null;
} {
  const flat: NavItem[] = navSections.flatMap((s) => s.items);
  const i = flat.findIndex((x) => x.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? flat[i - 1] : null,
    next: i < flat.length - 1 ? flat[i + 1] : null,
  };
}
