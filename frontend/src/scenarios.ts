// The Break things panel's rules, apart from the page: which scenarios exist, what an effect is called, and how a scenario meets its target.

export type EffectKind =
  | 'Traffic' | 'Errors' | 'Latency' | 'UnhealthyInstances' | 'Down' | 'HighCpu' | 'HighMemory'
  | 'Saturate' | 'Backlog' | 'Poison' | 'Stale' | 'Incident'

export interface Scenario {
  id: string
  label: string
  kind: EffectKind
  /** How strong it starts, 0 to 1. */
  intensity: number
  hint?: string
  /** Aimed at one tenant's database: the target becomes store#tenant. */
  tenant?: boolean
}

export const SCENARIOS: readonly Scenario[] = [
  { id: 'traffic', label: 'Traffic spike', kind: 'Traffic', intensity: 0.8 },
  { id: 'slow', label: 'Slow', kind: 'Latency', intensity: 0.6 },
  { id: 'errors', label: 'Errors', kind: 'Errors', intensity: 0.4 },
  { id: 'sick', label: 'Sick instances', kind: 'UnhealthyInstances', intensity: 0.5 },
  { id: 'cpu', label: 'High CPU', kind: 'HighCpu', intensity: 1 },
  { id: 'memory', label: 'High memory', kind: 'HighMemory', intensity: 1 },
  { id: 'saturate', label: 'DB saturated', kind: 'Saturate', intensity: 1 },
  { id: 'tenant-db', label: 'Tenant DB throttled', kind: 'Saturate', intensity: 1, tenant: true, hint: 'Hits the database of the tenant picked in the top bar (or the first customer if none or several)' },
  { id: 'backlog', label: 'Queue backs up', kind: 'Backlog', intensity: 1 },
  { id: 'poison', label: 'Dead letters', kind: 'Poison', intensity: 1 },
  { id: 'down', label: 'Down', kind: 'Down', intensity: 1 },
  { id: 'quiet', label: 'Go quiet', kind: 'Stale', intensity: 1 },
  { id: 'sev1', label: 'Sev 1 storm', kind: 'Incident', intensity: 1, hint: 'Storm over the island' },
  { id: 'sev2', label: 'Sev 2 rain', kind: 'Incident', intensity: 0.7, hint: 'Rain over the island' },
  { id: 'sev3', label: 'Sev 3 overcast', kind: 'Incident', intensity: 0.45, hint: 'Overcast over the island' },
  { id: 'sev4', label: 'Sev 4 clouds', kind: 'Incident', intensity: 0.2, hint: 'A few light clouds over the island' },
]

/** Effects that ignore their intensity, so the chip has no slider. */
const FIXED: ReadonlySet<EffectKind> = new Set(['Down', 'Stale'])
export const hasIntensity = (kind: string): boolean => !FIXED.has(kind as EffectKind)

const KIND_LABEL: Record<string, string> = {
  Traffic: 'Traffic spike', Errors: 'Errors', Latency: 'Slow', UnhealthyInstances: 'Sick instances', Down: 'Down', HighCpu: 'High CPU',
  HighMemory: 'High memory', Saturate: 'DB saturated', Backlog: 'Queue backs up', Poison: 'Dead letters', Stale: 'Gone quiet',
}

/** What an active effect is called on its chip. An incident is named by how bad it is. */
export function effectLabel(kind: string, intensity: number): string {
  if (kind === 'Incident') return intensity >= 0.85 ? 'Sev 1 storm' : intensity >= 0.6 ? 'Sev 2 rain' : intensity >= 0.35 ? 'Sev 3 overcast' : 'Sev 4 clouds'
  return KIND_LABEL[kind] ?? kind
}

/** The target text of a request: a tenant scenario aims at the store's database for one tenant. */
export function targetFor(scenario: Scenario, target: string, tenant: string | undefined): string | null {
  if (!scenario.tenant) return target
  if (!tenant || target === '*') return null
  return `${target}#${tenant}`
}

/** The tenant a tenant scenario should hit: the one tenant followed in the top bar, else the first customer. */
export function tenantToHit(followed: readonly string[], tenants: readonly { id: string; kind: string }[]): string | undefined {
  return followed.length === 1 ? followed[0] : tenants.find((t) => t.kind === 'Customer')?.id
}

export interface FxRequest { target: string; kind: EffectKind; intensity: number }

/**
 * A scenario picked from the panel waits for its target: a click on a building in the town, or a pick from the search. A target chosen first
 * is kept for the next scenario. Either order ends in one request.
 */
export class Aim {
  private armed: Scenario | null = null
  private chosen: string | null = null

  get scenario(): Scenario | null { return this.armed }
  get target(): string | null { return this.chosen }

  /** Picks a scenario. With a target already chosen it fires at once, else it waits for one; picking the same scenario again lets go of it. */
  arm(s: Scenario, tenant: string | undefined): FxRequest | null {
    if (this.armed?.id === s.id) { this.armed = null; return null }
    if (this.chosen !== null) {
      const r = this.build(s, this.chosen, tenant)
      this.chosen = null
      this.armed = r ? null : s
      return r
    }
    this.armed = s
    return null
  }

  /** A target came in (clicked in the town, or picked from the search). Fires the waiting scenario, or is kept for the next one. */
  aim(target: string, tenant: string | undefined): FxRequest | null {
    if (!this.armed) { this.chosen = target; return null }
    const r = this.build(this.armed, target, tenant)
    if (r) this.armed = null
    return r
  }

  cancel(): void { this.armed = null; this.chosen = null }

  private build(s: Scenario, target: string, tenant: string | undefined): FxRequest | null {
    const t = targetFor(s, target, tenant)
    return t === null ? null : { target: t, kind: s.kind, intensity: s.intensity }
  }
}
