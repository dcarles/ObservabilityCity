import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkSnapshot } from './snapshotGuard'
import { wrapText } from './scene/town'
import type { Snapshot } from './types'

const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../tests/fixtures/snapshots/${name}`), 'utf8')) as Snapshot
const calm = () => structuredClone(fixture('calm.json'))

describe('a good snapshot', () => {
  it.each(['calm.json', 'bad-day.json'])('passes %s unchanged and with nothing to report', (name) => {
    const raw = fixture(name)
    const { snapshot, problems } = checkSnapshot(structuredClone(raw))
    expect(problems).toEqual([])
    expect(snapshot).toEqual(raw)
  })
})

describe('a snapshot that cannot be drawn is refused', () => {
  it.each([
    ['null', null],
    ['text', 'hello'],
    ['a list', []],
    ['an empty object', {}],
    ['no groups', { groups: [] }],
    ['groups that are not a list', { groups: 'many' }],
    ['groups without ids', { groups: [{ nodes: [] }, 42, null] }],
    ['groups with no systems at all', { groups: [{ id: 'x', nodes: 'none' }, { id: 'y', nodes: [] }] }],
  ])('%s', (_name, raw) => {
    const { snapshot, problems } = checkSnapshot(raw)
    expect(snapshot).toBeNull()
    expect(problems.length).toBeGreaterThan(0)
  })
})

describe('a snapshot with something wrong in it is repaired where that is safe', () => {
  it('drops a system with no id or an unknown kind and keeps the rest', () => {
    const raw = calm()
    const g = raw.groups[1]
    const kept = g.nodes.length
    g.nodes.push({ ...g.nodes[0], id: '' }, { ...g.nodes[0], id: 'x.castle', kind: 'Castle' as never }, null as never)
    const { snapshot, problems } = checkSnapshot(raw)
    expect(snapshot!.groups[1].nodes).toHaveLength(kept)
    expect(problems.some((p) => p.includes('x.castle'))).toBe(true)
  })

  it('drops the second of two systems with the same id', () => {
    const raw = calm()
    const g = raw.groups[1]
    g.nodes.push({ ...g.nodes[0] })
    const { snapshot, problems } = checkSnapshot(raw)
    expect(snapshot!.groups[1].nodes).toHaveLength(g.nodes.length - 1)
    expect(problems.some((p) => p.includes('second system'))).toBe(true)
  })

  it('turns numbers that are not numbers into 0, and optional ones into null', () => {
    const raw = calm()
    const n = raw.groups[1].nodes[0] as unknown as Record<string, unknown>
    n.errorRate = 'lots'
    n.p99Ms = null
    n.cpu = 'high'
    n.queueDepth = Infinity
    const out = checkSnapshot(raw).snapshot!.groups[1].nodes[0]
    expect(out.errorRate).toBe(0)
    expect(out.p99Ms).toBe(0)
    expect(out.cpu).toBeNull()
    expect(out.queueDepth).toBeNull()
  })

  it('shows an unknown state as stale, never as healthy', () => {
    const raw = calm()
    ;(raw.groups[1].nodes[0] as unknown as Record<string, unknown>).state = 'Fine'
    expect(checkSnapshot(raw).snapshot!.groups[1].nodes[0].state).toBe('Stale')
  })

  it('fills in a list that is missing', () => {
    const raw = calm() as unknown as Record<string, unknown>
    delete raw.notices
    const group = (raw.groups as Record<string, unknown>[])[1]
    delete group.configError
    delete (group.nodes as Record<string, unknown>[])[0].calls
    const out = checkSnapshot(raw).snapshot!
    expect(out.notices).toEqual([])
    expect(out.groups[1].configError).toBeNull()
    expect(out.groups[1].nodes[0].calls).toEqual([])
  })

  it('keeps a config error island, which has no systems, and its message', () => {
    const raw = calm()
    raw.groups[2].nodes = []
    raw.groups[2].configError = 'bb.yaml was skipped: unknown role castle'
    const out = checkSnapshot(raw).snapshot!
    expect(out.groups[2].nodes).toEqual([])
    expect(out.groups[2].configError).toBe('bb.yaml was skipped: unknown role castle')
  })

  it('falls back to a plain colour when a group colour is not one', () => {
    const raw = calm()
    raw.groups[1].color = 'banana'
    expect(checkSnapshot(raw).snapshot!.groups[1].color).toMatch(/^#/)
  })
})

describe('wrapText', () => {
  it('breaks at word boundaries', () => {
    expect(wrapText('one two three four five', 10)).toEqual(['one two', 'three four', 'five'])
  })
  it('cuts a word that is longer than a line', () => {
    expect(wrapText('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl'])
  })
  it('gives nothing for nothing', () => {
    expect(wrapText('   ', 10)).toEqual([])
  })
})
