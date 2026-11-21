// Time travel as plain functions: the speeds, the quick picks, where the viewed time is, which recorded frame it shows, and how the strip is drawn.
// Nothing here touches the page or the network, so each rule can be proven on its own.

import type { components } from '../contracts'

export type HistoryRange = components['schemas']['HistoryRange']
export type HistoryPoint = components['schemas']['HistoryPointSnapshot']

/** The speeds of time: how many seconds of the town's past go by in one real second. */
export const SPEEDS = [1, 2, 4, 15, 30, 60] as const
export type Speed = (typeof SPEEDS)[number]

export const isSpeed = (n: number): n is Speed => (SPEEDS as readonly number[]).includes(n)

/** A frame as the server sends it: when it was recorded (ms since 1970) and the snapshot as it was. */
export interface Frame {
  at: number
  snapshot: unknown
}

/** A frame older than two gaps than the viewed time is not what the town looked like then: the app was not recording. */
export function frameFor(frames: readonly Frame[], viewed: number, intervalMs: number): Frame | null {
  let found: Frame | null = null
  for (const f of frames) {
    if (f.at > viewed) break
    found = f
  }
  return found !== null && viewed - found.at <= intervalMs * 2 ? found : null
}

/** Moves the viewed time on by real time passed. A paused or loading clock stands still. Reaching now (or going past it) is "caught up". */
export function advance(viewed: number, realMs: number, speed: number, paused: boolean, now: number): { viewed: number; caughtUp: boolean } {
  if (paused) return { viewed, caughtUp: false }
  const next = viewed + realMs * speed
  return next >= now ? { viewed: now, caughtUp: true } : { viewed: next, caughtUp: false }
}

/** Real seconds until the viewed time reaches live, the moment the town is at now and time runs at this speed (live keeps moving at 1x): gap / (speed - 1). Never at 1x. */
export function catchUpSeconds(viewed: number, now: number, speed: number): number | null {
  return speed <= 1 ? null : Math.max(0, (now - viewed) / 1000 / (speed - 1))
}

export interface QuickPick {
  id: string
  label: string
  /** The moment it goes to (ms since 1970). */
  at: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The moments the popup offers at once: 1 h, 6 h, 12 h, 1, 3 and 7 days back and last midnight (the browser's own). Those beyond the limit are left out. */
export function quickPicks(now: number, days: number): QuickPick[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const picks: QuickPick[] = [
    { id: '1h', label: '1 h ago', at: now - HOUR },
    { id: '6h', label: '6 h ago', at: now - 6 * HOUR },
    { id: '12h', label: '12 h ago', at: now - 12 * HOUR },
    { id: '1d', label: '1 day ago', at: now - DAY },
    { id: '3d', label: '3 days ago', at: now - 3 * DAY },
    { id: '7d', label: '7 days ago', at: now - 7 * DAY },
    { id: 'midnight', label: 'Midnight', at: midnight.getTime() },
  ]
  return picks.filter((p) => p.at >= now - days * DAY)
}

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sat 21 Nov 09:12", in the browser's time. */
export function viewedText(at: number): string {
  const d = new Date(at)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The same moment with seconds, for the clock that runs at the speed of time. */
export function clockText(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** What a date field of the kind `datetime-local` holds for this moment (the browser's time, to the minute). */
export function fieldValue(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The moment a date field holds, or null when it is empty or not a date. */
export function fieldTime(value: string): number | null {
  if (!value) return null
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/** The time asked for in an address (?at=2026-11-21T09:00:00Z), or null when there is none or it is not a time. */
export function requestedAt(search: string): number | null {
  const raw = new URLSearchParams(search).get('at')
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

/** The address of this page looking at this moment: everything else in the address stays. The moment is in UTC to the second, so it means the same to everyone. */
export function addressAt(at: { pathname: string; search: string; hash: string }, moment: number): string {
  const q = new URLSearchParams(at.search)
  q.set('at', new Date(Math.floor(moment / 1000) * 1000).toISOString().replace('.000Z', 'Z'))
  return `${at.pathname}?${q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':')}${at.hash}`
}

/** The address without a moment: back to live. */
export function addressLive(at: { pathname: string; search: string; hash: string }): string {
  const q = new URLSearchParams(at.search)
  q.delete('at')
  const text = q.toString().replace(/%2C/g, ',')
  return `${at.pathname}${text ? `?${text}` : ''}${at.hash}`
}

/** The speed's words: "1x", "15x". */
export const speedText = (s: number): string => `${s}x`

// ---- the strip

export interface StripGeometry {
  width: number
  height: number
  /** The earliest moment drawn and the latest (now). */
  from: number
  to: number
}

export interface Strip {
  /** The areas of recorded stretches, one path for each unbroken stretch. */
  areas: string[]
  /** Where the line of each stretch is, to draw on top of the area. */
  lines: string[]
  /** The stretches with no recording: [x, width]. */
  gaps: [number, number][]
  /** The midnights inside the range: x and the day's label. */
  days: { x: number; label: string }[]
  /** The largest count drawn (never below 1, so a quiet town is a flat line and not a scaled-up one). */
  max: number
}

/** The x of a moment on the strip. */
export const stripX = (g: StripGeometry, at: number): number => ((at - g.from) / (g.to - g.from)) * g.width

/** The moment at an x on the strip, held inside the range. */
export function stripTime(g: StripGeometry, x: number): number {
  const t = g.from + (Math.min(g.width, Math.max(0, x)) / g.width) * (g.to - g.from)
  return Math.round(t)
}

/**
 * The strip: how many systems were not healthy (degraded or down, dead letters not counted) at each recorded moment, as a line chart over the whole range.
 * A stretch where two recorded moments are more than two gaps apart is broken: nothing is drawn across it, and it shows as a gap, never as a flat line that looks fine.
 */
export function buildStrip(points: readonly { at: number; unhealthy: number }[], g: StripGeometry, intervalMs: number): Strip {
  const max = Math.max(1, ...points.map((p) => p.unhealthy))
  const top = 4
  const base = g.height - 2
  const y = (n: number): number => base - (n / max) * (base - top)
  const stretches: { at: number; unhealthy: number }[][] = []
  for (const p of points) {
    if (p.at < g.from || p.at > g.to) continue
    const current = stretches[stretches.length - 1]
    if (current && p.at - current[current.length - 1].at <= intervalMs * 2) current.push(p)
    else stretches.push([p])
  }
  const areas: string[] = []
  const lines: string[] = []
  const gaps: [number, number][] = []
  let cursor = 0
  for (const s of stretches) {
    // a lone frame is drawn as a short bar one gap wide, so it can be seen and clicked
    const first = stripX(g, s[0].at)
    const last = s.length === 1 ? Math.min(g.width, first + Math.max(2, (intervalMs / (g.to - g.from)) * g.width)) : stripX(g, s[s.length - 1].at)
    if (first > cursor) gaps.push([cursor, first - cursor])
    cursor = last
    const xy = s.length === 1 ? [[first, y(s[0].unhealthy)], [last, y(s[0].unhealthy)]] : s.map((p) => [stripX(g, p.at), y(p.unhealthy)])
    const line = xy.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${yy.toFixed(1)}`).join(' ')
    lines.push(line)
    areas.push(`${line} L${last.toFixed(1)} ${base} L${first.toFixed(1)} ${base} Z`)
  }
  if (cursor < g.width) gaps.push([cursor, g.width - cursor])
  const days: { x: number; label: string }[] = []
  const d = new Date(g.from)
  d.setHours(24, 0, 0, 0)
  for (; d.getTime() < g.to; d.setDate(d.getDate() + 1)) days.push({ x: stripX(g, d.getTime()), label: `${WEEKDAYS[d.getDay()]} ${d.getDate()}` })
  return { areas, lines, gaps, days, max }
}

/** The words for a point on the strip: the time, and how many were unhealthy then, or that nothing was recorded. */
export function stripTip(points: readonly HistoryPoint[] | readonly { at: number; unhealthy: number; down: number }[], at: number, intervalMs: number): string {
  let best: { at: number; unhealthy: number; down: number } | null = null
  for (const p of points) {
    const t = typeof p.at === 'number' ? p.at : Date.parse(p.at)
    if (t <= at && (best === null || t > best.at)) best = { at: t, unhealthy: p.unhealthy, down: p.down }
  }
  if (best === null || at - best.at > intervalMs * 2) return `${viewedText(at)} · no data recorded`
  const worse = best.unhealthy === 0 ? 'none degraded' : `${best.unhealthy} degraded${best.down > 0 ? `, ${best.down} down` : ''}`
  return `${viewedText(at)} · ${worse}`
}
