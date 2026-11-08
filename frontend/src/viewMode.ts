// Which way to look at the data: the 3D town or the plain dashboard. The choice is in the address (?view=dashboard), else what this browser last chose,
// else the town. The tenant choice is remembered here too, so both views start from the same one.

import type { Store } from './lighting'
import { ALL_TENANTS, type TenantView } from './tenants'

export type ViewMode = 'town' | 'dashboard'

export const VIEW_KEY = 'oc.view'
export const TENANT_VIEW_KEY = 'oc.tenantView'

export const isViewMode = (v: unknown): v is ViewMode => v === 'town' || v === 'dashboard'

/** The view the page opens with: the address, else this browser's last choice, else the town. A wall address (?wall=1) with no view in it is the town; ?wall=1&view=dashboard is the wall dashboard. */
export function startView(search: string, store: Store | null): ViewMode {
  const q = new URLSearchParams(search)
  const asked = q.get('view')
  if (isViewMode(asked)) return asked
  if (q.has('wall')) return 'town'
  try {
    const saved = store?.getItem(VIEW_KEY)
    if (isViewMode(saved)) return saved
  } catch { /* storage blocked */ }
  return 'town'
}

export function saveView(store: Store | null, v: ViewMode): void {
  try { store?.setItem(VIEW_KEY, v) } catch { /* storage blocked */ }
}

/** The address of the same page in the other view: everything else in the address stays (environment, pillars, theme). Remembers the choice. */
export function viewSwitchAddress(at: { pathname: string; search: string; hash: string }, to: ViewMode, store: Store | null): string {
  saveView(store, to)
  const q = new URLSearchParams(at.search)
  q.set('view', to)
  return `${at.pathname}?${q.toString().replace(/%2C/g, ',')}${at.hash}`
}

/** The tenant choice this browser last made (nothing chosen: all tenants). */
export function loadTenantView(store: Store | null): TenantView {
  try {
    const raw = store?.getItem(TENANT_VIEW_KEY)
    if (!raw) return ALL_TENANTS
    const v = JSON.parse(raw) as Partial<TenantView>
    return { hideTest: v.hideTest === true, tenants: Array.isArray(v.tenants) ? v.tenants.filter((t): t is string => typeof t === 'string') : [] }
  } catch {
    return ALL_TENANTS
  }
}

export function saveTenantView(store: Store | null, v: TenantView): void {
  try { store?.setItem(TENANT_VIEW_KEY, JSON.stringify(v)) } catch { /* storage blocked */ }
}
