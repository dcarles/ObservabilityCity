// The few legend pictures that an emoji cannot show: a beacon in each colour, the red exclamation mark, a flag and the dead-letter pen.
// Plain inline SVG, drawn here, in the town's own colours (the CSS variables), so they follow the theme and need no package.

const svg = (body: string): string => `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false">${body}</svg>`

const beacon = (colour: string): string => svg(
  `<circle cx="16" cy="12" r="10" fill="${colour}" opacity="0.22"/><rect x="14.5" y="17" width="3" height="11" rx="1.5" fill="currentColor" opacity="0.55"/><circle cx="16" cy="12" r="5.5" fill="${colour}"/><circle cx="14" cy="10" r="1.8" fill="#fff" opacity="0.7"/>`,
)

export const LEGEND_SVG: Record<string, string> = {
  'beacon-green': beacon('var(--green)'),
  'beacon-amber': beacon('var(--amber)'),
  'beacon-red': beacon('var(--red)'),
  'health-sign': svg(`<circle cx="16" cy="16" r="12.5" fill="var(--red)"/><rect x="14.4" y="7.5" width="3.2" height="11" rx="1.6" fill="#fff"/><circle cx="16" cy="22.4" r="1.9" fill="#fff"/>`),
  flag: svg(`<rect x="8" y="4" width="2.6" height="24" rx="1.3" fill="currentColor" opacity="0.6"/><path d="M10.6 5.5 L25 9.5 L10.6 15.5 Z" fill="var(--red)"/>`),
  pen: svg(`<path d="M16 2 L16 13" stroke="var(--red)" stroke-width="3" stroke-linecap="round" opacity="0.8"/><path d="M5 17 H27" stroke="currentColor" stroke-width="2" opacity="0.5"/><rect x="6.5" y="19" width="8" height="8" rx="1" fill="var(--red)" opacity="0.85" transform="rotate(-8 10 23)"/><rect x="17.5" y="20.5" width="8" height="6.5" rx="1" fill="var(--red)" opacity="0.6" transform="rotate(10 21 24)"/>`),
}

/** The picture for an entry: its inline drawing, or the emoji itself. */
export function iconHtml(icon: string): string {
  if (icon.startsWith('svg:')) return LEGEND_SVG[icon.slice(4)] ?? ''
  return `<span class="emoji" aria-hidden="true">${icon}</span>`
}
