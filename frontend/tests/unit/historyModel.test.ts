import { describe, expect, it } from 'vitest'
import { addressAt, addressLive, advance, buildStrip, catchUpSeconds, fieldTime, fieldValue, frameFor, halfHourMark, historyAgeText, niceScale, quickPicks, requestedAt, sizeText, SPEEDS, stepMoves, stripExtremes, waitingText, stripTime, stripTip, stripX, viewedText } from '../../src/history/model'

const MIN = 60_000
const GAP = 5 * MIN
const NOW = new Date(2026, 10, 21, 14, 30, 0).getTime() // 21 Nov 2026 14:30, the browser's time

describe('speeds', () => {
  it('are 1x 2x 4x 15x 30x 60x', () => expect([...SPEEDS]).toEqual([1, 2, 4, 15, 30, 60]))
})

describe('the frame shown at a time', () => {
  const frames = [0, 5, 10].map((m) => ({ at: NOW + m * MIN, snapshot: m }))
  it('is the newest one at or before the time', () => {
    expect(frameFor(frames, NOW + 7 * MIN, GAP)?.snapshot).toBe(5)
    expect(frameFor(frames, NOW + 10 * MIN, GAP)?.snapshot).toBe(10)
  })
  it('is nothing before the first frame, and nothing more than two gaps after the last', () => {
    expect(frameFor(frames, NOW - MIN, GAP)).toBeNull()
    expect(frameFor(frames, NOW + 20 * MIN, GAP)?.snapshot).toBe(10)
    expect(frameFor(frames, NOW + 20 * MIN + 1, GAP)).toBeNull()
  })
})

describe('time running', () => {
  it('moves by real time times the speed and stands still when paused', () => {
    expect(advance(NOW, 1000, 60, false, NOW + 3_600_000)).toEqual({ viewed: NOW + 60_000, caughtUp: false })
    expect(advance(NOW, 1000, 60, true, NOW + 3_600_000)).toEqual({ viewed: NOW, caughtUp: false })
  })
  it('stops at now and says it caught up', () => {
    expect(advance(NOW - 1000, 1000, 4, false, NOW)).toEqual({ viewed: NOW, caughtUp: true })
  })
  it('takes the gap divided by speed minus one to catch up with live, never at 1x', () => {
    // 18 minutes back at 60x: 18 min / 59 = about 18 s; 36 minutes at 15x is 2.6 minutes
    expect(catchUpSeconds(NOW - 18 * MIN, NOW, 60)).toBeCloseTo((18 * 60) / 59, 5)
    expect(catchUpSeconds(NOW - 36 * MIN, NOW, 15)).toBeCloseTo((36 * 60) / 14, 5)
    expect(catchUpSeconds(NOW - MIN, NOW, 1)).toBeNull()
  })
})

describe('the quick picks', () => {
  it('are 1 h, 6 h, 12 h, 1 day, 3 days, 7 days and last midnight', () => {
    const picks = quickPicks(NOW, 14)
    expect(picks.map((p) => p.label)).toEqual(['1 h ago', '6 h ago', '12 h ago', '1 day ago', '3 days ago', '7 days ago', 'Midnight'])
    expect(picks[0].at).toBe(NOW - 3_600_000)
    expect(new Date(picks[6].at).getHours()).toBe(0)
    expect(new Date(picks[6].at).getDate()).toBe(21)
  })
  it('leave out what is further back than the limit', () => {
    expect(quickPicks(NOW, 3).map((p) => p.id)).toEqual(['1h', '6h', '12h', '1d', '3d', 'midnight'])
    expect(quickPicks(NOW, 1).map((p) => p.id)).toEqual(['1h', '6h', '12h', '1d', 'midnight'])
  })
})

describe('words and addresses', () => {
  it('writes a moment as the weekday, the date and the time', () => expect(viewedText(NOW)).toBe('Sat 21 Nov 14:30'))
  it('round-trips a date field', () => expect(fieldTime(fieldValue(NOW))).toBe(NOW))
  it('knows an empty or broken date field', () => {
    expect(fieldTime('')).toBeNull()
    expect(fieldTime('soon')).toBeNull()
  })
  it('reads ?at= and ignores nonsense', () => {
    expect(requestedAt('?env=prod&at=2026-11-21T09:00:00Z')).toBe(Date.UTC(2026, 10, 21, 9))
    expect(requestedAt('?at=whenever')).toBeNull()
    expect(requestedAt('')).toBeNull()
  })
  it('writes the address of a moment in UTC and keeps the rest of the address', () => {
    const at = { pathname: '/', search: '?env=prod&islands=a,b', hash: '' }
    expect(addressAt(at, Date.UTC(2026, 10, 21, 9, 0, 0, 500))).toBe('/?env=prod&islands=a,b&at=2026-11-21T09:00:00Z')
    expect(addressLive({ pathname: '/', search: '?env=prod&at=2026-11-21T09:00:00Z', hash: '' })).toBe('/?env=prod')
    expect(addressLive({ pathname: '/', search: '?at=2026-11-21T09:00:00Z', hash: '' })).toBe('/')
  })
})

describe('the strip', () => {
  const day = 24 * 3_600_000
  const g = { width: 1000, height: 40, from: NOW - 2 * day, to: NOW }
  it('puts moments on it and finds them again', () => {
    expect(stripX(g, g.from)).toBe(0)
    expect(stripX(g, g.to)).toBe(1000)
    expect(stripTime(g, 500)).toBe(Math.round(g.from + day))
    expect(stripTime(g, -50)).toBe(g.from)
    expect(stripTime(g, 5000)).toBe(g.to)
  })
  it('draws one stretch for frames a gap apart and breaks it where more than two gaps are missing', () => {
    const points = [0, 5, 10, 15, 60, 65].map((m) => ({ at: NOW - 100 * MIN + m * MIN, unhealthy: m === 10 ? 20 : 2 }))
    const s = buildStrip(points, g, GAP)
    expect(s.areas).toHaveLength(2)
    expect(s.lines).toHaveLength(2)
    expect(s.max).toBe(20)
    // the break between the two stretches, the time before the first and the time after the last are all gaps
    expect(s.gaps).toHaveLength(3)
  })
  it('scales to at least one, so a quiet town is a flat line at the bottom and not a scaled-up one', () => {
    const s = buildStrip([{ at: NOW - 10 * MIN, unhealthy: 0 }, { at: NOW - 5 * MIN, unhealthy: 0 }], g, GAP)
    expect(s.max).toBe(1)
    expect(s.lines[0]).toMatch(/^M[\d.]+ 38\.0 L[\d.]+ 38\.0$/)
  })
  it('draws a lone frame as a short bar and no frames as one gap', () => {
    expect(buildStrip([{ at: NOW - 60 * MIN, unhealthy: 3 }], g, GAP).areas).toHaveLength(1)
    const none = buildStrip([], g, GAP)
    expect(none.areas).toEqual([])
    expect(none.gaps).toEqual([[0, 1000]])
  })
  it('marks the midnights with the day', () => {
    const s = buildStrip([], g, GAP)
    expect(s.days.map((d) => d.label)).toEqual(['Fri 20', 'Sat 21'])
  })
  it('says what was true at a point, or that nothing was recorded', () => {
    const points = [{ at: NOW - 10 * MIN, unhealthy: 3, down: 1 }, { at: NOW - 5 * MIN, unhealthy: 0, down: 0 }]
    expect(stripTip(points, NOW - 8 * MIN, GAP)).toBe('Sat 21 Nov 14:22 · 3 degraded, 1 down')
    expect(stripTip(points, NOW - 5 * MIN, GAP)).toBe('Sat 21 Nov 14:25 · none degraded')
    expect(stripTip(points, NOW - 3 * 24 * 3_600_000, GAP)).toContain('no data recorded')
  })
})

describe('rebuilt frames on the strip', () => {
  const g = { width: 1000, height: 40, from: NOW - 100 * MIN, to: NOW }
  const points = [
    { at: NOW - 50 * MIN, unhealthy: 1, rebuilt: true },
    { at: NOW - 45 * MIN, unhealthy: 2, rebuilt: true },
    { at: NOW - 40 * MIN, unhealthy: 0, rebuilt: false },
    { at: NOW - 35 * MIN, unhealthy: 0, rebuilt: false },
  ]
  it('marks each run of rebuilt frames, up to the first recorded one after it', () => {
    const s = buildStrip(points, g, GAP)
    expect(s.rebuilt).toHaveLength(1)
    const [x, w] = s.rebuilt[0]
    expect(x).toBeCloseTo(stripX(g, NOW - 50 * MIN), 1)
    expect(x + w).toBeCloseTo(stripX(g, NOW - 40 * MIN), 1)
  })
  it('marks nothing when every frame was recorded', () => {
    expect(buildStrip(points.map((p) => ({ ...p, rebuilt: false })), g, GAP).rebuilt).toEqual([])
  })
  it('says in the tip that a rebuilt frame was rebuilt', () => {
    expect(stripTip(points.map((p) => ({ ...p, down: 0 })), NOW - 46 * MIN, GAP)).toContain('rebuilt from the cloud')
    expect(stripTip(points.map((p) => ({ ...p, down: 0 })), NOW - 36 * MIN, GAP)).not.toContain('rebuilt')
  })
})

describe('step and snap moves', () => {
  const at = (h: number, m: number): number => new Date(2026, 10, 22, h, m, 0, 0).getTime()
  const now = at(14, 5)
  it('finds the half-hour marks on each side and never the moment itself', () => {
    expect(halfHourMark(at(12, 40), true)).toBe(at(12, 30))
    expect(halfHourMark(at(12, 40), false)).toBe(at(13, 0))
    expect(halfHourMark(at(12, 30), true)).toBe(at(12, 0))
    expect(halfHourMark(at(12, 30), false)).toBe(at(13, 0))
    expect(halfHourMark(at(12, 5), true)).toBe(at(12, 0))
  })
  it('offers steps and the two nearest marks on each side, named by their clock', () => {
    const m = stepMoves(at(12, 40), now, 7)
    expect(m.steps.map((x) => x.label)).toEqual(['−1 h', '−30 m', '+30 m', '+1 h'])
    expect(m.steps.map((x) => x.at)).toEqual([at(11, 40), at(12, 10), at(13, 10), at(13, 40)])
    expect(m.snaps.map((x) => x.label)).toEqual(['12:00', '12:30', '13:00', '13:30'])
  })
  it('offers no forward step while live and no mark after now', () => {
    const m = stepMoves(now, now, 7)
    expect(m.steps.map((x) => x.label)).toEqual(['−1 h', '−30 m'])
    expect(m.snaps.map((x) => x.label)).toEqual(['13:30', '14:00'])
  })
  it('holds a forward step at now and drops what is older than the days kept', () => {
    const m = stepMoves(at(13, 50), now, 7)
    expect(m.steps.find((x) => x.label === '+1 h')!.at).toBe(now)
    const old = stepMoves(now - 7 * 86_400_000 + 20 * 60_000, now, 7)
    expect(old.steps.map((x) => x.label)).toEqual(['+30 m', '+1 h'])
  })
})

describe('the words of the loading card', () => {
  const at = new Date(2026, 10, 20, 5, 3).getTime()
  it('keeps the plain words until the server says where the hour stands', () => {
    expect(waitingText(at, null)).toContain('This can take a minute')
    expect(waitingText(at, { ahead: null, building: false, secondsPerHour: null })).toContain('This can take a minute')
  })
  it('says the hour is being built now, and that it is next', () => {
    expect(waitingText(at, { ahead: 0, building: true, secondsPerHour: 100 })).toContain('It is being built now (an hour takes about 2 min)')
    expect(waitingText(at, { ahead: 0, building: false, secondsPerHour: 100 })).toContain('It is next, about 2 min')
  })
  it('counts the hours ahead and gives a rough wait of them and its own', () => {
    const text = waitingText(at, { ahead: 2, building: false, secondsPerHour: 110 })
    expect(text).toContain('2 hours are built before it, so about 6 min')
    expect(text).toContain('Fri 20 Nov 05:03')
    expect(waitingText(at, { ahead: 1, building: false, secondsPerHour: null })).toBe('Rebuilding Fri 20 Nov 05:03 from the cloud. 1 hour is built before it. The clock waits for it.')
  })
})

describe('the words about what is held', () => {
  it('says the days of history, or hours when it is younger than a day', () => {
    expect(historyAgeText(NOW - 12 * 86_400_000, NOW)).toBe('12 days of history')
    expect(historyAgeText(NOW - 86_400_000, NOW)).toBe('1 day of history')
    expect(historyAgeText(NOW - 5 * 3_600_000, NOW)).toBe('5 hours of history')
    expect(historyAgeText(NOW - 20 * MIN, NOW)).toBe('Less than an hour of history')
  })

  it('says the size in MB from one MB up and in KB below', () => {
    expect(sizeText(36_819 * 1024)).toBe('36.0 MB')
    expect(sizeText(300 * 1024)).toBe('300 KB')
    expect(sizeText(10)).toBe('1 KB')
  })

  it('leaves the y scale of the strip at the highest count, never below 1', () => {
    const g = { width: 600, height: 60, from: NOW - 3_600_000, to: NOW }
    expect(buildStrip([{ at: NOW - 10 * MIN, unhealthy: 0 }], g, GAP).max).toBe(1)
    expect(buildStrip([{ at: NOW - 10 * MIN, unhealthy: 7 }, { at: NOW - 5 * MIN, unhealthy: 3 }], g, GAP).max).toBe(7)
  })
})

describe('the scale of the strip', () => {
  const g = { width: 600, height: 60, from: NOW - 3_600_000, to: NOW }
  it('rounds the top up to a round number with at most four steps', () => {
    expect(niceScale(27)).toEqual({ top: 30, step: 10 })
    expect(niceScale(1)).toEqual({ top: 1, step: 1 })
    expect(niceScale(3)).toEqual({ top: 3, step: 1 })
    expect(niceScale(5)).toEqual({ top: 6, step: 2 })
    expect(niceScale(7)).toEqual({ top: 8, step: 2 })
    expect(niceScale(40)).toEqual({ top: 40, step: 10 })
    expect(niceScale(41)).toEqual({ top: 60, step: 20 })
    expect(niceScale(120)).toEqual({ top: 150, step: 50 })
  })
  it('puts a mark at every step from 0 to the top, and the highest point under the top', () => {
    const s = buildStrip([{ at: NOW - 10 * MIN, unhealthy: 27 }, { at: NOW - 5 * MIN, unhealthy: 2 }], g, GAP)
    expect(s.top).toBe(30)
    expect(s.ticks.map((k) => k.value)).toEqual([0, 10, 20, 30])
    expect(s.ticks[0].y).toBeGreaterThan(s.ticks[3].y) // 0 is the lowest
    expect(s.lines[0]).toMatch(/^M[\d.]+ [\d.]+ L/)
    const y27 = Number(s.lines[0].split(' ')[1])
    expect(y27).toBeGreaterThan(s.ticks[3].y) // 27 is under the 30
    expect(y27).toBeLessThan(s.ticks[2].y) // and over the 20
  })
  it('names the worst and the best moment, the closest to now when several tie', () => {
    const points = [
      { at: NOW - 50 * MIN, unhealthy: 9 },
      { at: NOW - 40 * MIN, unhealthy: 0 },
      { at: NOW - 30 * MIN, unhealthy: 9 },
      { at: NOW - 20 * MIN, unhealthy: 3 },
      { at: NOW - 10 * MIN, unhealthy: 0 },
      { at: NOW - 5 * MIN, unhealthy: 2 },
    ]
    expect(stripExtremes(points, g.from, g.to)).toEqual({ worst: { at: NOW - 30 * MIN, unhealthy: 9 }, best: { at: NOW - 10 * MIN, unhealthy: 0 } })
    expect(stripExtremes(points, NOW - 25 * MIN, NOW)?.worst).toEqual({ at: NOW - 20 * MIN, unhealthy: 3 }) // only what is inside the range
    expect(stripExtremes([], g.from, g.to)).toBeNull()
  })
})
