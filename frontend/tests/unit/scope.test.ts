import { describe, expect, it } from 'vitest'
import { addressForTown, requestedScope, scopeParams } from '../../src/scope'

describe('the town and environment in the address', () => {
  it('are read from ?town= and ?env=, and are null when the address names none', () => {
    expect(requestedScope('?town=droid-shop&env=prod')).toEqual({ town: 'droid-shop', env: 'prod' })
    expect(requestedScope('?test=1')).toEqual({ town: null, env: null })
    expect(requestedScope('?town=&env=')).toEqual({ town: null, env: null })
  })

  it('go to the server as query parameters, and not at all for the defaults', () => {
    expect(scopeParams({ town: null, env: null })).toBe('')
    expect(scopeParams({ town: 'droid-shop', env: null })).toBe('town=droid-shop')
    expect(scopeParams({ town: 'droid-shop', env: 'prod' })).toBe('town=droid-shop&env=prod')
    expect(scopeParams({ town: null, env: 'a b' })).toBe('env=a+b')
  })
})

describe('the address for another town', () => {
  const shop = { id: 'droid-shop', name: 'Droid Shop', isDefault: false }
  const credit = { id: 'galactic-credit', name: 'Galactic Credit', isDefault: true }

  it('sets the town', () => {
    expect(addressForTown('', shop)).toBe('?town=droid-shop')
  })

  it('drops the environment and the islands, which mean nothing in another town', () => {
    expect(addressForTown('?env=staging&islands=pay,frd&town=galactic-credit', shop)).toBe('?town=droid-shop')
  })

  it('keeps everything else: the wall, the lighting, the layers', () => {
    expect(addressForTown('?wall=1&light=day&hide=traffic&islands=pay', shop)).toBe('?wall=1&light=day&hide=traffic&town=droid-shop')
  })

  it('leaves no ?town= when the default town is chosen', () => {
    expect(addressForTown('?town=droid-shop&wall=1', credit)).toBe('?wall=1')
    expect(addressForTown('?town=droid-shop', credit)).toBe('')
  })
})
