// Inline icons. 16×16, stroked with `currentColor` so they follow the text
// colour of whatever draws them (the bar, a host's menu).

const svg = (body: string, extra = ""): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const icons = {
  diagram: svg('<rect x="2" y="2" width="5" height="4" rx="1"/><rect x="9" y="10" width="5" height="4" rx="1"/><path d="M4.5 6v3a2 2 0 0 0 2 2H9"/>'),
  code: svg('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  edit: svg('<path d="M3 13l.6-2.8L10.8 3l2.2 2.2-7.2 7.2L3 13z"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>'),
  download: svg('<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"/>'),
  reverse: svg('<path d="M3 5.5h10M10.5 3 13 5.5 10.5 8M13 10.5H3M5.5 8 3 10.5 5.5 13"/>'),
  down: svg('<path d="M8 2.5v11M4.5 10 8 13.5l3.5-3.5"/>'),
  right: svg('<path d="M2.5 8h11M10 4.5 13.5 8 10 11.5"/>'),
  more: svg('<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>'),
  check: svg('<path d="M3 8.5 6.5 12 13 4.5"/>'),
  // Flowchart shapes.
  rect: svg('<rect x="2" y="4" width="12" height="8"/>'),
  round: svg('<rect x="2" y="4" width="12" height="8" rx="2.5"/>'),
  stadium: svg('<rect x="2" y="4.5" width="12" height="7" rx="3.5"/>'),
  diamond: svg('<path d="M8 2.5 14 8l-6 5.5L2 8z"/>'),
  circle: svg('<circle cx="8" cy="8" r="5.5"/>'),
  hexagon: svg('<path d="M5 3.5h6L14 8l-3 4.5H5L2 8z"/>'),
  cylinder: svg('<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7"/>'),
  subroutine: svg('<rect x="2" y="4" width="12" height="8"/><path d="M4.5 4v8M11.5 4v8"/>'),
  // Mind-map shapes that are not a flowchart's.
  default: svg('<path d="M4 4.5h8M8 4.5v7.5"/>'),
  cloud: svg('<path d="M4.8 12.5a2.8 2.8 0 0 1-.4-5.6 3.6 3.6 0 0 1 7-.6 3.1 3.1 0 0 1-.2 6.2z"/>'),
  bang: svg('<path d="M8 1.8l1.5 3 3.2-1-1 3.2 3 1.5-3 1.5 1 3.2-3.2-1-1.5 3-1.5-3-3.2 1 1-3.2-3-1.5 3-1.5-1-3.2 3.2 1z"/>'),
  // A Gantt task's marks.
  active: svg('<path d="M5.5 3.5v9l7-4.5z"/>'),
  done: svg('<path d="M3 8.5 6.5 12 13 4.5"/>'),
  crit: svg('<path d="M8 3v6.5M8 12.4v.1"/>'),
  milestone: svg('<path d="M8 2.5 13.5 8 8 13.5 2.5 8z"/>'),
  calendar: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>'),
  // Edge line styles.
  solid: svg('<path d="M2 8h12"/>'),
  dotted: svg('<path d="M2 8h12" stroke-dasharray="1.5 2.5"/>'),
  thick: svg('<path d="M2 8h12" stroke-width="3"/>'),
} as const;

export type IconName = keyof typeof icons;

export const iconFor = (name: string): string =>
  (icons as Record<string, string>)[name] ?? icons.more;
