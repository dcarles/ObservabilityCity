import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkSnapshot } from '../../src/snapshotGuard'

// town.yaml's trafficDensity reaches the page in the snapshot: a multiple of the usual number of cars, 1 when the server says nothing sensible.
const raw = () => JSON.parse(readFileSync(resolve(__dirname, '../../../shared-test-data/snapshots/calm.json'), 'utf8')) as Record<string, unknown>

describe('the snapshot\'s traffic density', () => {
  it('is carried to the page as it came', () => {
    expect(checkSnapshot({ ...raw(), trafficDensity: 3 }).snapshot!.trafficDensity).toBe(3)
    expect(checkSnapshot({ ...raw(), trafficDensity: 0.5 }).snapshot!.trafficDensity).toBe(0.5)
  })

  it('is 1, the usual look, when it is missing', () => {
    const r = raw()
    delete r.trafficDensity
    expect(checkSnapshot(r).snapshot!.trafficDensity).toBe(1)
  })

  it('is 1 when it is not a positive number, which a car rate cannot use', () => {
    for (const bad of [0, -2, 'lots', null, Number.NaN]) expect(checkSnapshot({ ...raw(), trafficDensity: bad }).snapshot!.trafficDensity).toBe(1)
  })
})
