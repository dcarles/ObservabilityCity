// Which town and which environment of it the page looks at: the ?town= and ?env= of its address. Without them, the server's defaults.

export interface Scope {
  town: string | null
  env: string | null
}

export const requestedEnv = (search = window.location.search): string | null => new URLSearchParams(search).get('env') || null
export const requestedTown = (search = window.location.search): string | null => new URLSearchParams(search).get('town') || null

export function requestedScope(search = window.location.search): Scope {
  return { town: requestedTown(search), env: requestedEnv(search) }
}

/** The query parameters that aim a request at the scope (no leading ? or &). Empty for the defaults. */
export function scopeParams(scope: Scope): string {
  const q = new URLSearchParams()
  if (scope.town) q.set('town', scope.town)
  if (scope.env) q.set('env', scope.env)
  return q.toString()
}

/** A town the server runs, as /api/towns lists it. */
export interface TownChoice {
  id: string
  name: string
  isDefault: boolean
}

/**
 * The address for a different town: its ?town= set and everything that belongs to the old town taken out (its environment, its islands, its
 * tenants), because those mean nothing in another town. Choosing the default town leaves no ?town= behind. Other settings stay.
 */
export function addressForTown(search: string, town: TownChoice): string {
  const q = new URLSearchParams(search)
  for (const key of ['env', 'islands']) q.delete(key)
  if (town.isDefault) q.delete('town')
  else q.set('town', town.id)
  const text = q.toString().replace(/%2C/g, ',')
  return text ? `?${text}` : ''
}

/** Reads /api/towns. A server that does not answer (or an old one without the endpoint) gives no list, and the page has no town switcher. */
export async function fetchTowns(): Promise<TownChoice[]> {
  try {
    const r = await fetch('/api/towns')
    if (!r.ok) return []
    const list = (await r.json()) as unknown
    return Array.isArray(list) ? list.filter((t): t is TownChoice => typeof t?.id === 'string' && typeof t?.name === 'string').map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault === true })) : []
  } catch { return [] }
}
