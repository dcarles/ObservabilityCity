import { describe, expect, it } from 'vitest'
import { trafficSplit } from '../../src/trafficSplit'

const town = (over: Record<string, unknown> = {}, absent: string[] = []) =>
  ({ outsideRequestsPerSecond: 12, externalCallers: [{ name: 'Partner', requestsPerSecond: 5 }], groups: [{ nodes: [{ id: 'a', absent }] }], vendors: [], ...over }) as any

describe('trafficSplit', () => {
  it('internal traffic is the total less what comes from outside', () => {
    const s = trafficSplit(town(), 50)!
    expect(s).toEqual({ total: 50, external: 12, internal: 38 })
  })

  it('uses the callers the hub declares when the server has not measured the outside part', () => {
    expect(trafficSplit(town({ outsideRequestsPerSecond: undefined }), 50)!.internal).toBe(45)
  })

  it('never shows more from outside than the total, nor internal traffic below zero', () => {
    expect(trafficSplit(town({ outsideRequestsPerSecond: 90 }), 50)).toEqual({ total: 50, external: 50, internal: 0 })
  })

  it('follows the share of the traffic on view', () => {
    expect(trafficSplit(town(), 25, 0.5)).toEqual({ total: 25, external: 6, internal: 19 })
  })

  it('is null when no system reports a request rate, so there is nothing to show', () => {
    expect(trafficSplit(town({}, ['requests']), 0)).toBeNull()
  })
})
