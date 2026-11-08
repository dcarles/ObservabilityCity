import { describe, expect, it } from 'vitest'
import { DEFAULT_HOLD_SECONDS, DEFAULT_RETRY_SECONDS, WALL_KEY, parseWall, rememberWall, wallRemembered, withoutWall } from '../../src/wall/params'
import type { Store } from '../../src/lighting'

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('wall mode in the address', () => {
  it('is off without ?wall', () => {
    expect(parseWall('').on).toBe(false)
    expect(parseWall('?test=1&islands=pay').on).toBe(false)
  })

  it.each(['?wall=1', '?wall', '?wall=true', '?wall=yes'])('is on for %s', (search) => {
    expect(parseWall(search).on).toBe(true)
  })

  it.each(['?wall=0', '?wall=false', '?wall=off', '?wall=FALSE'])('is off for %s', (search) => {
    expect(parseWall(search).on).toBe(false)
  })

  it('holds 20 seconds at a stop unless told otherwise', () => {
    expect(DEFAULT_HOLD_SECONDS).toBe(20)
    expect(parseWall('?wall=1').hold).toBe(20)
    expect(parseWall('?wall=1&hold=45').hold).toBe(45)
    expect(parseWall('?wall=1&hold=1.5').hold).toBe(1.5)
  })

  it('ignores a hold that makes no sense', () => {
    expect(parseWall('?wall=1&hold=abc').hold).toBe(20)
    expect(parseWall('?wall=1&hold=0').hold).toBe(20)
    expect(parseWall('?wall=1&hold=-5').hold).toBe(20)
    expect(parseWall('?wall=1&hold=').hold).toBe(20)
  })

  it('tries to open the connection again every 5 seconds unless told otherwise', () => {
    expect(DEFAULT_RETRY_SECONDS).toBe(5)
    expect(parseWall('?wall=1').retry).toBe(5)
    expect(parseWall('?wall=1&retry=1').retry).toBe(1)
    expect(parseWall('?wall=1&retry=0').retry).toBe(5)
  })
})

describe('wall mode this browser remembers', () => {
  it('is off in a browser that was never told', () => {
    expect(parseWall('', memory()).on).toBe(false)
    expect(wallRemembered(memory())).toBe(false)
  })

  it('opens as a wall after the Wall button, with nothing in the address', () => {
    const s = memory()
    rememberWall(s, true)
    expect(s.data.get(WALL_KEY)).toBe('1')
    expect(parseWall('', s).on).toBe(true)
    expect(parseWall('?view=dashboard&hold=30', s)).toMatchObject({ on: true, hold: 30 })
  })

  it('?wall=0 turns it off and the browser forgets it', () => {
    const s = memory()
    rememberWall(s, true)
    expect(parseWall('?wall=0', s).on).toBe(false)
    expect(wallRemembered(s)).toBe(false)
    expect(parseWall('', s).on).toBe(false)
  })

  it('?wall=1 is a wall without being remembered', () => {
    const s = memory()
    expect(parseWall('?wall=1', s).on).toBe(true)
    expect(wallRemembered(s)).toBe(false)
  })

  it('leaving it forgets it', () => {
    const s = memory()
    rememberWall(s, true)
    rememberWall(s, false)
    expect(parseWall('', s).on).toBe(false)
  })

  it('survives a browser that will not store anything', () => {
    const broken: Store = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => rememberWall(broken, true)).not.toThrow()
    expect(parseWall('', broken).on).toBe(false)
    expect(parseWall('?wall=1', broken).on).toBe(true)
    expect(parseWall('', null).on).toBe(false)
  })

  it('leaves the address as it was, without wall', () => {
    expect(withoutWall({ pathname: '/', search: '?wall=1&view=dashboard&islands=a,b&hold=5', hash: '#x' })).toBe('/?view=dashboard&islands=a,b&hold=5#x')
    expect(withoutWall({ pathname: '/', search: '?wall=0', hash: '' })).toBe('/')
    expect(withoutWall({ pathname: '/', search: '', hash: '' })).toBe('/')
  })
})
