import { describe, expect, it } from 'vitest'
import { serviceCount, servicesText } from '../../src/wall/servicesText'
import { calmScenes } from '../../src/wall/calm'
import { overviewStops } from '../../src/wall/overview'
import { healthyTown } from './wall.testutil'

const node = (id: string, kind: string, service?: string) => ({ id, kind, service }) as Parameters<typeof serviceCount>[0][number]

describe('describing an island by its services', () => {
  it('counts the buildings of one service once: its API, worker and database', () => {
    const nodes = [node('a1', 'Api', 'ledger'), node('a2', 'Worker', 'ledger'), node('a3', 'Database', 'ledger'), node('b1', 'Api', 'payments'), node('b2', 'Cache', 'payments')]

    expect(serviceCount(nodes)).toBe(2)
    expect(servicesText(nodes)).toBe('2 services')
  })

  it('adds the scheduler, which is not a service', () => {
    const nodes = [node('a1', 'Api', 'ledger'), node('f1', 'Function')]

    expect(servicesText(nodes)).toBe('1 service plus scheduler')
  })

  it('counts a building with no service name as a service of its own', () => {
    expect(serviceCount([node('x', 'Api'), node('y', 'Worker')])).toBe(2)
  })

  it('says so when there is only a scheduler or nothing', () => {
    expect(servicesText([node('f1', 'Function')])).toBe('scheduler only')
    expect(servicesText([])).toBe('nothing yet')
  })

  it('is what the island captions of the overview and the showcase say, not a count of buildings', () => {
    const s = healthyTown()
    const island = s.groups.find((g) => !g.isHub && g.nodes.length > 0)!
    const words = servicesText(island.nodes)

    expect(overviewStops(s, [], 3).find((o) => o.key === `overview:island:${island.id}`)!.caption).toBe(`Overview: ${island.displayName}, ${words}`)
    expect(calmScenes(s).find((c) => c.key === `island:${island.id}`)!.caption).toContain(`${island.displayName}: ${words}, `)
    expect(words).not.toBe(`${island.nodes.length} systems`)
  })
})
