// The calls an API serves and how its requests divide by HTTP method, as words. Pure, so the drawer, the island sign and the tests all say the same thing.
// The numbers come from the environment's routes query; an environment without one has none, and nothing here is written for it.

import type { NodeSnapshot } from './types'
import { formatRate } from './visuals'
import { systemCode } from './scene/carLabel'

export type CallTone = 'warn' | 'bad' | ''

export interface CallLine {
  method: string
  route: string
  /** "46 rps" */
  rate: string
  /** "0.4% errors", empty when none failed. */
  errors: string
  tone: CallTone
}

export interface MethodLine {
  method: string
  /** "78%" */
  share: string
  /** "46 rps" */
  rate: string
  /** 0 to 100, for a bar. */
  percent: number
}

const pct = (v: number): string => (v > 0 && v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`)
const rps = (v: number): string => `${formatRate(v)} rps`

/** The busiest calls of an API, highest first, with the share of each that failed coloured against the system's own error lines. Empty when nothing measures them. */
export function callLines(n: NodeSnapshot): CallLine[] {
  return (n.routes ?? []).map((r) => ({
    method: r.method,
    route: r.route,
    rate: rps(r.perSecond),
    errors: r.errorRate > 0 ? `${r.errorRate < 0.001 ? '<0.1' : (r.errorRate * 100).toFixed(1)}% errors` : '',
    tone: r.errorRate >= n.errorRed ? 'bad' : r.errorRate >= n.errorAmber ? 'warn' : '',
  }))
}

/** How an API's requests divide by method, highest first. Empty when nothing measures it. */
export function methodLines(n: Pick<NodeSnapshot, 'methods'>): MethodLine[] {
  return (n.methods ?? []).map((m) => ({ method: m.method, share: pct(m.share), rate: rps(m.perSecond), percent: Math.round(m.share * 100) }))
}

/** How many calls the island sign lists. */
export const SIGN_CALLS = 3

/** What one island's sign says when hovered, for its systems that measure their calls: the busiest calls of all of them (with the system that serves each), and the method split of all together. Empty when none does. */
export function groupCallWords(nodes: readonly NodeSnapshot[]): string[] {
  const serving = nodes.filter((n) => (n.routes?.length ?? 0) > 0)
  if (serving.length === 0) return []
  const calls = serving.flatMap((n) => (n.routes ?? []).map((r) => ({ n, r }))).sort((a, b) => b.r.perSecond - a.r.perSecond).slice(0, SIGN_CALLS)
  const perMethod = new Map<string, number>()
  for (const n of serving) for (const m of n.methods ?? []) perMethod.set(m.method, (perMethod.get(m.method) ?? 0) + m.perSecond)
  const total = [...perMethod.values()].reduce((a, b) => a + b, 0)
  const lines = ['Top calls', ...calls.map(({ n, r }) => `${r.method} ${r.route} · ${systemCode(n)} · ${rps(r.perSecond)}`)]
  if (total > 0) lines.push(`Methods ${[...perMethod].sort((a, b) => b[1] - a[1]).map(([m, v]) => `${m} ${pct(v / total)}`).join(' · ')}`)
  return lines
}
