// What the wall's status strip says, as data: a headline in words, how bad it is, and the numbers. Pure.

import type { Snapshot } from '../types'
import { formatCount, formatMs, formatRate } from '../visuals'
import { viewTotals } from '../viewTotals'
import { ALL_TENANTS } from '../tenants'
import { healthyCaption } from './calm'
import { dlqCount } from '../deadLetters'
import { isUnmonitored } from '../signals'

export type Tone = 'ok' | 'warn' | 'bad'

export interface StripModel {
  tone: Tone
  /** The big words: ALL SYSTEMS HEALTHY, or the counts of what is wrong. */
  headline: string
  /** The counts that make the headline, for the chips next to it. */
  counts: { incidents: number; down: number; degraded: number; stale: number }
  /** How many systems have dead letters waiting (the same systems the dashboard lists). The headline shows it in red next to the big words. */
  dlqSystems: number
  /** The red words beside the headline ("/ 3 with DLQ"), or '' when there are none, or when they already are the headline. */
  dlqLabel: string
  /** The numbers beside it. */
  numbers: { label: string; value: string; tone: Tone }[]
  /** The small line under the headline: for a healthy town, how long since the last incident. */
  subline: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Systems with dead letters waiting. A system with no fresh data or no dead-letter signal is left out, as everywhere else. */
export function dlqSystemCount(s: Snapshot): number {
  const nodes = [...s.groups.flatMap((g) => g.nodes), ...s.vendors.map((v) => v.node)]
  return nodes.filter((n) => n.state !== 'Stale' && !isUnmonitored(n) && dlqCount(n) > 0).length
}

export function stripModel(s: Snapshot): StripModel {
  const t = viewTotals(s, ALL_TENANTS)
  const counts = { incidents: t.incidents, down: t.down, degraded: t.degraded, stale: t.stale }
  const parts: string[] = []
  if (counts.incidents > 0) parts.push(plural(counts.incidents, 'incident'))
  if (counts.down > 0) parts.push(`${counts.down} down`)
  if (counts.degraded > 0) parts.push(`${counts.degraded} degraded`)
  if (counts.stale > 0) parts.push(`${counts.stale} with no data`)
  const dlqSystems = dlqSystemCount(s)
  // dead letters and nothing else wrong: the words for them are the headline, so the screen never says "healthy" over a queue nobody could handle
  const dlqAlone = parts.length === 0 && dlqSystems > 0
  const tone: Tone = counts.down > 0 || counts.incidents > 0 ? 'bad' : parts.length > 0 || dlqAlone ? 'warn' : 'ok'
  const numbers: StripModel['numbers'] = [
    { label: 'req/s', value: formatRate(t.requestsPerSecond), tone: 'ok' },
    { label: 'errors', value: `${(t.errorRate * 100).toFixed(1)}%`, tone: t.errorRate >= 0.05 ? 'bad' : t.errorRate >= 0.01 ? 'warn' : 'ok' },
    { label: 'p99', value: formatMs(t.p99Ms), tone: 'ok' },
    { label: 'DLQ', value: formatCount(t.deadLetters), tone: t.deadLetters > 0 ? 'bad' : 'ok' },
  ]
  return {
    tone,
    headline: parts.length > 0 ? parts.join(' · ').toUpperCase() : dlqAlone ? `${dlqSystems} WITH DLQ` : 'ALL SYSTEMS HEALTHY',
    counts,
    dlqSystems,
    dlqLabel: parts.length > 0 && dlqSystems > 0 ? `/ ${dlqSystems} with DLQ` : '',
    numbers,
    subline: parts.length > 0 || dlqAlone ? '' : healthyCaption(s).replace(/^All systems healthy,? ?/, ''),
  }
}
