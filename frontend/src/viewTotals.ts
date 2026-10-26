// The town's headline numbers as the viewer sees them. The backend works the totals out for the island filter (only what is on screen counts),
// so this adds the tenant choice on top: following some tenants shows their share of the traffic and the state of their own databases.

import type { HealthState, NodeSnapshot, Snapshot, TenantInfo, TownTotals } from './types'
import { isFollowing, isFollowed, type TenantView } from './tenants'

export interface ViewTotals extends TownTotals {
  /** Systems with no fresh data. */
  stale: number
  /** The share of the environment's traffic the chosen tenants bring (1 for all of them). */
  tenantShare: number
}

/** The tenants the viewer's choice leaves in: not the hidden test ones, and only the followed ones when some are followed. */
export function chosenTenants(tenants: readonly TenantInfo[], view: TenantView): TenantInfo[] {
  return tenants.filter((t) => !(view.hideTest && t.kind === 'Test') && (!isFollowing(view) || isFollowed(view, t.id)))
}

/** Their share of the traffic. An environment without tenants has nothing to split, so the share is 1. */
export function tenantShare(tenants: readonly TenantInfo[], view: TenantView): number {
  if (tenants.length === 0) return 1
  const total = tenants.reduce((a, t) => a + t.share, 0)
  if (total <= 0) return 1
  return chosenTenants(tenants, view).reduce((a, t) => a + t.share, 0) / total
}

const rank: Record<HealthState, number> = { Healthy: 0, Stale: 1, Degraded: 2, Down: 3 }

/**
 * The state a system counts as for this tenant choice. A data store with a database for each tenant counts as the worst of the chosen tenants'
 * databases (a store that is down stays down); every other system is as the snapshot says.
 */
export function stateFor(n: Pick<NodeSnapshot, 'state' | 'tenants'>, tenants: readonly TenantInfo[], view: TenantView): HealthState {
  if (!n.tenants || n.state === 'Down' || n.state === 'Stale') return n.state
  if (!isFollowing(view) && !view.hideTest) return n.state
  const chosen = new Set(chosenTenants(tenants, view).map((t) => t.id))
  const units = n.tenants.filter((u) => chosen.has(u.id))
  if (units.length === 0) return 'Healthy' // none of the chosen tenants has a database here to be in trouble
  const live = units.filter((u) => u.state !== 'Stale')
  if (live.length === 0) return 'Stale' // their databases have no fresh data: grey, never healthy
  return live.reduce<HealthState>((worst, u) => (rank[u.state] > rank[worst] ? u.state : worst), 'Healthy')
}

/** Systems and third parties with no fresh data. */
export function staleCount(s: Pick<Snapshot, 'groups' | 'vendors'>): number {
  return s.groups.reduce((a, g) => a + g.nodes.filter((n) => n.state === 'Stale').length, 0) + s.vendors.filter((v) => v.node.state === 'Stale').length
}

/**
 * What the top bar shows. With every tenant it is the snapshot's own totals. With a choice, requests per second are the chosen tenants' share and the
 * degraded and down counts follow their databases; errors, p99, dead letters and incidents are not split by tenant, so they stay as they are.
 */
export function viewTotals(s: Snapshot, view: TenantView): ViewTotals {
  const base = s.totals
  const stale = staleCount(s)
  const share = tenantShare(s.tenants ?? [], view)
  if (share === 1 && !isFollowing(view) && !view.hideTest) return { ...base, stale, tenantShare: 1 }
  const nodes = [...s.groups.flatMap((g) => g.nodes), ...s.vendors.map((v) => v.node)]
  const states = nodes.map((n) => stateFor(n, s.tenants ?? [], view))
  return {
    ...base,
    requestsPerSecond: base.requestsPerSecond * share,
    degraded: states.filter((x) => x === 'Degraded').length,
    down: states.filter((x) => x === 'Down').length,
    stale,
    tenantShare: share,
  }
}
