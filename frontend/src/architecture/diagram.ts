// The diagram itself: an SVG built from the model and the layout, kept as it is while the snapshots come in. A new snapshot changes only what is different
// (a box's colour and numbers, a line's colour and width), so the viewer's zoom, selection and the open drawer stay where they are.

import { between, ease, fitView, matchScreen, pointAt, scaleOf, zoomAbout, panBy, type View } from './camera'
import { routeAll, type Layout, type LineStyle } from './layout'
import type { ArchBox, ArchEdge, Architecture } from './model'
import type { Level } from '../dashboard/model'

const NS = 'http://www.w3.org/2000/svg'

export interface DiagramOptions {
  /** A tint, B solid, C outline. */
  box: 'A' | 'B' | 'C'
  line: LineStyle
  /** The pillar's own colour as a stripe on its box. */
  stripe: boolean
  /** Lines take the calling pillar's colour, or the health colour of the worse end. */
  colour: 'pillar' | 'health'
  /** Lines stay grey until one of their boxes is picked (red and amber ones keep their colour). */
  quiet: boolean
  /** A thicker line for more traffic. */
  width: boolean
}

export const DEFAULT_OPTIONS: DiagramOptions = { box: 'A', line: 'elbow', stripe: true, colour: 'pillar', quiet: false, width: true }

export interface DiagramHost {
  /** A box was tapped (null: empty space). */
  select(box: ArchBox | null): void
  /** The box stands for one system: open its drawer. */
  open(box: ArchBox): void
}

const COLOR: Record<Level, string> = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', none: 'var(--stale)' }
const TINT: Record<Level, string> = { ok: 'var(--okbg)', warn: 'var(--warnbg)', bad: 'var(--badbg)', none: 'var(--stalebg)' }
const STATE_TEXT: Record<Level, string> = { ok: 'all healthy', warn: 'degraded', bad: 'down', none: 'no fresh data' }

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, name)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  parent?.appendChild(e)
  return e
}

/** A rate for a chip: 842, 12.5, 1.2k. A rate nobody measures is a dash. */
export function rate(v: number | null | undefined): string {
  if (v == null) return '–'
  if (v >= 10000) return `${Math.round(v / 1000)}k`
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return v < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v))
}

/** Cuts a name to the width of the box, with an ellipsis. */
export const fitName = (name: string, max = 21): string => (name.length > max ? `${name.slice(0, max - 1)}…` : name)

export class Diagram {
  private readonly scene: SVGGElement
  private readonly frames: SVGGElement
  private readonly lines: SVGGElement
  private readonly boxes: SVGGElement
  private view: View = { x: 0, y: 0, w: 1200, h: 800 }
  private touched = false
  private layout: Layout | null = null
  private arch: Architecture | null = null
  private options: DiagramOptions = DEFAULT_OPTIONS
  private selected: string | null = null
  private hovered: string | null = null
  private visible = new Set<string>()
  private readonly boxSig = new Map<string, string>()
  private readonly lineSig = new Map<string, string>()
  private anim = 0
  private moved = 0

  constructor(private readonly svg: SVGSVGElement, private readonly host: DiagramHost) {
    svg.innerHTML = ''
    const defs = el('defs', {}, svg)
    const marker = el('marker', { id: 'arch-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: 'userSpaceOnUse', orient: 'auto' }, defs)
    el('path', { d: 'M0 0L10 5L0 10z', fill: 'context-stroke' }, marker)
    this.scene = el('g', { class: 'scene' }, svg)
    this.frames = el('g', {}, this.scene)
    this.lines = el('g', {}, this.scene)
    this.boxes = el('g', {}, this.scene)
    this.pointer()
    window.addEventListener('resize', () => { if (!this.touched) this.setView(this.fit()); else this.setView(this.view) })
  }

  /** For tests: where the view is, and the boxes and lines on screen. */
  state(): { view: View; selected: string | null; boxes: string[]; lines: string[]; touched: boolean } {
    return { view: this.view, selected: this.selected, boxes: [...this.visible], lines: [...this.lineSig.keys()], touched: this.touched }
  }

  get selection(): string | null { return this.selected }

  setOptions(o: DiagramOptions): void {
    this.options = o
    this.boxSig.clear()
    this.lineSig.clear()
    if (this.arch && this.layout) this.update(this.arch, this.layout)
  }

  update(arch: Architecture, layout: Layout): void {
    const first = this.layout === null
    this.arch = arch
    this.layout = layout
    this.visible = new Set(arch.boxes.map((b) => b.id))
    if (this.selected && !this.visible.has(this.selected)) this.selected = null
    this.drawFrames(arch, layout)
    this.drawLines(arch, layout)
    this.drawBoxes(arch, layout)
    this.highlight()
    if (first) this.setView(this.fit())
  }

  // ---- drawing -------------------------------------------------------------------------------------------------

  private drawFrames(arch: Architecture, layout: Layout): void {
    this.frames.replaceChildren()
    for (const f of layout.frames) {
      const kind = f.id === 'vendors' ? 'vendor' : 'shared'
      if (!arch.boxes.some((b) => b.kind === kind)) continue
      el('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 14, fill: 'none', stroke: 'var(--edge)', 'stroke-width': 1.5, 'stroke-dasharray': '8 6', class: 'frame', 'data-frame': f.id }, this.frames)
      const t = el('text', { x: f.x + 16, y: f.y + 26, class: 'frame-label' }, this.frames)
      t.textContent = (f.id === 'vendors' ? arch.vendorsLabel : 'Shared platform systems').toUpperCase()
    }
  }

  private widthOf(e: ArchEdge): number {
    return this.options.width ? 1.5 + Math.sqrt(Math.max(0, e.rps ?? 0)) / 12 : 2
  }

  private drawLines(arch: Architecture, layout: Layout): void {
    const keep = new Set<string>()
    const paths = routeAll(layout, this.visible, arch.edges, this.options.line)
    for (const e of arch.edges) {
      const key = `${e.from}>${e.to}`
      const d = paths.get(key)
      if (!d) continue
      keep.add(key)
      const sig = `${d}|${e.level}|${e.color}|${this.widthOf(e)}`
      let p = this.lines.querySelector<SVGPathElement>(`[data-edge="${CSS.escape(key)}"]`)
      if (!p) p = el('path', { 'data-edge': key, 'data-a': e.from, 'data-b': e.to, 'marker-end': 'url(#arch-arrow)' }, this.lines)
      if (this.lineSig.get(key) === sig) continue
      this.lineSig.set(key, sig)
      p.setAttribute('d', d)
      p.setAttribute('stroke-width', String(this.widthOf(e)))
      if (e.color) p.style.setProperty('--line', e.color); else p.style.removeProperty('--line')
      p.setAttribute('class', e.level === 'warn' || e.level === 'bad' ? `edge ${e.level}` : 'edge') // hot and dim are put back by highlight()
    }
    for (const p of [...this.lines.children]) {
      const key = p.getAttribute('data-edge')!
      if (!keep.has(key)) { p.remove(); this.lineSig.delete(key) }
    }
  }

  private drawBoxes(arch: Architecture, layout: Layout): void {
    const keep = new Set<string>()
    for (const b of arch.boxes) {
      const at = layout.boxes.get(b.id)
      if (!at) continue
      keep.add(b.id)
      let g = this.boxes.querySelector<SVGGElement>(`[data-id="${CSS.escape(b.id)}"]`)
      const fresh = !g
      if (!g) g = el('g', { class: 'box', 'data-id': b.id }, this.boxes)
      g.setAttribute('transform', `translate(${at.x},${at.y})`)
      const sig = JSON.stringify([b, at.w, at.h, this.options.box, this.options.stripe])
      if (this.boxSig.get(b.id) !== sig) { this.boxSig.set(b.id, sig); this.drawBox(g, b, at.w, at.h) }
      if (fresh) this.listen(g, b.id)
      g.classList.toggle('internal', b.kind === 'internal')
    }
    for (const g of [...this.boxes.children]) {
      const id = g.getAttribute('data-id')!
      if (!keep.has(id)) { g.remove(); this.boxSig.delete(id) }
    }
  }

  private drawBox(g: SVGGElement, b: ArchBox, w: number, h: number): void {
    g.replaceChildren()
    const o = this.options
    const c = COLOR[b.level]
    const solid = o.box === 'B'
    el('title', {}, g).textContent = `${b.name}: ${b.reason ?? STATE_TEXT[b.level]}`
    const fill = solid ? c : o.box === 'A' ? TINT[b.level] : 'var(--surface)'
    const stroke = o.box === 'C' || solid ? c : 'var(--line)'
    const shape = el('rect', { class: 'shape', width: w, height: h, rx: 10, fill, stroke, 'stroke-width': o.box === 'C' ? 2.5 : 1.5 }, g)
    if (b.kind === 'internal') shape.setAttribute('stroke-dasharray', '7 4')
    if (o.box === 'A') el('rect', { x: 0, y: 0, width: 6, height: h, rx: 3, fill: c }, g)
    const striped = o.stripe && !!b.color && !solid
    if (striped) el('path', { d: `M10 0H${w - 10}a10 10 0 0 1 10 10v1H0v-1A10 10 0 0 1 10 0z`, fill: b.color! }, g)
    const px = o.box === 'A' ? 18 : 14
    const ty = striped ? 32 : 28
    const text = (value: string, cls: string, x: number, y: number, anchor = 'start'): SVGTextElement => {
      const t = el('text', { class: cls, x, y, 'text-anchor': anchor }, g)
      t.textContent = value
      if (solid) t.setAttribute('style', 'fill:#fff')
      return t
    }
    text(fitName(b.name), 't', px, ty)
    text(b.sub, 's', px, ty + 20)
    const chip = (x: number, y: number, label: string, kind: '' | 'dlq warn' | 'dlq bad'): number => {
      const cw = label.length * 6.4 + 14
      const cg = el('g', { class: kind }, g)
      const r = el('rect', { x, y, width: cw, height: 18, rx: 9, 'stroke-width': 1 }, cg)
      const t = el('text', { x: x + cw / 2, y: y + 13, 'text-anchor': 'middle', class: 'chip-text' }, cg)
      t.textContent = label
      if (solid && !kind) { r.setAttribute('fill', 'rgba(255,255,255,.22)'); r.setAttribute('stroke', 'rgba(255,255,255,.5)'); t.setAttribute('fill', '#fff') } else if (!kind) { r.setAttribute('class', 'chipbg'); t.setAttribute('class', 'chip-text chiptx') }
      return cw
    }
    if (b.traffic || b.msg) {
      let x = px
      if (b.traffic) x += chip(x, ty + 32, `⇄ ↑${rate(b.traffic.out)} ↓${rate(b.traffic.in)}`, '') + 6
      if (b.msg) chip(x, ty + 32, `✉ ↑${rate(b.msg.out)} ↓${rate(b.msg.in)}`, '')
    } else if (b.figure) text(b.figure, 'm', w - 14, ty + 20, 'end')
    if (b.dlq > 0) chip(w - 12 - (`DLQ ${rate(b.dlq)}`.length * 6.4 + 14), ty - 20, `DLQ ${rate(b.dlq)}`, b.dlq >= 10 ? 'dlq bad' : 'dlq warn')
    // the state, as words, bottom left
    const label = b.reason ?? STATE_TEXT[b.level]
    const bw = label.length * 6.4 + 26
    const bx = px - 4
    const by = h - 30
    el('rect', { x: bx, y: by, width: bw, height: 20, rx: 10, fill: solid ? 'rgba(255,255,255,.22)' : TINT[b.level], stroke: solid ? 'none' : c, 'stroke-width': 1 }, g)
    el('circle', { cx: bx + 11, cy: by + 10, r: 4, fill: solid ? '#fff' : c }, g)
    const lt = el('text', { x: bx + 20, y: by + 14, class: 'state-text', fill: solid ? '#fff' : c }, g)
    lt.textContent = label
  }

  // ---- picking ---------------------------------------------------------------------------------------------------

  private listen(g: SVGGElement, id: string): void {
    g.addEventListener('mouseenter', () => { this.hovered = id; this.highlight() })
    g.addEventListener('mouseleave', () => { this.hovered = null; this.highlight() })
    g.addEventListener('click', (e) => {
      if (this.moved > 12) return
      e.stopPropagation()
      const box = this.arch?.boxes.find((b) => b.id === id)
      if (box) this.tap(box)
    })
  }

  /** A tap picks a box and lights up its lines; a box that is one system also opens its drawer. A second tap on the same box lets go of it. */
  private tap(box: ArchBox): void {
    if (box.nodeId) {
      this.pick(box.id)
      this.host.open(box)
      return
    }
    this.pick(this.selected === box.id ? null : box.id)
  }

  pick(id: string | null): void {
    this.selected = id
    this.highlight()
    this.host.select(id ? this.arch?.boxes.find((b) => b.id === id) ?? null : null)
  }

  private highlight(): void {
    const id = this.hovered ?? this.selected
    for (const p of this.lines.querySelectorAll<SVGPathElement>('.edge')) {
      const on = !id || p.dataset.a === id || p.dataset.b === id
      p.classList.toggle('hot', !!id && on)
      p.classList.toggle('dim', !on)
    }
    const near = new Set<string>()
    if (id) for (const p of this.lines.querySelectorAll<SVGPathElement>('.edge.hot')) { near.add(p.dataset.a!); near.add(p.dataset.b!) }
    for (const g of this.boxes.querySelectorAll<SVGGElement>('.box')) {
      const bid = g.dataset.id!
      g.classList.toggle('dim', !!id && bid !== id && !near.has(bid))
      g.classList.toggle('isel', bid === this.selected)
      g.querySelector('.shape')?.setAttribute('stroke-width', bid === this.selected ? '3.5' : this.options.box === 'C' ? '2.5' : '1.5')
    }
    this.svg.classList.toggle('quiet', this.options.quiet)
    this.svg.classList.toggle('byhealth', this.options.colour === 'health')
  }

  // ---- the view ----------------------------------------------------------------------------------------------------

  private size(): { w: number; h: number } {
    const r = this.svg.getBoundingClientRect()
    return { w: r.width || this.svg.clientWidth || 1, h: r.height || this.svg.clientHeight || 1 }
  }

  private fit(): View {
    const { w, h } = this.size()
    return fitView(this.layout?.width ?? 1200, this.layout?.height ?? 800, w, h)
  }

  private setView(v: View): void {
    this.view = v
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`)
    this.svg.dataset.scale = scaleOf(v, this.size().w).toFixed(3)
  }

  private animate(to: View, ms: number): void {
    cancelAnimationFrame(this.anim)
    const from = { ...this.view }
    const t0 = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / ms)
      this.setView(between(from, to, ease(t)))
      if (t < 1) this.anim = requestAnimationFrame(step)
    }
    this.anim = requestAnimationFrame(step)
  }

  zoom(factor: number, sx?: number, sy?: number, smooth = false): void {
    const { w, h } = this.size()
    const p = pointAt(this.view, sx ?? w / 2, sy ?? h / 2, w, h)
    this.touched = true
    const next = zoomAbout(this.view, factor, p.x, p.y, w)
    if (smooth) this.animate(next, 200)
    else this.setView(next)
  }

  home(): void {
    this.touched = false
    this.animate(this.fit(), 300)
  }

  /** The box in the middle of the screen, close up. For the Open button and for tests. */
  focus(id: string): void {
    const at = this.layout?.boxes.get(id)
    if (!at) return
    const { w, h } = this.size()
    this.touched = true
    this.animate(matchScreen({ x: at.x - at.w * 0.6, y: at.y - at.h * 0.6, w: at.w * 2.2, h: at.h * 2.2 }, w, h), 450)
  }

  private pointer(): void {
    const svg = this.svg
    const points = new Map<number, { x: number; y: number }>()
    let drag: { x: number; y: number; v: View; id: number } | null = null
    let pinch: number | null = null
    const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    svg.addEventListener('pointerdown', (e) => {
      points.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (points.size === 2) { const [p, q] = [...points.values()]; pinch = Math.hypot(p.x - q.x, p.y - q.y); drag = null; this.moved = 99; return }
      drag = { x: e.clientX, y: e.clientY, v: { ...this.view }, id: e.pointerId }
      this.moved = 0
    })
    svg.addEventListener('pointermove', (e) => {
      if (points.has(e.pointerId)) points.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (points.size === 2 && pinch) {
        const [p, q] = [...points.values()]
        const d = Math.hypot(p.x - q.x, p.y - q.y)
        const c = local({ clientX: (p.x + q.x) / 2, clientY: (p.y + q.y) / 2 })
        this.zoom(d / pinch, c.x, c.y)
        pinch = d
        return
      }
      if (!drag) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      this.moved = Math.max(this.moved, Math.hypot(dx, dy))
      if (this.moved > 12) {
        if (!svg.classList.contains('drag')) { svg.classList.add('drag'); try { svg.setPointerCapture(drag.id) } catch { /* the pointer is gone */ } }
        this.touched = true
        this.setView(panBy(drag.v, dx, dy, this.size().w))
      }
    })
    const end = (e: PointerEvent): void => {
      points.delete(e.pointerId)
      if (points.size < 2) pinch = null
      if (points.size === 0) { drag = null; svg.classList.remove('drag'); setTimeout(() => { this.moved = 0 }, 50) }
    }
    svg.addEventListener('pointerup', end)
    svg.addEventListener('pointercancel', end)
    svg.addEventListener('click', (e) => { if (!(e.target as Element).closest('.box') && this.moved <= 12 && this.selected) this.pick(null) })
    svg.addEventListener('wheel', (e) => { e.preventDefault(); const l = local(e); this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, l.x, l.y) }, { passive: false })
  }
}
