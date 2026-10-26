import { describe, expect, it } from 'vitest'
import { sinceIncidentText, spanText } from '../../src/wall/since'

const MIN = 60_000
const H = 60 * MIN

describe('a span in words', () => {
  it('is minutes up to two hours, hours up to two days, then days', () => {
    expect(spanText(10_000)).toBe('under a minute')
    expect(spanText(MIN)).toBe('1 min')
    expect(spanText(42 * MIN)).toBe('42 min')
    expect(spanText(119 * MIN)).toBe('119 min')
    expect(spanText(2 * H)).toBe('2 h')
    expect(spanText(47 * H + 50 * MIN)).toBe('47 h')
    expect(spanText(48 * H)).toBe('2 days')
    expect(spanText(100 * H)).toBe('4 days')
  })

  it('does not go below nothing when the clocks disagree', () => {
    expect(spanText(-5 * MIN)).toBe('under a minute')
  })
})

describe('the time since the last incident', () => {
  const at = '2026-10-26T12:00:00+00:00'

  it('counts from when the islands on screen last had an incident', () => {
    expect(sinceIncidentText({ generatedAt: at, incidentFreeSince: '2026-10-26T09:00:00+00:00', incidentsSeen: true })).toBe('3 h since last incident')
    expect(sinceIncidentText({ generatedAt: at, incidentFreeSince: '2026-10-26T11:18:00+00:00', incidentsSeen: true })).toBe('42 min since last incident')
  })

  it('does not claim a record it cannot know: with none seen it says how long it has been watching', () => {
    expect(sinceIncidentText({ generatedAt: at, incidentFreeSince: '2026-10-26T09:00:00+00:00', incidentsSeen: false })).toBe('no incident since watching began 3 h ago')
  })

  it('says nothing while an incident is open', () => {
    expect(sinceIncidentText({ generatedAt: at, incidentFreeSince: null, incidentsSeen: true })).toBeNull()
    expect(sinceIncidentText({ generatedAt: at })).toBeNull()
  })
})
