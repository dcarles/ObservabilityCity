import { describe, expect, it } from 'vitest'
import { azureRows, eventItems, eventLine, eventOfNode, eventsByNode, healthEventsOf, isResolved } from '../../src/healthEvents'
import type { HealthEventSnapshot } from '../../src/types'

const NOW = Date.parse('2026-11-05T20:00:00Z')
const ev = (o: Partial<HealthEventSnapshot>): HealthEventSnapshot => ({ id: 'e', resource: 'orders-db', state: 'Degraded', previous: 'Available', cause: 'Unknown', since: '2026-11-05T16:21:15Z', resolvedAt: null, nodeId: 'aa.orders-db', groupId: 'aa', ...o })

describe('Azure resource health events', () => {
  it('treats a snapshot with no events as none', () => {
    expect(healthEventsOf(null)).toEqual([])
    expect(healthEventsOf(undefined)).toEqual([])
    expect(eventsByNode(undefined).size).toBe(0)
    expect(eventItems(null, () => 'x', NOW)).toEqual([])
    expect(eventItems([ev({})], () => 'Borealis', NOW, 'Cumulus')[0]!.where).toBe('Cumulus resource health · Borealis')
    expect(eventItems([ev({})], () => 'Borealis', NOW)[0]!.where).toBe('Cloud resource health · Borealis')
  })

  it('keeps the worst event of a building: unavailable first, then the one open longest', () => {
    const m = eventsByNode([
      ev({ id: 'a', since: '2026-11-05T10:00:00Z' }),
      ev({ id: 'b', state: 'Unavailable', since: '2026-11-05T12:00:00Z' }),
      ev({ id: 'c', state: 'Unavailable', since: '2026-11-05T11:00:00Z' }),
      ev({ id: 'd', nodeId: 'aa.other', since: '2026-11-05T09:00:00Z' }),
      ev({ id: 'e', nodeId: null }),
    ])
    expect(m.get('aa.orders-db')?.id).toBe('c')
    expect(m.get('aa.other')?.id).toBe('d')
    expect(m.size).toBe(2)
  })

  it('writes the line of an event', () => {
    const line = eventLine(ev({}), NOW)
    expect(line).toContain('Degraded since')
    expect(line).toContain('was Available')
    expect(line).toContain('cause Unknown')
    expect(eventLine(ev({ previous: null, cause: null }), NOW)).toMatch(/^Degraded since [^·]*$/)
  })

  it('lists matched events as buildings and unmatched ones as inert', () => {
    const items = eventItems([ev({}), ev({ id: 'x', nodeId: null, resource: 'stray' })], () => 'Borealis', NOW)
    expect(items[0]).toMatchObject({ kind: 'building', id: 'aa.orders-db', name: 'orders-db' })
    expect(items[0].where).toContain('Borealis')
    expect(items[0].inert).toBeUndefined()
    expect(items[1]).toMatchObject({ name: 'stray', inert: true })
  })

  it('gives drawer rows, leaving out what Azure did not say', () => {
    const rows = azureRows(ev({}), NOW)
    expect(rows.map((r) => r.label)).toEqual(['State', 'Since', 'Before', 'Cause', 'Resource'])
    expect(rows[0]).toMatchObject({ value: 'Degraded', tone: 'warn' })
    expect(azureRows(ev({ state: 'Unavailable', previous: null, cause: null }), NOW).map((r) => r.label)).toEqual(['State', 'Since', 'Resource'])
    expect(azureRows(ev({ state: 'Unavailable' }), NOW)[0].tone).toBe('bad')
  })

  const done = (o: Partial<HealthEventSnapshot> = {}): HealthEventSnapshot => ev({ id: 'r', state: 'Resolved', resolvedAt: '2026-11-05T18:17:17Z', ...o })

  it('does not mark a building for a resolved report', () => {
    expect(isResolved(done())).toBe(true)
    expect(eventsByNode([done()]).size).toBe(0)
  })

  it('says what a building has: its open report, else the one that resolved last', () => {
    const older = done({ id: 'r1', resolvedAt: '2026-11-05T17:00:00Z' })
    const newer = done({ id: 'r2', resolvedAt: '2026-11-05T18:00:00Z' })
    expect(eventOfNode([older, newer], 'aa.orders-db')?.id).toBe('r2')
    expect(eventOfNode([older, newer, ev({ id: 'open' })], 'aa.orders-db')?.id).toBe('open')
    expect(eventOfNode([older], 'aa.other')).toBeNull()
    expect(eventOfNode(undefined, 'aa.orders-db')).toBeNull()
  })

  it('lists a resolved report as resolved, green, with a Dismiss and where it went wrong', () => {
    const [item] = eventItems([done()], () => 'Borealis', NOW)
    expect(item).toMatchObject({ kind: 'building', id: 'aa.orders-db', state: 'Resolved', dismiss: 'r' })
    expect(item.detail).toContain('Resolved')
    expect(item.detail).toContain('was down since')
    expect(eventItems([ev({ nodeId: null })], () => '', NOW)[0]).toMatchObject({ inert: true, dismiss: 'e' })
  })

  it('gives green drawer rows with the time of the resolution for a resolved report', () => {
    const rows = azureRows(done(), NOW)
    expect(rows.map((r) => r.label)).toEqual(['State', 'Resolved', 'Began', 'Before', 'Cause', 'Resource'])
    expect(rows.every((r) => r.tone === 'ok')).toBe(true)
  })

  it('keeps two reports of one resource apart: the earlier resolved one is listed beside the open one', () => {
    const first = done({ id: 'res@1', since: '2026-11-05T10:00:00Z', resolvedAt: '2026-11-05T11:00:00Z' })
    const second = ev({ id: 'res@2', since: '2026-11-05T12:00:00Z' })
    const items = eventItems([second, first], () => 'Borealis', NOW)
    expect(items.map((i) => [i.dismiss, i.state])).toEqual([['res@2', 'Degraded'], ['res@1', 'Resolved']])
    expect(eventsByNode([second, first]).get('aa.orders-db')?.id).toBe('res@2') // the building is marked for the open one
    expect(eventOfNode([first, second], 'aa.orders-db')?.id).toBe('res@2')
  })
})
