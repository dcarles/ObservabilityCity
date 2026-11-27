import { describe, expect, it } from 'vitest'
import { carEnds, carSignText, systemCode } from '../../src/scene/carLabel'
import { pickReach, SIGNS_BELOW } from '../../src/carSigns'

const node = (id: string, service?: string, serviceCode?: string) => ({ id, service: service ?? null, serviceCode: serviceCode ?? null })
const b = (n: ReturnType<typeof node>) => ({ node: n }) as never

describe('the short name a car sign uses for a system', () => {
  it('is the group code and the service code', () => {
    expect(systemCode(node('ams.accounts-api', 'accounts', 'as'))).toBe('ams.as')
  })
  it('falls back to the service name, then to the rest of the id', () => {
    expect(systemCode(node('chk.orders-api', 'orders'))).toBe('chk.orders')
    expect(systemCode(node('chk.cart-cache'))).toBe('chk.cart-cache')
  })
  it('keeps a hub building\'s own id', () => {
    expect(systemCode(node('hub.apim'))).toBe('hub.apim')
  })
  it('says ? when the building has no numbers yet', () => {
    expect(systemCode(null)).toBe('?')
  })
})

describe('the two ends of a car', () => {
  it('reads "from → to", with a car from outside saying outside', () => {
    const to = b(node('cl.mgs-api', 'mgs', 'mgs'))
    expect(carEnds({ from: null, to })).toEqual({ from: 'outside', to: 'cl.mgs' })
    expect(carSignText({ from: b(node('ams.accounts-api', 'accounts', 'as')), to })).toBe('ams.as → cl.mgs')
  })
})

describe('picking a small car', () => {
  it('lets the pointer miss by more metres the farther the camera is, with a floor close up', () => {
    expect(pickReach(10)).toBe(1.1)
    expect(pickReach(200)).toBeGreaterThan(pickReach(100))
    expect(SIGNS_BELOW).toBeGreaterThan(0)
  })
})
