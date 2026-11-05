import type { HealthEventSnapshot } from './types'
import type { PickItem } from './picker'
import { dayTime } from './inspectorModel'
import { requestedScope, scopeParams } from './scope'

/** The events of a snapshot; a town with no Azure health source sends none. */
export function healthEventsOf(events: readonly HealthEventSnapshot[] | null | undefined): HealthEventSnapshot[] {
  return events ? [...events] : []
}

const worse = (a: HealthEventSnapshot, b: HealthEventSnapshot): boolean =>
  (a.state === 'Unavailable' ? 0 : 1) < (b.state === 'Unavailable' ? 0 : 1) || (a.state === b.state && a.since < b.since)

export const isResolved = (e: HealthEventSnapshot): boolean => e.state === 'Resolved'

/** The worst open event of each building: Unavailable before Degraded, then the one open longest. Resolved ones and events with no building are left out: this is what marks a building. */
export function eventsByNode(events: readonly HealthEventSnapshot[] | null | undefined): Map<string, HealthEventSnapshot> {
  const m = new Map<string, HealthEventSnapshot>()
  for (const e of healthEventsOf(events)) {
    if (!e.nodeId || isResolved(e)) continue
    const have = m.get(e.nodeId)
    if (!have || worse(e, have)) m.set(e.nodeId, e)
  }
  return m
}

/** What a building says about Azure's word on it: its worst open event, or else the one that resolved last. Null when Azure said nothing of it. */
export function eventOfNode(events: readonly HealthEventSnapshot[] | null | undefined, nodeId: string): HealthEventSnapshot | null {
  const open = eventsByNode(events).get(nodeId)
  if (open) return open
  const done = healthEventsOf(events).filter((e) => e.nodeId === nodeId && isResolved(e)).sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
  return done[0] ?? null
}

/** "Degraded since 16:21 · was Available · cause Unknown": the one line an event gets in a list. */
export function eventLine(e: HealthEventSnapshot, now: number = Date.now()): string {
  if (isResolved(e)) return [`Resolved ${e.resolvedAt ? dayTime(e.resolvedAt, now) : ''}`.trim(), `was down since ${dayTime(e.since, now)}`, e.cause ? `cause ${e.cause}` : null].filter(Boolean).join(' · ')
  return [`${e.state} since ${dayTime(e.since, now)}`, e.previous ? `was ${e.previous}` : null, e.cause ? `cause ${e.cause}` : null].filter(Boolean).join(' · ')
}

/** Incidents-list lines for the events. One that matched no building is inert: it is listed, with nowhere to go. */
export function eventItems(events: readonly HealthEventSnapshot[] | null | undefined, whereOf: (nodeId: string) => string, now: number = Date.now()): PickItem[] {
  return healthEventsOf(events).map<PickItem>((e) => e.nodeId
    ? { kind: 'building', id: e.nodeId, name: e.resource, where: `Azure resource health · ${whereOf(e.nodeId)}`, detail: eventLine(e, now), state: e.state, dismiss: e.id }
    : { kind: 'building', id: e.id, name: e.resource, where: 'Azure resource health · not in the town', detail: eventLine(e, now), state: e.state, dismiss: e.id, inert: true })
}

export interface AzureRow {
  label: string
  value: string
  tone: 'bad' | 'warn' | 'ok'
}

/** The drawer rows for a building's report: the state and since when, what it was before, the cause, and which resource Azure means. A resolved one says when it ended, in green. */
export function azureRows(e: HealthEventSnapshot, now: number = Date.now()): AzureRow[] {
  const resolved = isResolved(e)
  const tone: AzureRow['tone'] = resolved ? 'ok' : e.state === 'Unavailable' ? 'bad' : 'warn'
  return [
    { label: 'State', value: e.state, tone },
    ...(resolved && e.resolvedAt ? [{ label: 'Resolved', value: dayTime(e.resolvedAt, now), tone } as AzureRow] : []),
    { label: resolved ? 'Began' : 'Since', value: dayTime(e.since, now), tone },
    ...(e.previous ? [{ label: 'Before', value: e.previous, tone } as AzureRow] : []),
    ...(e.cause ? [{ label: 'Cause', value: e.cause, tone } as AzureRow] : []),
    { label: 'Resource', value: e.resource, tone },
    ...(e.summary ? [{ label: 'Summary', value: e.summary, tone } as AzureRow] : []),
  ]
}

/** Hides one report (open or resolved) until the server restarts. Resolves true when the server knew it. */
export async function dismissEvent(id: string): Promise<boolean> {
  const q = scopeParams(requestedScope())
  const r = await fetch(`/api/health-events/dismiss${q ? `?${q}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
  return r.ok
}
