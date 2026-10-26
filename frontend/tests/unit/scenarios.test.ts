import { describe, expect, it } from 'vitest'
import { Aim, effectLabel, hasIntensity, SCENARIOS, targetFor, tenantToHit } from '../../src/scenarios'

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!

describe('the scenario list', () => {
  it('has a unique id for each and covers every effect the server knows', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length)
    const kinds = new Set(SCENARIOS.map((s) => s.kind))
    for (const k of ['Traffic', 'Errors', 'Latency', 'UnhealthyInstances', 'Down', 'HighCpu', 'HighMemory', 'Saturate', 'Backlog', 'Poison', 'Stale', 'Incident'])
      expect(kinds.has(k as never), k).toBe(true)
    expect(SCENARIOS.every((s) => s.intensity >= 0 && s.intensity <= 1)).toBe(true)
  })

  it('names an incident by how bad it is, as the server does', () => {
    expect(effectLabel('Incident', 1)).toBe('Sev 1 storm')
    expect(effectLabel('Incident', 0.85)).toBe('Sev 1 storm')
    expect(effectLabel('Incident', 0.6)).toBe('Sev 2 rain')
    expect(effectLabel('Incident', 0.35)).toBe('Sev 3 overcast')
    expect(effectLabel('Incident', 0.1)).toBe('Sev 4 clouds')
    expect(effectLabel('Errors', 0.4)).toBe('Errors')
    expect(effectLabel('Whatever', 0.4)).toBe('Whatever')
  })

  it('gives a slider to effects that have a strength, not to Down and Gone quiet', () => {
    expect(hasIntensity('Errors')).toBe(true)
    expect(hasIntensity('Incident')).toBe(true)
    expect(hasIntensity('Down')).toBe(false)
    expect(hasIntensity('Stale')).toBe(false)
  })
})

describe('tenant scenarios', () => {
  const tenants = [{ id: 'test1', kind: 'Test' }, { id: 'acme', kind: 'Customer' }, { id: 'zed', kind: 'Customer' }]

  it('hit the one tenant followed, else the first customer', () => {
    expect(tenantToHit(['zed'], tenants)).toBe('zed')
    expect(tenantToHit([], tenants)).toBe('acme')
    expect(tenantToHit(['zed', 'acme'], tenants)).toBe('acme')
    expect(tenantToHit([], [{ id: 'test1', kind: 'Test' }])).toBeUndefined()
  })

  it('aim at one store for one tenant, never the whole town', () => {
    expect(targetFor(scenario('tenant-db'), 'cl.ledger-db', 'acme')).toBe('cl.ledger-db#acme')
    expect(targetFor(scenario('tenant-db'), '*', 'acme')).toBeNull()
    expect(targetFor(scenario('tenant-db'), 'cl.ledger-db', undefined)).toBeNull()
    expect(targetFor(scenario('errors'), 'cl.ledger-api', undefined)).toBe('cl.ledger-api')
  })
})

describe('picking a scenario and then a target', () => {
  it('waits for the target after the scenario, then fires once', () => {
    const aim = new Aim()

    expect(aim.arm(scenario('errors'), undefined)).toBeNull()
    expect(aim.scenario?.id).toBe('errors')

    expect(aim.aim('cl.ledger-api', undefined)).toEqual({ target: 'cl.ledger-api', kind: 'Errors', intensity: 0.4 })
    expect(aim.scenario).toBeNull()
    expect(aim.aim('cl.ledger-api', undefined)).toBeNull() // nothing is waiting any more: the target is only remembered
  })

  it('fires at once when the target was chosen first, then forgets it', () => {
    const aim = new Aim()
    expect(aim.aim('pay.payments-db', undefined)).toBeNull()
    expect(aim.target).toBe('pay.payments-db')

    expect(aim.arm(scenario('sev1'), undefined)).toEqual({ target: 'pay.payments-db', kind: 'Incident', intensity: 1 })
    expect(aim.target).toBeNull()
    expect(aim.scenario).toBeNull()
  })

  it('lets go of a scenario that is picked again, or cancelled', () => {
    const aim = new Aim()
    aim.arm(scenario('down'), undefined)
    expect(aim.arm(scenario('down'), undefined)).toBeNull()
    expect(aim.scenario).toBeNull()

    aim.arm(scenario('slow'), undefined)
    aim.cancel()
    expect(aim.scenario).toBeNull()
    expect(aim.aim('x', undefined)).toBeNull()
    aim.cancel()
    expect(aim.target).toBeNull()
  })

  it('picking another scenario while one waits swaps them', () => {
    const aim = new Aim()
    aim.arm(scenario('slow'), undefined)
    aim.arm(scenario('down'), undefined)
    expect(aim.aim('a.b', undefined)).toEqual({ target: 'a.b', kind: 'Down', intensity: 1 })
  })

  it('keeps a tenant scenario waiting when the target is the whole town', () => {
    const aim = new Aim()
    aim.arm(scenario('tenant-db'), 'acme')

    expect(aim.aim('*', 'acme')).toBeNull()
    expect(aim.scenario?.id).toBe('tenant-db')
    expect(aim.aim('cl.ledger-db', 'acme')).toEqual({ target: 'cl.ledger-db#acme', kind: 'Saturate', intensity: 1 })
  })
})
