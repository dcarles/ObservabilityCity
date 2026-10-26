import { describe, expect, it } from 'vitest'
import { WallDirector } from '../../src/wall/director'
import { calmScenes } from '../../src/wall/calm'
import { healthyTown, onlyIslands, withIncident, withState } from './wall.testutil'

const HOLD = 20

/** A director that has seen the healthy town at time 0. */
function calmDirector(hold = HOLD) {
  const d = new WallDirector(hold)
  d.update(healthyTown(), 0)
  return d
}

describe('a healthy town', () => {
  it('starts the showcase loop with the whole town', () => {
    const d = new WallDirector(HOLD)

    const stop = d.update(healthyTown(), 0)

    expect(d.mode).toBe('calm')
    expect(stop).toMatchObject({ key: 'town', kind: 'calm', cut: false })
    expect(stop?.caption).toContain('All systems healthy')
  })

  it('stays at a stop for the hold and then moves to the next scene', () => {
    const d = calmDirector()

    expect(d.tick(19.9)).toBeNull()
    expect(d.tick(20)?.key).toBe('hub')
    expect(d.tick(39.9)).toBeNull()
    expect(d.tick(40)?.key).toBe('island:cl')
  })

  it('goes round the whole loop and starts again', () => {
    const d = calmDirector(1)
    const scenes = calmScenes(healthyTown())
    const seen: string[] = ['town']

    for (let i = 1; i <= scenes.length; i++) seen.push(d.tick(i)!.key)

    expect(seen.slice(0, scenes.length)).toEqual(scenes.map((s) => s.key))
    expect(seen.at(-1)).toBe('town')
  })

  it('does not move the camera because a new snapshot came in', () => {
    const d = calmDirector()

    expect(d.update(healthyTown(), 5)).toBeNull()
    expect(d.current?.key).toBe('town')
  })

  it('keeps the caption of the stop up to date', () => {
    const d = calmDirector()
    const later = healthyTown()
    later.generatedAt = '2026-10-24T15:00:01+00:00'
    later.incidentFreeSince = '2026-10-24T12:00:00+00:00'
    later.incidentsSeen = true

    d.update(later, 5)

    expect(d.current?.caption).toBe('All systems healthy, 3 h since last incident')
  })
})

describe('trouble about', () => {
  it('turns the loop into a tour of the trouble, worst first, holding at each stop', () => {
    const d = new WallDirector(HOLD)
    let s = withState(healthyTown(), 'cl.ledger-db', 'Degraded')
    s = withState(s, 'pay.payments-api', 'Down')
    s = withIncident(s, 'frd', { id: 'inc', severity: 2, title: 'Screening is slow' })

    const first = d.update(s, 0)

    expect(d.mode).toBe('alert')
    expect(first).toMatchObject({ kind: 'incident', focus: { kind: 'island', id: 'frd' } })
    expect(d.tick(10)).toBeNull()
    expect(d.tick(20)).toMatchObject({ kind: 'down', focus: { kind: 'building', id: 'pay.payments-api' } })
    expect(d.tick(40)).toMatchObject({ kind: 'degraded', focus: { kind: 'building', id: 'cl.ledger-db' } })
    expect(d.tick(60)).toMatchObject({ kind: 'incident' }) // and round again
  })

  it('goes back to the showcase loop once everything is fine', () => {
    const d = new WallDirector(HOLD)
    d.update(withState(healthyTown(), 'cl.ledger-api', 'Down'), 0)

    const stop = d.update(healthyTown(), 5)

    expect(d.mode).toBe('calm')
    expect(stop).toMatchObject({ key: 'town', kind: 'calm' })
  })

  it('moves on from a stop at once when its trouble ends, without cutting', () => {
    const d = new WallDirector(HOLD)
    let both = withState(healthyTown(), 'cl.ledger-api', 'Down')
    both = withState(both, 'pay.payments-api', 'Down')
    d.update(both, 0)
    const holding = d.current!.focus.id

    const stop = d.update(withState(healthyTown(), holding === 'cl.ledger-api' ? 'pay.payments-api' : 'cl.ledger-api', 'Down'), 3)

    expect(stop).not.toBeNull()
    expect(stop!.cut).toBe(false)
    expect(stop!.focus.id).not.toBe(holding)
  })
})

describe('new trouble', () => {
  it('cuts to it at once and holds there for a full stop', () => {
    const d = calmDirector()

    const stop = d.update(withState(healthyTown(), 'cl.ledger-api', 'Down'), 7)

    expect(stop).toMatchObject({ kind: 'down', cut: true, focus: { kind: 'building', id: 'cl.ledger-api' } })
    expect(d.cuts).toBe(1)
    expect(d.tick(26.9)).toBeNull() // 7 + 20 not yet reached
    expect(d.tick(27)).not.toBeNull()
  })

  it('pulses the screen for a few seconds', () => {
    const d = calmDirector()

    d.update(withState(healthyTown(), 'cl.ledger-api', 'Down'), 7)

    expect(d.pulsing(7)).toBe(true)
    expect(d.pulsing(10.9)).toBe(true)
    expect(d.pulsing(11)).toBe(false)
  })

  it('does not pulse for trouble that was already there', () => {
    const d = new WallDirector(HOLD)
    d.update(withState(healthyTown(), 'cl.ledger-api', 'Down'), 0)

    expect(d.pulsing(0)).toBe(false)
    expect(d.cuts).toBe(0)
  })

  it('cuts to the worst of several new troubles', () => {
    const d = calmDirector()
    let s = withState(healthyTown(), 'cl.ledger-api', 'Degraded')
    s = withState(s, 'pay.payments-api', 'Down')

    expect(d.update(s, 7)?.focus.id).toBe('pay.payments-api')
  })

  it('does not whip the camera about: a second trouble right after the first waits for the tour, but the screen still pulses', () => {
    const d = calmDirector()
    const first = withState(healthyTown(), 'cl.ledger-api', 'Down')
    d.update(first, 7)

    const second = d.update(withState(first, 'pay.payments-api', 'Down'), 8)

    expect(second).toBeNull()
    expect(d.cuts).toBe(1)
    expect(d.pulseUntil).toBeGreaterThan(8)
    expect(d.update(withState(withState(first, 'pay.payments-api', 'Down'), 'frd.cases-api', 'Down'), 11)).toMatchObject({ cut: true })
  })

  it('continues the tour after the new trouble, not from the top', () => {
    const d = calmDirector()
    let s = withState(healthyTown(), 'cl.ledger-api', 'Down')
    d.update(s, 7)

    s = withState(s, 'pay.payments-api', 'Down')
    d.update(s, 8) // too soon to cut
    const next = d.tick(27)

    expect(next?.focus.id).not.toBe('cl.ledger-api')
  })
})

describe('trouble that ends', () => {
  it('puts up a resolved note that goes away by itself', () => {
    const d = new WallDirector(HOLD)
    d.update(withState(healthyTown(), 'cl.ledger-api', 'Down'), 0)

    d.update(healthyTown(), 12)

    expect(d.note?.text).toBe('Resolved: Ledger API is healthy again')
    expect(d.tick(21.9)).toBeNull()
    expect(d.note).not.toBeNull()
    d.tick(22)
    expect(d.note).toBeNull()
  })
})

describe('a view of one team', () => {
  it('tours only what it shows', () => {
    const d = new WallDirector(1)
    const view = onlyIslands(healthyTown(), ['pay', 'frd'])
    d.update(view, 0)
    const islands = new Set<string>()

    for (let t = 1; t <= 20; t++) {
      const stop = d.tick(t)
      if (stop?.key.startsWith('island:')) islands.add(stop.focus.id)
    }

    expect([...islands].sort()).toEqual(['frd', 'pay'])
  })

  it('does not hear about trouble on islands it does not show', () => {
    const d = new WallDirector(HOLD)
    d.update(onlyIslands(healthyTown(), ['pay']), 0)

    const stop = d.update(onlyIslands(withState(healthyTown(), 'cl.ledger-api', 'Down'), ['pay']), 5)

    expect(stop).toBeNull()
    expect(d.mode).toBe('calm')
  })
})
