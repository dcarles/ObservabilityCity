// What the wall's status strip says, as data: a headline in words, how bad it is, and the numbers. Pure.

import type { Snapshot } from '../types'
import { formatMs, formatRate } from '../visuals'
import { viewTotals } from '../viewTotals'
import { ALL_TENANTS } from '../tenants'
import { healthyCaption } from './calm'

export type Tone = 'ok' | 'warn' | 'bad'

export interface StripModel {
  tone: Tone
  /** The big words: ALL SYSTEMS HEALTHY, or the counts of what is wrong. */
  headline: string
  /** The counts that make the headline, for the chips next to it. */
  counts: { incidents: number; down: number; degraded: number; stale: number }
  /** The numbers beside it. */
  numbers: { label: string; value: string; tone: Tone }[]
  /** The small line under the headline: for a healthy town, how long since the last incident. */
  subline: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export function stripModel(s: Snapshot): StripModel {
  const t = viewTotals(s, ALL_TENANTS)
  const counts = { incidents: t.incidents, down: t.down, degraded: t.degraded, stale: t.stale }
  const parts: string[] = []
  if (counts.incidents > 0) parts.push(plural(counts.incidents, 'incident'))
  if (counts.down > 0) parts.push(`${counts.down} down`)
  if (counts.degraded > 0) parts.push(`${counts.degraded} degraded`)
  if (counts.stale > 0) parts.push(`${counts.stale} with no data`)
  const tone: Tone = counts.down > 0 || counts.incidents > 0 ? 'bad' : parts.length > 0 ? 'warn' : 'ok'
  const numbers: StripModel['numbers'] = [
    { label: 'req/s', value: formatRate(t.requestsPerSecond), tone: 'ok' },
    { label: 'errors', value: `${(t.errorRate * 100).toFixed(1)}%`, tone: t.errorRate >= 0.05 ? 'bad' : t.errorRate >= 0.01 ? 'warn' : 'ok' },
    { label: 'p99', value: formatMs(t.p99Ms), tone: 'ok' },
    { label: 'DLQ', value: formatRate(t.deadLetters), tone: t.deadLetters > 0 ? 'bad' : 'ok' },
  ]
  return {
    tone,
    headline: parts.length > 0 ? parts.join(' · ').toUpperCase() : 'ALL SYSTEMS HEALTHY',
    counts,
    numbers,
    subline: parts.length > 0 ? '' : healthyCaption(s).replace(/^All systems healthy,? ?/, ''),
  }
}
