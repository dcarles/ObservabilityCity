// Where the boxes of the diagram stand and how the lines run between them, as plain numbers. Callers sit to the left of what they call, the order in each column
// is chosen to cross as few lines as it can, and the third parties stand together in the last column. The search is seeded from the boxes' ids, so the same town
// always gets the same picture, and it runs once: a later snapshot only recolours, and a viewer hiding a pillar only makes its box disappear.

import type { ArchBox } from './model'

export interface Placed { id: string; x: number; y: number; w: number; h: number }
export interface Frame { id: 'vendors' | 'shared'; x: number; y: number; w: number; h: number }

export interface Layout {
  width: number
  height: number
  boxes: Map<string, Placed>
  frames: Frame[]
  /** The left edge of each column of boxes, for the lines that pass between them. */
  columns: number[]
}

export const BOX_W = 210
export const BOX_H = 120
export const VENDOR_H = 96
const GAP_X = 90
const GAP_Y = 30
const MARGIN = 30
const SHARED_GAP = 40
const FRAME_TOP = 46

type Slim = Pick<ArchBox, 'id' | 'kind'>
interface Pair { from: string; to: string }

/** A small seeded random generator (mulberry32), so the same input always gives the same picture. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

const sizeOf = (kind: Slim['kind']): { w: number; h: number } => (kind === 'vendor' ? { w: BOX_W, h: VENDOR_H } : { w: BOX_W, h: BOX_H })

/** Each box's column, from the direction of the calls: callers left, callees right, and a call that would go backwards is ignored (the search pays for it). */
export function layers(ids: readonly string[], pairs: readonly Pair[]): Map<string, number> {
  const out = new Map<string, string[]>(ids.map((i) => [i, []]))
  for (const p of pairs) if (out.has(p.from) && out.has(p.to) && p.from !== p.to) out.get(p.from)!.push(p.to)
  const state = new Map<string, 0 | 1 | 2>()
  const forward: Pair[] = []
  const visit = (id: string): void => {
    state.set(id, 1)
    for (const to of [...out.get(id)!].sort()) {
      if (state.get(to) === 1) continue // a call back up the chain: left out
      forward.push({ from: id, to })
      if (!state.has(to)) visit(to)
    }
    state.set(id, 2)
  }
  for (const id of [...ids].sort()) if (!state.has(id)) visit(id)
  const layer = new Map(ids.map((i) => [i, 0]))
  for (let again = true, guard = 0; again && guard < ids.length + 2; guard++) {
    again = false
    for (const p of forward) if (layer.get(p.to)! < layer.get(p.from)! + 1) { layer.set(p.to, layer.get(p.from)! + 1); again = true }
  }
  return layer
}

interface Plan { cols: string[][] }

function coordinates(plan: Plan, ids: Map<string, Slim>): Map<string, { cx: number; cy: number }> {
  const heights = plan.cols.map((c) => c.reduce((a, id) => a + sizeOf(ids.get(id)!.kind).h + GAP_Y, -GAP_Y))
  const tallest = Math.max(0, ...heights)
  const at = new Map<string, { cx: number; cy: number }>()
  plan.cols.forEach((col, ci) => {
    let y = (tallest - heights[ci]) / 2
    for (const id of col) {
      const { h } = sizeOf(ids.get(id)!.kind)
      at.set(id, { cx: ci * (BOX_W + GAP_X) + BOX_W / 2, cy: y + h / 2 })
      y += h + GAP_Y
    }
  })
  return at
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))

function cross(a: { cx: number; cy: number }, b: { cx: number; cy: number }, c: { cx: number; cy: number }, d: { cx: number; cy: number }): boolean {
  return orient(a.cx, a.cy, b.cx, b.cy, c.cx, c.cy) * orient(a.cx, a.cy, b.cx, b.cy, d.cx, d.cy) < 0 && orient(c.cx, c.cy, d.cx, d.cy, a.cx, a.cy) * orient(c.cx, c.cy, d.cx, d.cy, b.cx, b.cy) < 0
}

/** What a picture costs: every crossing of two lines, every call that runs backwards, every column a line skips, and the height of the lines. */
export function cost(plan: Plan, ids: Map<string, Slim>, pairs: readonly Pair[]): number {
  const at = coordinates(plan, ids)
  const colOf = new Map<string, number>()
  plan.cols.forEach((c, i) => c.forEach((id) => colOf.set(id, i)))
  let total = 0
  const lines = pairs.filter((p) => at.has(p.from) && at.has(p.to))
  for (const p of lines) {
    const d = colOf.get(p.to)! - colOf.get(p.from)!
    if (d <= 0) total += 6 + Math.abs(d) // backwards
    else total += d - 1
    total += Math.abs(at.get(p.from)!.cy - at.get(p.to)!.cy) / 400
  }
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[i]
      const q = lines[j]
      if (p.from === q.from || p.from === q.to || p.to === q.from || p.to === q.to) continue
      if (cross(at.get(p.from)!, at.get(p.to)!, at.get(q.from)!, at.get(q.to)!)) total += 10
    }
  }
  // a picture much taller than wide needs zooming out to see it all: the tallest column should not be far above the width of the columns
  const heights = plan.cols.map((c) => c.reduce((a, id) => a + sizeOf(ids.get(id)!.kind).h + GAP_Y, -GAP_Y))
  const widthPx = plan.cols.length * (BOX_W + GAP_X) - GAP_X
  total += Math.max(0, Math.max(0, ...heights) - widthPx * 0.55) / 12
  // a very tall column makes a poor picture
  const cap = Math.ceil(ids.size / Math.max(1, plan.cols.length)) + 2
  for (const c of plan.cols) total += Math.max(0, c.length - cap) * 4
  return total
}

/** One search for the best order with this many columns for the pillars and internal services (third parties go in one more at the end). */
function search(main: readonly string[], vendors: readonly string[], boxes: readonly Slim[], pairs: readonly Pair[], count: number): { cols: string[][]; cost: number } {
  const ids = new Map(boxes.map((b) => [b.id, b]))
  const layer = layers(main, pairs)
  const cols: string[][] = Array.from({ length: count }, () => [])
  for (const id of main) cols[Math.min(count - 1, layer.get(id)!)].push(id)
  // a town with few calls between its pillars would otherwise start as one tall column: spill the overflow into the columns on its right
  const room = Math.ceil(main.length / count)
  for (let ci = 0; ci < count; ci++) {
    while (cols[ci].length > room) {
      const to = cols.slice(ci + 1, count).findIndex((c) => c.length < room)
      if (to < 0) break
      cols[ci + 1 + to].push(cols[ci].pop()!)
    }
  }
  if (vendors.length) cols.push([...vendors])
  const plan: Plan = { cols }
  let now = cost(plan, ids, pairs)
  if (main.length + vendors.length < 3 || cols.length < 2) return { cols: cols.filter((c) => c.length > 0), cost: now }

  const rnd = random(hash([...main, '|', ...vendors, '|', count, '|', ...pairs.map((p) => `${p.from}>${p.to}`).sort()].join(',')))
  let best = now
  let bestCols = cols.map((c) => [...c])
  const rounds = Math.min(14000, 1500 + main.length * 500)
  for (let i = 0; i < rounds; i++) {
    const temp = 3 * (1 - i / rounds) + 0.02
    const ci = Math.floor(rnd() * plan.cols.length)
    const col = plan.cols[ci]
    if (col.length === 0) continue
    const from = Math.floor(rnd() * col.length)
    const isVendor = ids.get(col[from])!.kind === 'vendor'
    const wide = !isVendor && rnd() < 0.35 // sometimes to another column
    const tj = wide ? Math.floor(rnd() * count) : ci
    const target = plan.cols[tj]
    const [id] = col.splice(from, 1)
    const ins = Math.floor(rnd() * (target.length + 1))
    if (tj === ci && ins === from) { col.splice(from, 0, id); continue }
    target.splice(ins, 0, id)
    const next = cost(plan, ids, pairs)
    if (next <= now || rnd() < Math.exp((now - next) / temp)) {
      now = next
      if (now < best) { best = now; bestCols = plan.cols.map((c) => [...c]) }
    } else {
      target.splice(ins, 1)
      col.splice(from, 0, id)
    }
  }
  return { cols: bestCols.filter((c) => c.length > 0), cost: best }
}

/**
 * The columns of boxes for the pillars and the internal services, plus the third parties in the last one. A town of many pillars is tried with a few
 * different numbers of columns and the picture with the fewest crossings wins, so no fixed width is assumed.
 */
export function arrange(boxes: readonly Slim[], pairs: readonly Pair[]): string[][] {
  const main = boxes.filter((b) => b.kind === 'pillar' || b.kind === 'internal' || b.kind === 'service' || b.kind === 'system').map((b) => b.id).sort()
  const vendors = boxes.filter((b) => b.kind === 'vendor').map((b) => b.id).sort()
  if (main.length === 0) return vendors.length ? [vendors] : []
  const base = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(main.length) * 1.1)))
  const counts = main.length < 6 ? [base] : [...new Set([base - 1, base, base + 1, base + 2, base + 3].map((n) => Math.max(2, Math.min(8, n))))]
  let best: { cols: string[][]; cost: number } | null = null
  for (const n of [...counts].sort((a, b) => Math.abs(a - base) - Math.abs(b - base) || b - a)) {
    const r = search(main, vendors, boxes, pairs, n)
    if (!best || r.cost < best.cost - 1e-9) best = r
  }
  return best!.cols
}

/** Where every box stands. `known` is the picture drawn before: if it already has every box, it is kept, so hiding a pillar never moves the others. */
export function layoutBoxes(boxes: readonly Slim[], pairs: readonly Pair[], known: Layout | null = null): Layout {
  if (known && boxes.every((b) => known.boxes.has(b.id))) return known
  const ids = new Map(boxes.map((b) => [b.id, b]))
  const cols = arrange(boxes, pairs)
  const shared = boxes.filter((b) => b.kind === 'shared').map((b) => b.id).sort()
  const at = coordinates({ cols }, ids)
  const placed = new Map<string, Placed>()

  // the shared systems stand in a frame along the top, as many to a row as the diagram is wide
  const mainW = Math.max(1, cols.length) * (BOX_W + GAP_X) - GAP_X + MARGIN * 2
  const perRow = Math.max(3, Math.floor((mainW - MARGIN * 2 + SHARED_GAP) / (BOX_W + SHARED_GAP)))
  const sharedRows = Math.ceil(shared.length / perRow)
  const sharedH = shared.length ? FRAME_TOP + sharedRows * (BOX_H + 20) : 0
  const top = shared.length ? sharedH + 30 : MARGIN

  const frames: Frame[] = []
  let width = mainW
  shared.forEach((id, i) => {
    placed.set(id, { id, x: MARGIN + (i % perRow) * (BOX_W + SHARED_GAP), y: 6 + FRAME_TOP - 8 + Math.floor(i / perRow) * (BOX_H + 20), w: BOX_W, h: BOX_H })
  })
  const colX: number[] = []
  let bottom = top
  cols.forEach((col, ci) => {
    const x = MARGIN + ci * (BOX_W + GAP_X)
    colX.push(x)
    const vendorCol = col.length > 0 && ids.get(col[0])!.kind === 'vendor'
    for (const id of col) {
      const { w, h } = sizeOf(ids.get(id)!.kind)
      const y = top + at.get(id)!.cy - h / 2 + (vendorCol ? FRAME_TOP - 20 : 0)
      placed.set(id, { id, x, y, w, h })
      bottom = Math.max(bottom, y + h)
    }
  })
  const vendors = cols.length && ids.get(cols[cols.length - 1][0])!.kind === 'vendor' ? cols[cols.length - 1] : []
  if (vendors.length) {
    const ps = vendors.map((id) => placed.get(id)!)
    const y0 = Math.min(...ps.map((p) => p.y)) - FRAME_TOP
    const y1 = Math.max(...ps.map((p) => p.y + p.h)) + 20
    frames.push({ id: 'vendors', x: colX[colX.length - 1] - 20, y: Math.max(top - 10, y0), w: BOX_W + 40, h: y1 - Math.max(top - 10, y0) })
    bottom = Math.max(bottom, y1)
  }
  if (shared.length) frames.unshift({ id: 'shared', x: 10, y: 6, w: Math.max(mainW, width) - 20, h: sharedH })
  width = Math.max(width, vendors.length ? colX[colX.length - 1] + BOX_W + 20 + MARGIN : 0)
  const w = Math.max(mainW, width)
  if (shared.length) frames.find((f) => f.id === 'shared')!.w = w - 20
  return { width: w, height: bottom + MARGIN, boxes: placed, frames, columns: colX }
}

export type LineStyle = 'elbow' | 'curve'

/** The points a line that skips columns passes through: the free gap between the boxes of each column it crosses, nearest to a straight line. */
function via(layout: Layout, visible: ReadonlySet<string>, a: Placed, b: Placed, ay: number, by: number): [number, number][] {
  const ax = a.x + a.w
  const bx = b.x
  const pts: [number, number][] = []
  for (const c of layout.columns.filter((x) => x > a.x && x < b.x)) {
    const inColumn = [...layout.boxes.values()].filter((q) => q.x === c && visible.has(q.id) && !q.id.startsWith('shared:'))
    const cx = c + BOX_W / 2
    const t = (cx - ax) / (bx - ax)
    const yt = ay + (by - ay) * t
    const blocks = inColumn.map((q) => [q.y - 14, q.y + q.h + 14] as const).sort((p, q) => p[0] - q[0])
    const free: [number, number][] = []
    let last = -1e9
    for (const [y0, y1] of blocks) { free.push([last, y0]); last = y1 }
    free.push([last, 1e9])
    let best = yt
    let d = Infinity
    for (const [y0, y1] of free.filter(([lo, hi]) => hi - lo >= 10)) {
      const y = Math.min(Math.max(yt, y0 + 5), y1 - 5)
      if (Math.abs(y - yt) < d) { d = Math.abs(y - yt); best = y }
    }
    pts.push([cx, best])
  }
  return pts
}

/** A spot along a box's side for the nth of n lines, so lines meeting one box do not all leave and arrive at the same point. */
function spread(p: Placed, n: number, i: number): number {
  const step = n > 1 ? Math.min(10, (p.h - 44) / (n - 1)) : 0
  return p.y + p.h / 2 + (i - (n - 1) / 2) * step
}

/**
 * The path of every line, in the diagram's own units, keyed "from>to". Lines go left to right through the free gaps between boxes; each line has its own
 * place on the side of a box and its own upright lane in the gap, so lines side by side stay apart. A call that goes back leaves from the bottom or top.
 */
export function routeAll(layout: Layout, visible: ReadonlySet<string>, edges: readonly Pair[], style: LineStyle): Map<string, string> {
  const live = edges.filter((e) => layout.boxes.has(e.from) && layout.boxes.has(e.to))
  const cy = (id: string): number => { const p = layout.boxes.get(id)!; return p.y + p.h / 2 }
  const outs = new Map<string, Pair[]>()
  const ins = new Map<string, Pair[]>()
  for (const e of live) {
    ;(outs.get(e.from) ?? outs.set(e.from, []).get(e.from)!).push(e)
    ;(ins.get(e.to) ?? ins.set(e.to, []).get(e.to)!).push(e)
  }
  for (const list of outs.values()) list.sort((p, q) => cy(p.to) - cy(q.to) || p.to.localeCompare(q.to))
  for (const list of ins.values()) list.sort((p, q) => cy(p.from) - cy(q.from) || p.from.localeCompare(q.from))
  const order = new Map(live.map((e, i) => [e, i]))
  const lane = (e: Pair): number => order.get(e)!
  const out = new Map<string, string>()
  for (const e of live) {
    const a = layout.boxes.get(e.from)!
    const b = layout.boxes.get(e.to)!
    const mine = outs.get(e.from)!
    const theirs = ins.get(e.to)!
    const oi = mine.indexOf(e)
    const ii = theirs.indexOf(e)
    const ax = a.x + a.w
    const ay = spread(a, mine.length, oi)
    const by = spread(b, theirs.length, ii)
    let d: string
    if (ax <= b.x) {
      const pts: [number, number][] = [[ax, ay], ...via(layout, visible, a, b, ay, by), [b.x, by]]
      d = `M${ax} ${ay}`
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = pts[i - 1]
        const [qx, qy] = pts[i]
        if (style === 'elbow') {
          // the first upright stands close to the box the line leaves, in a lane of its own; the others halfway
          const mx = i === 1 ? px + 18 + (oi % 6) * 8 : i === pts.length - 1 ? qx - 18 - (ii % 6) * 8 : (px + qx) / 2
          d += `H${mx}V${qy}H${qx}`
        } else { const dx = (qx - px) * 0.5; d += `C${px + dx} ${py},${qx - dx} ${qy},${qx} ${qy}` }
      }
    } else if (b.x === a.x) {
      // a call between two boxes of one column goes out of the right side and back into the right side, in the gap beside the column, never over a box
      const gx = a.x + a.w + 16 + (lane(e) % 6) * 8
      const sy = a.y + a.h / 2 + (oi - (mine.length - 1) / 2) * 8
      const ey = b.y + b.h / 2 + (ii - (theirs.length - 1) / 2) * 8
      d = style === 'elbow' ? `M${ax} ${sy}H${gx}V${ey}H${b.x + b.w}` : `M${ax} ${sy}C${gx + 30} ${sy},${gx + 30} ${ey},${b.x + b.w} ${ey}`
    } else {
      // a call that goes back to an earlier column leaves the left side and comes in on the right side of the box it calls, through the free gaps in between
      const lx = a.x
      const rx = b.x + b.w
      const pts: [number, number][] = [[lx, ay], ...via(layout, visible, b, a, by, ay).reverse(), [rx, by]]
      d = `M${lx} ${ay}`
      for (let i = 1; i < pts.length; i++) {
        const [px, py] = pts[i - 1]
        const [qx, qy] = pts[i]
        if (style === 'elbow') {
          const mx = i === 1 ? px - 18 - (lane(e) % 6) * 8 : i === pts.length - 1 ? qx + 18 + (lane(e) % 6) * 8 : (px + qx) / 2
          d += `H${mx}V${qy}H${qx}`
        } else { const dx = (qx - px) * 0.5; d += `C${px + dx} ${py},${qx - dx} ${qy},${qx} ${qy}` }
      }
    }
    out.set(`${e.from}>${e.to}`, d)
  }
  return out
}

/** How many pairs of lines cross in a layout (straight lines between box centres). For tests and for judging a picture. */
export function crossings(layout: Layout, pairs: readonly Pair[]): number {
  const at = (id: string) => { const p = layout.boxes.get(id)!; return { cx: p.x + p.w / 2, cy: p.y + p.h / 2 } }
  const lines = pairs.filter((p) => layout.boxes.has(p.from) && layout.boxes.has(p.to) && !p.from.startsWith('shared:') && !p.to.startsWith('shared:'))
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[i]
      const q = lines[j]
      if (p.from === q.from || p.from === q.to || p.to === q.from || p.to === q.to) continue
      if (cross(at(p.from), at(p.to), at(q.from), at(q.to))) n++
    }
  }
  return n
}
