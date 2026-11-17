import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildArchitecture, buildPillarArchitecture, buildSystemArchitecture, edgeLevel } from '../../src/architecture/model'
import { arrange, crossings, layers, layoutBoxes, routeAll } from '../../src/architecture/layout'
import { ALL_TENANTS } from '../../src/tenants'
import type { Snapshot } from '../../src/types'

const golden = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}.json`), 'utf8')) as Snapshot

describe('architecture boxes', () => {
  it('has a box for each pillar, each third party and each shared system, and totals that match the dashboard', () => {
    const s = golden('bad-day')
    const a = buildArchitecture(s, ALL_TENANTS)
    expect(a.boxes.filter((b) => b.kind === 'pillar')).toHaveLength(s.groups.filter((g) => !g.isHub).length)
    expect(a.boxes.filter((b) => b.kind === 'vendor' || b.kind === 'internal').length).toBeGreaterThan(0)
    expect(a.boxes.filter((b) => b.kind === 'shared')).toHaveLength(s.groups.find((g) => g.isHub)!.nodes.length)
    expect(a.totals.down).toBe(s.totals.down)
    expect(a.totals.degraded).toBe(s.totals.degraded)
  })

  it('shows a shared resource that is only links as a grey box that carries its links', () => {
    const s = golden('calm')
    const hub = s.groups.find((g) => g.isHub)!
    hub.assets = [{ id: 'la', name: 'Log Analytics', label: 'Log store', shape: 'box', service: null, region: null, group: 'Monitoring', links: [{ name: 'Open in the portal', url: 'https://portal.example.test/la' }] } as never]
    const a = buildArchitecture(s, ALL_TENANTS)
    const box = a.boxes.find((b) => b.name === 'Log Analytics')!
    expect(box.kind).toBe('shared')
    expect(box.level).toBe('none')
    expect(box.nodeId).toBeNull()
    expect(box.links).toEqual([{ name: 'Open in the portal', url: 'https://portal.example.test/la' }])
    expect(a.edges.some((e) => e.from === box.id || e.to === box.id)).toBe(false)
  })

  it('colours a pillar by its worst system and a calm town is all green or grey', () => {
    const calm = buildArchitecture(golden('calm'), ALL_TENANTS)
    expect(calm.boxes.every((b) => b.level === 'ok' || b.level === 'none')).toBe(true)
    const bad = buildArchitecture(golden('bad-day'), ALL_TENANTS)
    expect(bad.boxes.some((b) => b.kind === 'pillar' && b.level === 'bad')).toBe(true)
    const pay = bad.boxes.find((b) => b.id === 'pay')!
    expect(pay.reason).toMatch(/down|degraded/)
  })

  it('a pillar with no system monitored is grey and never counts as healthy', () => {
    const s = golden('calm')
    const g = s.groups.find((x) => !x.isHub)!
    for (const n of g.nodes) n.absent = ['requests', 'errors', 'latency', 'instances', 'cpu', 'memory', 'utilisation', 'throttled', 'backlog', 'deadLetters', 'jobs']
    const box = buildArchitecture(s, ALL_TENANTS).boxes.find((b) => b.id === g.id)!
    expect(box.level).toBe('none')
    expect(box.reason).toBe('no fresh data')
  })

  it('draws a line for a call between two pillars and none for calls inside one pillar or to the shared systems', () => {
    const a = buildArchitecture(golden('bad-day'), ALL_TENANTS)
    expect(a.edges.length).toBeGreaterThan(0)
    for (const e of a.edges) {
      expect(e.from).not.toBe(e.to)
      expect(e.from.startsWith('shared:')).toBe(false)
      expect(e.to.startsWith('shared:')).toBe(false)
      expect(a.boxes.some((b) => b.id === e.from)).toBe(true)
      expect(a.boxes.some((b) => b.id === e.to)).toBe(true)
    }
    expect(new Set(a.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(a.edges.length)
  })

  it('a line carries the colour of the pillar that calls', () => {
    const a = buildArchitecture(golden('bad-day'), ALL_TENANTS)
    const fromPillar = a.edges.filter((e) => a.boxes.find((b) => b.id === e.from)?.kind === 'pillar')
    expect(fromPillar.length).toBeGreaterThan(0)
    for (const e of fromPillar) expect(e.color).toBe(a.boxes.find((b) => b.id === e.from)!.color)
  })

  it('a line is amber or red as soon as one end is, and grey only when both ends have no data', () => {
    expect(edgeLevel('ok', 'bad')).toBe('bad')
    expect(edgeLevel('warn', 'ok')).toBe('warn')
    expect(edgeLevel('none', 'ok')).toBe('ok')
    expect(edgeLevel('none', 'none')).toBe('none')
  })

  it('leaves out a measure nobody takes instead of showing a zero', () => {
    const s = golden('calm')
    for (const g of s.groups) g.flow = undefined
    const a = buildArchitecture(s, ALL_TENANTS)
    expect(a.boxes.filter((b) => b.kind === 'pillar').every((b) => b.msg === null)).toBe(true)
  })
})

describe('the inside of a pillar', () => {
  it('has a box for each service group of the pillar, and every other box closed and joined to it by a line', () => {
    const s = golden('bad-day')
    const whole = buildArchitecture(s, ALL_TENANTS)
    const pillar = whole.dashboard.pillars.find((p) => p.groups.length > 1 && p.id === 'pay') ?? whole.dashboard.pillars.find((p) => p.groups.length > 1)!
    const a = buildPillarArchitecture(s, ALL_TENANTS, pillar.id, whole.dashboard)!
    expect(a.open).toEqual({ id: pillar.id, name: pillar.name })
    expect(a.boxes.filter((b) => b.kind === 'service')).toHaveLength(pillar.groups.length)
    const inside = new Set(a.boxes.filter((b) => b.kind === 'service').map((b) => b.id))
    expect(a.boxes.some((b) => b.kind === 'shared')).toBe(false)
    for (const b of a.boxes.filter((x) => x.kind === 'pillar')) expect(b.closed).toBe(true)
    for (const e of a.edges) expect(inside.has(e.from) || inside.has(e.to), `${e.from}>${e.to}`).toBe(true)
    for (const b of a.boxes.filter((x) => !inside.has(x.id))) expect(a.edges.some((e) => e.from === b.id || e.to === b.id), b.id).toBe(true)
    expect(new Set(a.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(a.edges.length)
  })

  it('draws the lines between two groups of the pillar and takes the pillar colour', () => {
    const s = golden('bad-day')
    for (const p of buildArchitecture(s, ALL_TENANTS).dashboard.pillars) {
      const a = buildPillarArchitecture(s, ALL_TENANTS, p.id)!
      for (const e of a.edges.filter((x) => x.from.startsWith('svc:'))) expect(e.color).toBe(a.boxes.find((b) => b.id === e.from)!.color)
    }
  })

  it('is null for a pillar the town does not show', () => {
    expect(buildPillarArchitecture(golden('calm'), ALL_TENANTS, 'nope')).toBeNull()
  })
})

describe('architecture inside a service group', () => {
  const s = golden('bad-day')
  const whole = buildArchitecture(s, ALL_TENANTS)
  const pillar = whole.dashboard.pillars.find((p) => p.groups.length > 1 && p.groups.some((g) => g.rows.length > 1)) ?? whole.dashboard.pillars[0]
  const group = pillar.groups.find((g) => g.rows.length > 1) ?? pillar.groups[0]

  it('has a box for each system of the group, with the drawer to open, and everything else closed at the edge', () => {
    const a = buildSystemArchitecture(s, ALL_TENANTS, pillar.id, group.key, whole.dashboard)!
    expect(a.openService).toEqual({ id: `${pillar.id}/${group.key}`, name: group.name })
    const systems = a.boxes.filter((b) => b.kind === 'system')
    expect(systems.map((b) => b.nodeId).sort()).toEqual(group.rows.map((r) => r.id).sort())
    for (const b of a.boxes.filter((x) => x.kind === 'service' || x.kind === 'pillar')) expect(b.closed, b.id).toBe(true)
    for (const b of a.boxes.filter((x) => x.kind === 'service')) expect(b.nodeId).toBeNull()
    expect(a.boxes.some((b) => b.id === `svc:${group.key}`)).toBe(false)
    expect(a.boxes.some((b) => b.kind === 'shared')).toBe(false)
  })

  it('draws only lines with a system at one end, and gives every closed box a line', () => {
    const a = buildSystemArchitecture(s, ALL_TENANTS, pillar.id, group.key, whole.dashboard)!
    for (const e of a.edges) expect(e.from.startsWith('sys:') || e.to.startsWith('sys:'), `${e.from}>${e.to}`).toBe(true)
    for (const b of a.boxes.filter((x) => x.kind !== 'system')) expect(a.edges.some((e) => e.from === b.id || e.to === b.id), b.id).toBe(true)
    expect(new Set(a.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(a.edges.length)
  })

  it('is null for a group or a pillar the town does not show', () => {
    expect(buildSystemArchitecture(s, ALL_TENANTS, pillar.id, 'nope')).toBeNull()
    expect(buildSystemArchitecture(s, ALL_TENANTS, 'nope', group.key)).toBeNull()
  })
})

describe('architecture layout', () => {
  const a = buildArchitecture(golden('bad-day'), ALL_TENANTS)
  const slim = a.boxes.map((b) => ({ id: b.id, kind: b.kind }))
  const pairs = a.edges.map((e) => ({ from: e.from, to: e.to }))

  it('puts callers left of what they call, from the call direction', () => {
    const l = layers(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }])
    expect(l.get('a')).toBe(0)
    expect(l.get('b')).toBe(1)
    expect(l.get('c')).toBe(2) // the call back to a is left out
  })

  it('is the same picture every time for the same town', () => {
    const one = layoutBoxes(slim, pairs)
    const two = layoutBoxes(slim, pairs)
    expect([...one.boxes.values()]).toEqual([...two.boxes.values()])
  })

  it('stands every box somewhere, with no two boxes overlapping', () => {
    const l = layoutBoxes(slim, pairs)
    expect(l.boxes.size).toBe(slim.length)
    const all = [...l.boxes.values()]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const p = all[i]
        const q = all[j]
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
        expect(apart, `${p.id} and ${q.id}`).toBe(true)
      }
    }
  })

  it('keeps the third parties together in the last column and the shared systems in a frame on top', () => {
    const l = layoutBoxes(slim, pairs)
    const vendorXs = new Set(a.boxes.filter((b) => b.kind === 'vendor').map((b) => l.boxes.get(b.id)!.x))
    expect(vendorXs.size).toBe(1)
    const lastX = Math.max(...[...l.boxes.values()].map((p) => p.x))
    expect([...vendorXs][0]).toBe(lastX)
    const shared = l.frames.find((f) => f.id === 'shared')!
    for (const b of a.boxes.filter((x) => x.kind === 'shared')) {
      const p = l.boxes.get(b.id)!
      expect(p.y).toBeGreaterThanOrEqual(shared.y)
      expect(p.y + p.h).toBeLessThanOrEqual(shared.y + shared.h)
    }
  })

  it('crosses fewer lines than the plain left-to-right order does', () => {
    const l = layoutBoxes(slim, pairs)
    const plain = new Map(slim.map((b) => [b.id, b]))
    expect(plain.size).toBe(slim.length)
    const naive = (() => {
      const cols = arrangeNaive()
      return cols
    })()
    expect(crossings(l, pairs)).toBeLessThanOrEqual(naive)
  })

  it('keeps a busy town of ten pillars and five third parties to a few crossings', () => {
    const p = ['mgr', 'ams', 'osh', 'crt', 'cus', 'rp', 'cl', 'tms', 'frd', 'dig']
    const v = ['accesspay', 'fiserv', 'provenir', 'featurespace', 'threatmetrix']
    const boxes = [...p.map((id) => ({ id, kind: (id === 'dig' ? 'internal' : 'pillar') as 'internal' | 'pillar' })), ...v.map((id) => ({ id: `vendor:${id}`, kind: 'vendor' as const }))]
    const calls = [['dig', 'cl'], ['dig', 'ams'], ['dig', 'cus'], ['cl', 'ams'], ['cl', 'tms'], ['cl', 'fiserv'], ['cl', 'frd'], ['ams', 'tms'], ['ams', 'cus'], ['ams', 'osh'], ['ams', 'rp'], ['ams', 'crt'], ['mgr', 'ams'], ['mgr', 'tms'], ['mgr', 'cus'], ['osh', 'ams'], ['osh', 'cus'], ['osh', 'cl'], ['crt', 'provenir'], ['crt', 'cus'], ['crt', 'tms'], ['rp', 'accesspay'], ['rp', 'ams'], ['rp', 'tms'], ['frd', 'featurespace'], ['frd', 'threatmetrix'], ['frd', 'tms'], ['cus', 'tms'], ['tms', 'ams'], ['cl', 'rp']]
    const lines = calls.map(([a, b]) => ({ from: a, to: v.includes(b) ? `vendor:${b}` : b }))
    expect(crossings(layoutBoxes(boxes, lines), lines)).toBeLessThanOrEqual(4)
  })

  it('keeps every box where it was when a pillar is hidden, and moves them only for a box it has not seen', () => {
    const full = layoutBoxes(slim, pairs)
    const fewer = slim.filter((b) => b.id !== 'pay')
    const hidden = layoutBoxes(fewer, pairs.filter((p) => p.from !== 'pay' && p.to !== 'pay'), full)
    expect(hidden).toBe(full)
    const more = layoutBoxes([...slim, { id: 'zzz', kind: 'pillar' as const }], pairs, full)
    expect(more).not.toBe(full)
    expect(more.boxes.has('zzz')).toBe(true)
  })

  it('draws every line from the right of one box to the left of the next, each with a place of its own, through free gaps', () => {
    const l = layoutBoxes(slim, pairs)
    const visible = new Set(slim.map((b) => b.id))
    for (const style of ['elbow', 'curve'] as const) {
      const paths = routeAll(l, visible, pairs, style)
      expect(paths.size).toBe(pairs.length)
      for (const d of paths.values()) {
        expect(d).toMatch(/^M[\d.-]+ [\d.-]+/)
        expect(d).not.toContain('NaN')
      }
    }
    // two lines into the same box do not end at the same point
    const ends = new Map<string, number>()
    for (const [key, d] of routeAll(l, visible, pairs, 'elbow')) {
      const to = key.split('>')[1]
      const y = d.match(/([\d.-]+)H[\d.-]+$/)?.[1] ?? d
      ends.set(`${to}@${y}`, (ends.get(`${to}@${y}`) ?? 0) + 1)
    }
    expect([...ends.values()].every((n) => n === 1)).toBe(true)
    expect(routeAll(l, visible, [{ from: 'nope', to: 'pay' }], 'elbow').size).toBe(0)
  })

  it('never runs a square line over a box, for calls forwards, backwards and inside one column', () => {
    const p = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const boxes = p.map((id) => ({ id, kind: 'pillar' as const }))
    const calls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'd'], ['e', 'f'], ['f', 'e'], ['g', 'a'], ['h', 'b'], ['c', 'a'], ['a', 'h'], ['e', 'a']]
    const lines = calls.map(([from, to]) => ({ from, to }))
    for (const [names, pairs] of [[boxes, lines], [slim, pairs_()]] as const) {
      const l = layoutBoxes(names, pairs)
      const visible = new Set(names.map((b) => b.id))
      for (const [key, d] of routeAll(l, visible, pairs, 'elbow')) {
        const [from, to] = key.split('>')
        const nums = (d.match(/[MHV][\d.-]+(?: [\d.-]+)?/g) ?? [])
        let x = 0
        let y = 0
        const segs: [number, number, number, number][] = []
        for (const t of nums) {
          const v = t.slice(1).split(' ').map(Number)
          const [nx, ny] = t[0] === 'M' ? [v[0], v[1]] : t[0] === 'H' ? [v[0], y] : [x, v[0]]
          if (t[0] !== 'M') segs.push([x, y, nx, ny])
          x = nx
          y = ny
        }
        for (const q of l.boxes.values()) {
          if (q.id === from || q.id === to || q.id.startsWith('shared:')) continue
          for (const [x0, y0, x1, y1] of segs) {
            const inside = Math.max(x0, x1) > q.x + 1 && Math.min(x0, x1) < q.x + q.w - 1 && Math.max(y0, y1) > q.y + 1 && Math.min(y0, y1) < q.y + q.h - 1
            expect(inside, `${key} over ${q.id}`).toBe(false)
          }
        }
      }
    }
    function pairs_() { return pairs }
  })

  it('handles a town with only pillars and nothing else', () => {
    const l = layoutBoxes([{ id: 'a', kind: 'pillar' }], [])
    expect(l.boxes.size).toBe(1)
    const none = layoutBoxes([], [])
    expect(none.boxes.size).toBe(0)
  })

  function arrangeNaive(): number {
    // every box in a column by call depth, in id order
    const cols = arrange(slim, []) // with no calls to follow, the search keeps the id order
    const l = layoutBoxes(slim, [], null)
    expect(cols.flat().length).toBe(slim.filter((b) => b.kind !== 'shared').length)
    return crossings(l, pairs)
  }
})
