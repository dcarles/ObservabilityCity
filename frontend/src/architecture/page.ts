// The architecture view's page: the totals along the top, the diagram, its zoom buttons, the options and the bar that names the picked box. The menu above (view,
// environment, tenants, pillars, theme, feed) is the dashboard's own, so both views filter and look the same; dashboard.ts hands each snapshot to this page.

import './architecture.css'
import type { Inspector } from '../inspector'
import type { Store } from '../lighting'
import type { Snapshot } from '../types'
import type { TenantView } from '../tenants'
import { summaryHtml } from '../dashboard/render'
import { dashLegendHtml, type DashLegendLine } from '../dashboard/legend'
import type { Dashboard } from '../dashboard/model'
import { Diagram, DEFAULT_OPTIONS, type DiagramOptions } from './diagram'
import { layoutBoxes, type Layout } from './layout'
import { buildArchitecture, type ArchBox, type Architecture } from './model'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const OPTIONS_KEY = 'oc.archOptions'

const LEGEND: readonly DashLegendLine[] = [
  { id: 'ok', level: 'ok', title: 'Green', text: 'Everything monitored inside is healthy' },
  { id: 'warn', level: 'warn', title: 'Amber', text: 'Something inside is degraded, or has dead letters waiting' },
  { id: 'bad', level: 'bad', title: 'Red', text: 'Something inside is down' },
  { id: 'none', level: 'none', title: 'Grey', text: 'Nothing inside is monitored, or no fresh data. Never read as healthy' },
  { id: 'traffic', level: null, title: '⇄ ↑ out ↓ in', text: 'Requests a second a pillar sends to other pillars and takes in from them' },
  { id: 'messages', level: null, title: '✉ ↑ out ↓ in', text: 'Messages a second a pillar sends to other pillars and receives. A dash means nobody measures it' },
  { id: 'dlq', level: null, title: 'DLQ', text: 'Dead letters waiting in the pillar or system' },
  { id: 'frames', level: null, title: 'Dashed frames', text: 'Third-party vendors, and the shared systems every pillar uses. A dashed box is an internal service outside the platform' },
]

export const OPTION_NAMES: { key: keyof DiagramOptions; label: string; choices: [string, string][] }[] = [
  { key: 'box', label: 'Box style', choices: [['A', 'A Tint'], ['B', 'B Solid'], ['C', 'C Outline']] },
  { key: 'line', label: 'Lines', choices: [['curve', 'Curved'], ['elbow', 'Square']] },
  { key: 'stripe', label: 'Pillar colour', choices: [['1', 'Top stripe'], ['0', 'Off']] },
  { key: 'colour', label: 'Line colour', choices: [['pillar', 'Pillar colour'], ['health', 'By health']] },
  { key: 'quiet', label: 'Line visibility', choices: [['0', 'Always'], ['1', 'Quiet until hover']] },
  { key: 'width', label: 'Line width = traffic', choices: [['1', 'On'], ['0', 'Off']] },
]

/** The options as the page keeps them in the browser; anything unreadable is the default. */
export function loadOptions(store: Store | null): DiagramOptions {
  try {
    const raw = JSON.parse(store?.getItem(OPTIONS_KEY) ?? 'null') as Partial<DiagramOptions> | null
    if (!raw) return DEFAULT_OPTIONS
    return {
      box: raw.box === 'B' || raw.box === 'C' ? raw.box : 'A',
      line: raw.line === 'curve' ? 'curve' : 'elbow',
      stripe: raw.stripe !== false,
      colour: raw.colour === 'health' ? 'health' : 'pillar',
      quiet: raw.quiet === true,
      width: raw.width !== false,
    }
  } catch {
    return DEFAULT_OPTIONS
  }
}

export function pickHtml(b: ArchBox): string {
  const parts = [b.sub, b.reason, b.figure].filter(Boolean).map((x) => esc(x!))
  const links = b.links.filter((l) => /^https?:\/\//i.test(l.url)).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a>`).join(' · ')
  return `<div><b>${esc(b.name)}</b><small>${parts.join(' · ')}</small>${links ? `<small class="links">${links}</small>` : ''}</div><button class="x" id="arch-pick-x" aria-label="Clear">×</button>`
}

/** What dashboard.ts needs to host the view. */
export interface PagePlug {
  legend: string
  start(inspector: Inspector, store: Store | null): void
  draw(s: Snapshot, d: Dashboard, view: TenantView): void
  /** What the page adds to `window.dash` for tests. */
  expose(): Record<string, unknown>
}

export function architecturePlug(): PagePlug {
  let diagram: Diagram
  let inspector: Inspector
  let store: Store | null = null
  let options: DiagramOptions = DEFAULT_OPTIONS
  let layout: Layout | null = null
  let arch: Architecture | null = null
  let structure = ''

  const showOptions = (): void => {
    for (const o of OPTION_NAMES) {
      const now = String(options[o.key] === true ? '1' : options[o.key] === false ? '0' : options[o.key])
      document.querySelectorAll<HTMLButtonElement>(`#arch-o-${o.key} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === now)))
    }
  }

  return {
    legend: dashLegendHtml(LEGEND),
    start(insp, st) {
      inspector = insp
      store = st
      options = loadOptions(store)
      $('arch-root').hidden = false
      const pick = $('arch-pick')
      diagram = new Diagram($('arch-svg') as unknown as SVGSVGElement, {
        select: (b) => {
          pick.classList.toggle('on', !!b)
          if (b) pick.innerHTML = pickHtml(b)
        },
        open: (b) => { if (b.nodeId) inspector.open(b.nodeId) },
      })
      diagram.setOptions(options)
      pick.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('#arch-pick-x')) diagram.pick(null) })
      $('arch-zoom-in').addEventListener('click', () => diagram.zoom(1.4, undefined, undefined, true))
      $('arch-zoom-out').addEventListener('click', () => diagram.zoom(1 / 1.4, undefined, undefined, true))
      $('arch-fit').addEventListener('click', () => diagram.home())

      const look = $('arch-look')
      look.querySelector('.body')!.insertAdjacentHTML('beforeend', OPTION_NAMES.map((o) => `<div class="row"><span>${o.label}</span><div class="seg" id="arch-o-${o.key}">${o.choices.map(([v, l]) => `<button data-v="${v}" aria-pressed="false">${l}</button>`).join('')}</div></div>`).join(''))
      showOptions()
      for (const o of OPTION_NAMES) {
        $(`arch-o-${o.key}`).addEventListener('click', (e) => {
          const v = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.v
          if (v === undefined) return
          options = { ...options, [o.key]: o.key === 'stripe' || o.key === 'quiet' || o.key === 'width' ? v === '1' : v } as DiagramOptions
          try { store?.setItem(OPTIONS_KEY, JSON.stringify(options)) } catch { /* storage blocked */ }
          showOptions()
          diagram.setOptions(options)
        })
      }
      const toggle = (min: boolean): void => { look.classList.toggle('min', min); $('arch-look-toggle').setAttribute('aria-expanded', String(!min)) }
      $('arch-look-toggle').addEventListener('click', () => toggle(!look.classList.contains('min')))
      $('arch-look-x').addEventListener('click', () => toggle(true))
      document.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('#arch-look')) toggle(true) })
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && diagram.selection && !document.querySelector('#inspector:not([hidden])')) diagram.pick(null) })
    },
    draw(s, d, view) {
      arch = buildArchitecture(s, view, d)
      $('arch-sum').innerHTML = summaryHtml(arch.dashboard).replace(/id="kpi-/g, 'id="arch-kpi-')
      const slim = arch.boxes.map((b) => ({ id: b.id, kind: b.kind }))
      const key = JSON.stringify([slim.map((b) => b.id).sort(), arch.edges.map((e) => `${e.from}>${e.to}`)])
      if (key !== structure) { structure = key; layout = layoutBoxes(slim, arch.edges, layout) }
      $('arch-empty').hidden = arch.boxes.length > 0
      diagram.update(arch, layout!)
    },
    expose() {
      return {
        architecture: () => arch,
        layout: () => layout,
        diagram: () => diagram.state(),
        pick: (id: string | null) => diagram.pick(id),
        zoom: (f: number) => diagram.zoom(f),
        options: () => options,
      }
    },
  }
}

