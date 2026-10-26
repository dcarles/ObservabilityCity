// How tenants look, as pure functions: units from a snapshot in, colours, heights, counts and sign text out.
// Nothing here touches three.js, so it is unit tested against the same golden fixture as the backend.

import type { TenantInfo, TenantUnitSnapshot } from './types'
import { clamp } from './visuals'

/** The colour of a tenant's unit. Grey is a database that was not found or has no fresh data. */
export type TenantLevel = 'green' | 'amber' | 'red' | 'grey'

/** What the viewer chose to see of the tenants: hide the test ones, and/or follow one tenant. */
export interface TenantView {
  hideTest: boolean
  /** The tenant to follow, or null for all of them. Everything else is dimmed, and only its cars are drawn. */
  tenant: string | null
}

export const ALL_TENANTS: TenantView = { hideTest: false, tenant: null }

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
  if (tenant === null) return view.tenant === null
  if (view.tenant !== null && tenant !== view.tenant) return false
  return !(view.hideTest && kinds.get(tenant) === 'Test')
}
