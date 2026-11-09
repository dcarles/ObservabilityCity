// The words for the overview stop of an alert tour: what the tour is about to visit. Pure.

import type { Snapshot } from '../types'
import type { Attention } from './attention'

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

/** "Overview: 3 systems need attention across 2 islands", or the incident count when only incidents are about. */
export function overviewCaption(s: Snapshot, attention: readonly Attention[]): string {
  const systems = attention.filter((a) => a.kind !== 'incident')
  const islands = new Set<string>()
  for (const a of attention) {
    if (a.focus.kind === 'island') islands.add(a.focus.id)
    else if (a.focus.kind === 'building') {
      const id = a.focus.id
      const g = s.groups.find((x) => x.nodes.some((n) => n.id === id))
      if (g) islands.add(g.id)
    }
  }
  if (systems.length === 0) return `Overview: ${plural(attention.length, 'incident')}`
  const where = islands.size > 0 ? ` across ${plural(islands.size, 'island')}` : ''
  return `Overview: ${plural(systems.length, 'system')} ${systems.length === 1 ? 'needs' : 'need'} attention${where}`
}
