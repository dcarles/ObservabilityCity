import { describe, expect, it } from 'vitest'
import { dashPlaceOf } from '../../src/dashboard/wallPlace'

const groups = [
  { id: 'aa', nodes: [{ id: 'aa.api' }, { id: 'aa.db' }] },
  { id: 'bb', nodes: [{ id: 'bb.api' }] },
  { id: 'hub', nodes: [{ id: 'hub.bus' }] },
]
const pillars = ['aa', 'bb']

describe('where the wall dashboard looks', () => {
  it('opens the pillar for an island', () => {
    expect(dashPlaceOf({ kind: 'island', id: 'bb' }, groups, pillars)).toEqual({ pillar: 'bb', system: null })
  })

  it('opens the pillar that has the service, and picks the service out', () => {
    expect(dashPlaceOf({ kind: 'building', id: 'aa.db' }, groups, pillars)).toEqual({ pillar: 'aa', system: 'aa.db' })
  })

  it('has no place for the hub, a pillar the view left out or a service nobody has', () => {
    expect(dashPlaceOf({ kind: 'island', id: 'hub' }, groups, pillars)).toBeNull()
    expect(dashPlaceOf({ kind: 'building', id: 'hub.bus' }, groups, pillars)).toBeNull()
    expect(dashPlaceOf({ kind: 'building', id: 'aa.api' }, groups, ['bb'])).toBeNull()
    expect(dashPlaceOf({ kind: 'building', id: 'zz' }, groups, pillars)).toBeNull()
  })

  it('goes back to the top for home', () => {
    expect(dashPlaceOf({ kind: 'home', id: '' }, groups, pillars)).toBeNull()
  })
})
