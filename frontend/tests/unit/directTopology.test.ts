import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectorsOf } from '../../src/scene/links'
import { checkSnapshot } from '../../src/snapshotGuard'
import type { GroupSnapshot, Snapshot } from '../../src/types'

// In a town whose islands call each other directly, islands reach each other, the airport and the third parties over the outer ring road. The
// backend decides which islands have a bridge to it (hasRingBridge); these tests check what the renderer builds from that.
const fixture = (name: string) => JSON.parse(readFileSync(resolve(__dirname, `../../../shared-test-data/snapshots/${name}`), 'utf8')) as Snapshot
const sample = fixture('calm.json')
const group = (over: Partial<GroupSnapshot>): GroupSnapshot => ({ ...sample.groups.find((g) => !g.isHub)!, configError: null, ...over })

describe('the ring road connector', () => {
  it('is built for an island the backend says has one, with or without a bridge to the hub', () => {
    expect(connectorsOf(group({ hasBridge: false, hasRingBridge: true }))).toMatchObject({ bridge: false, ring: true, standalone: false })
    expect(connectorsOf(group({ hasBridge: true, hasRingBridge: true }))).toMatchObject({ bridge: true, ring: true, standalone: false })
  })

  it('is not built when the backend says nothing about it: such an island has only what it had', () => {
    expect(connectorsOf(group({ hasBridge: true, hasRingBridge: false }))).toMatchObject({ bridge: true, ring: false })
  })

  it('is never built for the hub or for an island whose registry file is broken', () => {
    expect(connectorsOf(group({ isHub: true, hasRingBridge: true })).ring).toBe(false)
    expect(connectorsOf(group({ configError: 'broken', hasRingBridge: true })).ring).toBe(false)
  })

  it('does not make an island with nothing else a standalone island', () => {
    const lone = group({ hasBridge: false, hasRingBridge: true, messaging: { topics: [], subscriptions: [] } })
    expect(connectorsOf(lone).standalone).toBe(false)
    expect(connectorsOf({ ...lone, hasRingBridge: false }).standalone).toBe(true)
  })
})

describe('a hub-and-spoke town keeps its roads (the sample town)', () => {
  it('has a ring bridge only on the islands that call a third party', () => {
    const groupOfNode = new Map(sample.groups.flatMap((g) => g.nodes.map((n) => [n.id, g.id] as const)))
    const callers = new Set(sample.vendors.flatMap((v) => v.calledBy.map((id) => groupOfNode.get(id))))
    for (const g of sample.groups.filter((g) => !g.isHub)) expect(connectorsOf(g).ring, g.id).toBe(callers.has(g.id))
  })

  it('has a bridge to the hub on every island with an API', () => {
    for (const g of sample.groups.filter((g) => !g.isHub && g.nodes.some((n) => n.kind === 'Api'))) expect(connectorsOf(g).bridge, g.id).toBe(true)
  })
})

describe('the snapshot guard', () => {
  it('keeps the ring flag the backend sent, and says no when it is missing', () => {
    const raw = JSON.parse(JSON.stringify(sample))
    raw.groups[1].hasRingBridge = true
    delete raw.groups[2].hasRingBridge
    const { snapshot } = checkSnapshot(raw)
    expect(snapshot!.groups[1].hasRingBridge).toBe(true)
    expect(snapshot!.groups[2].hasRingBridge).toBe(false)
  })
})
