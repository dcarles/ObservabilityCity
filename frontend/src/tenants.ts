// How tenants look, as pure functions: units from a snapshot in, colours, heights, counts and sign text out.
// Nothing here touches three.js, so it is unit tested against the same golden fixture as the backend.

import type { NodeSnapshot, PartSnapshot, TenantInfo, TenantUnitSnapshot } from './types'
import { clamp } from './visuals'

/** The colour of a tenant's unit. Grey is a database that was not found or has no fresh data. */
export type TenantLevel = 'green' | 'amber' | 'red' | 'grey'

/** What the viewer chose to see of the tenants: hide the test ones, and/or follow some tenants. */
export interface TenantView {
  hideTest: boolean
  /** The tenants to follow; empty for all of them. Every other tenant's unit is dimmed, and only the followed tenants' cars are drawn. */
  tenants: readonly string[]
}

export const ALL_TENANTS: TenantView = { hideTest: false, tenants: [] }

/** The words next to a tenant in the dropdown when the environment lists it and no tenant database reports it, or null. */
export function tenantNote(t: Pick<TenantInfo, 'notFound'>): { text: string; title: string } | null {
  return t.notFound ? { text: 'not found', title: 'The environment lists this tenant, but no tenant database for it was found. Check the id, or whether the tenant has gone.' } : null
}

/** True when the viewer follows some tenants (and not simply all of them). */
export const isFollowing = (view: TenantView): boolean => view.tenants.length > 0

/** True when this tenant is one the viewer follows. Nobody is followed when the selection is empty. */
export const isFollowed = (view: TenantView, id: string): boolean => view.tenants.includes(id)

/**
 * Green, amber or red from the unit's state, which the backend worked out against the store's thresholds. A test tenant is amber at worst
 * whatever it says: its trouble is never an alarm.
 */
export function tenantLevel(u: Pick<TenantUnitSnapshot, 'state' | 'kind'>): TenantLevel {
  if (u.state === 'Stale') return 'grey'
  if (u.state === 'Down') return u.kind === 'Test' ? 'amber' : 'red'
  return u.state === 'Degraded' ? 'amber' : 'green'
}

/** Test tenants can be hidden; the rest always show. */
export const isShown = (u: Pick<TenantUnitSnapshot, 'kind'>, view: TenantView): boolean => !(view.hideTest && u.kind === 'Test')

/** The units the yard draws, in order. */
export function shownUnits(units: readonly TenantUnitSnapshot[], view: TenantView): TenantUnitSnapshot[] {
  return units.filter((u) => isShown(u, view))
}

/** A unit is throttling when its database turns away at least the store's amber share of requests. */
export const isThrottled = (u: Pick<TenantUnitSnapshot, 'throttled'>, throttleAmber: number): boolean => (u.throttled ?? 0) >= throttleAmber && (u.throttled ?? 0) > 0

/**
 * The tenants in the order the inspector lists them: the ones in trouble first (down, then degraded, then any that is turning requests away),
 * then the rest by how much of their capacity they use. A short list never hides the tenant that is throttling.
 */
export function tenantListOrder(units: readonly TenantUnitSnapshot[]): TenantUnitSnapshot[] {
  const rank = (u: TenantUnitSnapshot): number => (u.state === 'Down' ? 0 : u.state === 'Degraded' ? 1 : (u.throttled ?? 0) > 0 ? 2 : 3)
  return [...units].sort((a, b) => rank(a) - rank(b) || (b.utilisation ?? 0) - (a.utilisation ?? 0))
}

/** The throttled units, worst first (most requests turned away). */
export function throttledUnits(units: readonly TenantUnitSnapshot[], throttleAmber: number): TenantUnitSnapshot[] {
  return units.filter((u) => isThrottled(u, throttleAmber)).sort((a, b) => (b.throttled ?? 0) - (a.throttled ?? 0))
}

/** The Overview's throttled figure naming the worst tenant: "3.2% · Acme Retail", with "+N more" when others throttle too. Null when none does. */
export function throttleWho(units: readonly TenantUnitSnapshot[], throttleAmber: number): string | null {
  const t = throttledUnits(units, throttleAmber)
  if (t.length === 0) return null
  const part = worstPart(t[0])
  return `${(t[0].throttled! * 100).toFixed(1)}% · ${t[0].name}${part ? ` · ${partName(part)}` : ''}${t.length > 1 ? ` +${t.length - 1} more` : ''}`
}

/** A tenant's own throttled figure, always shown (0% included): "0% throttled". */
export const throttledText = (u: Pick<TenantUnitSnapshot, 'throttled'>): string => `${((u.throttled ?? 0) * 100).toFixed(u.throttled != null && u.throttled > 0 && u.throttled < 0.1 ? 1 : 0)}% throttled`

/**
 * Parts of a database (its shared pool and the pieces with capacity of their own): which ones are in trouble is the server's word (their state), the words for them are here.
 * `label` is what the engine calls a piece (town.yaml partLabel, for example container); without one the words say "part".
 */
export const partLabel = (n: Pick<NodeSnapshot, 'engine'>): string => n.engine?.partLabel ?? 'part'

/** A part as it is named in a sentence: the shared pool, or the piece by its own name. */
export const partName = (p: Pick<PartSnapshot, 'kind' | 'name'>): string => (p.kind === 'Shared' ? 'shared throughput' : p.name)

/** The parts of a unit that are in trouble (amber or red), the shared pool first. */
export const hotParts = (u: Pick<TenantUnitSnapshot, 'parts'>): PartSnapshot[] => (u.parts ?? []).filter((p) => p.state === 'Degraded' || p.state === 'Down')

/** The part turning away the most requests, then using the most capacity, of the parts in trouble. Null when none is. */
export function worstPart(u: Pick<TenantUnitSnapshot, 'parts'>): PartSnapshot | null {
  return [...hotParts(u)].sort((a, b) => (b.throttled ?? 0) - (a.throttled ?? 0) || (b.utilisation ?? 0) - (a.utilisation ?? 0))[0] ?? null
}

/** How many of a unit's parts are fine, for "3 other containers fine". Zero when the unit has no parts. */
export const partsFine = (u: Pick<TenantUnitSnapshot, 'parts'>): number => (u.parts ?? []).filter((p) => p.state === 'Healthy').length

/** The words under a tenant that has parts in trouble: "3 other containers fine" (the shared pool counts as one), or null when every part is in trouble or the unit has none. */
export function partsFineText(u: Pick<TenantUnitSnapshot, 'parts'>, label: string): string | null {
  const fine = partsFine(u)
  if (fine === 0 || hotParts(u).length === 0) return null
  return `${fine} other ${label}${fine === 1 ? '' : 's'} fine`
}

/** One line under a tenant for a part in trouble, and the note that the others are fine. */
export interface PartLines {
  lines: { name: string; kind: PartSnapshot['kind']; figures: string; tone: 'warn' | 'bad' }[]
  /** "3 other containers fine", or null. */
  note: string | null
}

/** What the inspector shows under a tenant whose database is split into parts: only the parts in trouble, then how many are fine. Null when the unit has none in trouble. */
export function partLines(u: Pick<TenantUnitSnapshot, 'parts'>, label: string): PartLines | null {
  const hot = hotParts(u)
  if (hot.length === 0) return null
  return {
    lines: hot.map((p) => ({ name: partName(p), kind: p.kind, figures: partFigures(p), tone: p.state === 'Down' ? 'bad' : 'warn' })),
    note: partsFineText(u, label),
  }
}

/** A part's figures, like a tenant's row: what it has, how much of it is used and how much it turns away. */
export function partFigures(p: Pick<PartSnapshot, 'limit' | 'utilisation' | 'throttled' | 'idle'>): string {
  return tenantFigures(p)
}

/** A provisioned size as a plain number in the store's own unit ("20,000"): the source sends no unit, so none is made up. */
const sizeText = (limit: number): string => Math.round(limit).toLocaleString('en-US')

/** A provisioned size as the tenant rows show it: "max 20,000". */
export const limitText = (limit: number): string => `max ${sizeText(limit)}`

/** What the units are provisioned at, for the Overview: one size ("20,000") or the range of them ("4,000 to 20,000"). Null when no unit reports one. */
export function limitRange(units: readonly Pick<TenantUnitSnapshot, 'limit'>[]): string | null {
  const limits = units.map((u) => u.limit).filter((l): l is number => l != null && l > 0)
  if (limits.length === 0) return null
  const low = Math.min(...limits), high = Math.max(...limits)
  return low === high ? sizeText(high) : `${sizeText(low)} to ${sizeText(high)}`
}

/** The figures on a tenant's row, in order: what it is provisioned at, how much of that it uses, and how much it turns away. Each is left out when unknown, apart from the use, which shows a dash (or "no activity reported" for an idle one). */
export function tenantFigures(u: Pick<TenantUnitSnapshot, 'limit' | 'utilisation' | 'throttled' | 'idle'>): string {
  // a quiet database the source sent no number for, and the town was told to read as no use: say so, so the 0% is not taken for a measurement
  const use = u.idle ? 'no activity reported' : u.utilisation == null ? '–' : `${Math.round(u.utilisation * 100)}%`
  return [u.limit == null ? null : limitText(u.limit), use, u.throttled == null ? null : throttledText(u)].filter(Boolean).join(' · ')
}

/** Most throttled tenants the yard sign names; past this it gives only the count. */
export const SIGN_NAMES = 3

export interface YardSummary {
  /** Units drawn. */
  tenants: number
  /** Of those, how many are turning requests away. */
  throttled: number
  /** Test tenants left out because the viewer hid them. */
  hiddenTest: number
  /** The text on the yard's sign. */
  text: string
  /** A second, smaller line: what is hidden or unknown. Empty when there is nothing to add. */
  note: string
}

/** What the yard's sign says: "N tenants, M throttled". Counts only the tenants drawn; what is left out or unlisted goes in the note. */
export function yardSummary(units: readonly TenantUnitSnapshot[], view: TenantView, throttleAmber: number): YardSummary {
  const shown = shownUnits(units, view)
  const throttled = shown.filter((u) => isThrottled(u, throttleAmber)).length
  const hiddenTest = units.length - shown.length
  const unknown = shown.filter((u) => u.kind === 'Unknown').length
  const notes: string[] = []
  const who = throttledUnits(shown, throttleAmber)
  if (who.length > 0 && who.length <= SIGN_NAMES) notes.push(`${who.length} throttled: ${who.map((u) => u.name).join(', ')}`)
  if (unknown > 0) notes.push(`${unknown} unknown`)
  if (hiddenTest > 0) notes.push(`${hiddenTest} test hidden`)
  return {
    tenants: shown.length,
    throttled,
    hiddenTest,
    text: `${shown.length} ${shown.length === 1 ? 'tenant' : 'tenants'}, ${throttled} throttled`,
    note: notes.join(' · '),
  }
}

/** Height of a unit as a share of the tallest it can be: how much of its capacity it uses. A database with no reading stands low. */
export function fillOf(u: Pick<TenantUnitSnapshot, 'utilisation'>): number {
  return clamp(u.utilisation ?? 0, 0, 1)
}

/** Where each unit stands in a yard: a grid that fills row by row from the back, and shrinks the cells to fit more tenants. */
export interface YardSlot {
  x: number
  z: number
  /** Edge of the unit's square footprint. */
  size: number
}

/**
 * Lays `count` units out in a yard of the given width and depth, centred on 0. The cell shrinks as tenants are added, down to a floor, so a
 * yard of ten (the most a development environment has) and one of forty both fit. Units past what fits at the smallest cell are not drawn.
 */
export function yardLayout(count: number, width: number, depth: number): YardSlot[] {
  if (count <= 0) return []
  let cell = 1.7
  let cols = 1, rows = 1
  for (; cell >= 0.7; cell -= 0.1) {
    cols = Math.max(1, Math.floor(width / cell))
    rows = Math.max(1, Math.floor(depth / cell))
    if (cols * rows >= count) break
  }
  cell = Math.max(0.7, cell)
  cols = Math.max(1, Math.floor(width / cell))
  rows = Math.max(1, Math.floor(depth / cell))
  // fill the rows evenly instead of leaving the last one nearly empty
  const used = Math.min(count, cols * rows)
  const perRow = Math.min(cols, Math.ceil(used / Math.ceil(used / cols)))
  const usedRows = Math.ceil(used / perRow)
  const slots: YardSlot[] = []
  for (let i = 0; i < used; i++) {
    const r = Math.floor(i / perRow), c = i % perRow
    const inRow = r === usedRows - 1 ? used - r * perRow : perRow
    slots.push({
      x: (c - (inRow - 1) / 2) * cell,
      z: -depth / 2 + cell / 2 + r * cell + (depth - usedRows * cell) / 2,
      size: cell * 0.78,
    })
  }
  return slots
}

/** Picks a tenant for a new car in proportion to the shares. `roll` is a number from 0 to 1. Null when there are no tenants. */
export function pickTenant(tenants: readonly Pick<TenantInfo, 'id' | 'share'>[], roll: number): string | null {
  if (tenants.length === 0) return null
  const total = tenants.reduce((s, t) => s + Math.max(0, t.share), 0)
  if (total <= 0) return tenants[Math.floor(clamp(roll, 0, 0.999999) * tenants.length)].id
  let at = clamp(roll, 0, 0.999999) * total
  for (const t of tenants) {
    at -= Math.max(0, t.share)
    if (at < 0) return t.id
  }
  return tenants[tenants.length - 1].id
}

/** Whether a car carrying this tenant is drawn. A car with no tenant (an environment without tenants) always is. */
export function carShown(tenant: string | null, kinds: ReadonlyMap<string, TenantInfo['kind']>, view: TenantView): boolean {
  if (tenant === null) return !isFollowing(view)
  if (isFollowing(view) && !isFollowed(view, tenant)) return false
  return !(view.hideTest && kinds.get(tenant) === 'Test')
}

/** Adds the tenant to the followed ones, or takes it out when it is already followed. */
export function toggleTenant(view: TenantView, id: string): TenantView {
  return { ...view, tenants: isFollowed(view, id) ? view.tenants.filter((t) => t !== id) : [...view.tenants, id] }
}

/** Drops followed tenants the environment no longer lists. Returns the same view when nothing changed. */
export function pruneTenants(view: TenantView, listed: readonly Pick<TenantInfo, 'id'>[]): TenantView {
  const keep = view.tenants.filter((id) => listed.some((t) => t.id === id))
  return keep.length === view.tenants.length ? view : { ...view, tenants: keep }
}

export interface TenantGroup {
  key: 'Customer' | 'Test' | 'Unknown'
  title: string
  tenants: TenantInfo[]
}

/** The tenants whose name or id contains every word typed, in groups: customers first, then test tenants, then ones nobody listed. Empty groups are left out. */
export function groupTenants(list: readonly TenantInfo[], query = ''): TenantGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const match = (t: TenantInfo) => words.every((w) => `${t.name} ${t.id}`.toLowerCase().includes(w))
  const groups: TenantGroup[] = [
    { key: 'Customer', title: 'Customers', tenants: [] },
    { key: 'Test', title: 'Test tenants', tenants: [] },
    { key: 'Unknown', title: 'Unknown (not on the list)', tenants: [] },
  ]
  for (const t of list) if (match(t)) groups.find((g) => g.key === t.kind)!.tenants.push(t)
  for (const g of groups) g.tenants.sort((a, b) => a.name.localeCompare(b.name))
  return groups.filter((g) => g.tenants.length > 0)
}

/** The tenants in trouble right now, by id: the worst unit of that tenant on any tenant database. Tenants that are fine are not in the map. */
export function tenantTrouble(nodes: readonly Pick<NodeSnapshot, 'tenants'>[]): Map<string, 'amber' | 'red'> {
  const out = new Map<string, 'amber' | 'red'>()
  for (const n of nodes)
    for (const u of n.tenants ?? []) {
      const level = tenantLevel(u)
      if (level !== 'amber' && level !== 'red') continue
      if (level === 'red' || !out.has(u.id)) out.set(u.id, level)
    }
  return out
}

/** What the tenant button says: "All tenants", the one followed, or how many. */
export function tenantLabel(view: TenantView, list: readonly Pick<TenantInfo, 'id' | 'name'>[]): string {
  const base = view.tenants.length === 0 ? 'All tenants' : view.tenants.length === 1 ? (list.find((t) => t.id === view.tenants[0])?.name ?? view.tenants[0]) : `${view.tenants.length} tenants`
  return view.hideTest ? `${base} · no test` : base
}
