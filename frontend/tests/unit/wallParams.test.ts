import { describe, expect, it } from 'vitest'
import { DEFAULT_HOLD_SECONDS, DEFAULT_RETRY_SECONDS, parseWall } from '../../src/wall/params'

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
