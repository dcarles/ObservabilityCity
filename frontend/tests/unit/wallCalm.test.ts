import { describe, expect, it } from 'vitest'
import { calmScenes, healthyCaption } from '../../src/wall/calm'
import { healthyTown, onlyIslands } from './wall.testutil'

const town = () => {
  const s = healthyTown()
  s.generatedAt = '2026-10-26T12:00:00+00:00'
  s.incidentFreeSince = '2026-10-26T09:00:00+00:00'
  s.incidentsSeen = true
  return s
}

describe('the healthy caption', () => {
  it('says all is well and how long since the last incident', () => {
    expect(healthyCaption(town())).toBe('All systems healthy, 3 h since last incident')
  })

  it('says only that all is well when the server has nothing to say about incidents', () => {
    const s = town()
    s.incidentFreeSince = null
    expect(healthyCaption(s)).toBe('All systems healthy')
  })
})

describe('the showcase loop', () => {
  it('opens on the whole town with the healthy line, then the hub', () => {
    const [first, second] = calmScenes(town())

    expect(first).toEqual({ key: 'town', focus: { kind: 'home', id: '' }, caption: 'All systems healthy, 3 h since last incident' })
    expect(second.focus).toEqual({ kind: 'island', id: 'hub' })
    expect(second.caption).toContain('Platform hub')
    expect(second.caption).toContain('Service Bus')
  })

  it('visits each island in the order they stand round the hub', () => {
    const s = town()
    const visited = calmScenes(s).filter((c) => c.key.startsWith('island:')).map((c) => c.focus.id)

    expect(visited).toEqual(s.groups.filter((g) => !g.isHub).map((g) => g.id))
  })

  it('visits the busiest systems, busiest first, one after every third island', () => {
    const scenes = calmScenes(town())
    const busy = scenes.filter((c) => c.key.startsWith('busy:'))

    expect(busy).toHaveLength(3)
    const rates = healthyTown().groups.filter((g) => !g.isHub).flatMap((g) => g.nodes).sort((a, b) => b.requestsPerSecond - a.requestsPerSecond).slice(0, 3).map((n) => n.id)
    expect(busy.map((b) => b.focus.id)).toEqual(rates)
    expect(busy.map((b) => b.focus.kind)).toEqual(['building', 'building', 'building'])
    // islands stand in the order cl, acc, pay, frd, cus, acq ...: a visit after the third, the sixth and the ninth
    const keys = scenes.map((c) => c.key)
    expect(keys.indexOf('busy:' + busy[0].focus.id)).toBe(keys.indexOf('island:pay') + 1)
    expect(keys.indexOf('busy:' + busy[1].focus.id)).toBe(keys.indexOf('island:acq') + 1)
  })

  it('takes the busiest from the islands, never the shared hub resources', () => {
    const busy = calmScenes(town()).filter((c) => c.key.startsWith('busy:'))

    expect(busy.every((b) => !b.focus.id.startsWith('hub.'))).toBe(true)
  })

  it('closes with a wide shot of the hub', () => {
    const scenes = calmScenes(town())

    expect(scenes.at(-1)!.key).toBe('hub-end')
    expect(scenes.at(-1)!.focus).toEqual({ kind: 'island', id: 'hub' })
  })

  it('has unique keys, so the tour can tell one stop from another', () => {
    const keys = calmScenes(town()).map((c) => c.key)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('shows a team view only its own islands', () => {
    const scenes = calmScenes(onlyIslands(town(), ['pay', 'frd']))
    const islands = scenes.filter((c) => c.key.startsWith('island:')).map((c) => c.focus.id)

    expect(islands).toEqual(['pay', 'frd'])
    // a view too small to reach a third island still gets its busiest visits
    expect(scenes.some((c) => c.key.startsWith('busy:'))).toBe(true)
    expect(scenes.filter((c) => c.key.startsWith('busy:')).every((c) => c.focus.id.startsWith('pay.') || c.focus.id.startsWith('frd.'))).toBe(true)
  })

  it('is just the town and the hub for a view with nothing but the hub', () => {
    const scenes = calmScenes(onlyIslands(town(), []))

    expect(scenes.map((c) => c.key)).toEqual(['town', 'hub', 'hub-end'])
  })
})
