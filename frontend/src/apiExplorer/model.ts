// The rules of the API explorer as plain functions: the tree of groups, the search, what a marker says, and the XML shown with colour. No DOM here, so tests call them directly.

import type { ApiOperationInfo, ApiSummary } from '../types'

export type ApiGroupKind = 'group' | 'vendor' | 'unlinked'

export interface ApiGroup {
  /** The island's id, or `vendors` / `unlinked` for the two groups the town has no island for. */
  id: string
  name: string
  kind: ApiGroupKind
  apis: ApiSummary[]
}

export const VENDORS_GROUP = 'vendors'
export const UNLINKED_GROUP = 'unlinked'

const byName = (a: { displayName: string }, b: { displayName: string }): number => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })

/**
 * The tree on the left: one group for each island whose systems the APIs lead to (named by the town, never by a fixed word), then the APIs whose backend is a third party, then the ones
 * that matched nothing. A group with no API is not listed.
 */
export function buildTree(apis: readonly ApiSummary[], groupName: (id: string) => string, vendorsLabel = 'Third parties', unlinkedLabel = 'Not linked to a service'): ApiGroup[] {
  const groups = new Map<string, ApiGroup>()
  const add = (id: string, name: string, kind: ApiGroupKind, api: ApiSummary): void => {
    const g = groups.get(id) ?? { id, name, kind, apis: [] }
    g.apis.push(api)
    groups.set(id, g)
  }
  for (const api of apis) {
    if (api.systemId && api.groupId) add(api.groupId, groupName(api.groupId), 'group', api)
    else if (api.thirdPartyId) add(VENDORS_GROUP, vendorsLabel, 'vendor', api)
    else add(UNLINKED_GROUP, unlinkedLabel, 'unlinked', api)
  }
  const order = (g: ApiGroup): number => (g.kind === 'group' ? 0 : g.kind === 'vendor' ? 1 : 2)
  return [...groups.values()].map((g) => ({ ...g, apis: [...g.apis].sort(byName) })).sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export interface ApiFilter {
  text: string
  /** Only APIs the gateways do not agree on. */
  differing: boolean
  /** Only APIs that matched no system. */
  unlinked: boolean
}

export const NO_FILTER: ApiFilter = { text: '', differing: false, unlinked: false }

/**
 * The tree with the search and the chips applied. Every word of the search must be found in the API's name, path, backend address, its system's name or its group's name; a group whose own name
 * matches keeps all its APIs. A group that ends up empty is left out.
 */
export function filterTree(tree: readonly ApiGroup[], filter: ApiFilter, systemName: (id: string) => string): ApiGroup[] {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean)
  const out: ApiGroup[] = []
  for (const g of tree) {
    const apis = g.apis.filter((a) => {
      if (filter.differing && !differs(a)) return false
      if (filter.unlinked && (a.systemId || a.thirdPartyId)) return false
      if (words.length === 0) return true
      const hay = [a.displayName, a.name, a.path ?? '', a.backendHost ?? '', a.systemId ? systemName(a.systemId) : '', g.name].join(' ').toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    if (apis.length > 0) out.push({ ...g, apis })
  }
  return out
}

/** The APIs that lead to one system: what its drawer's button opens the explorer on. */
export function apisOfSystem(apis: readonly ApiSummary[], systemId: string): ApiSummary[] {
  return apis.filter((a) => a.systemId === systemId).sort(byName)
}

/** Whether the gateways do not agree on an API: one of them lacks it. (What differs inside it is read with the detail.) */
export function differs(a: ApiSummary): boolean {
  return a.missingFrom.length > 0
}

/** The words of the marker on an API in the tree: where it is missing, or null when all gateways have it. */
export function marker(a: ApiSummary): string | null {
  return a.missingFrom.length === 0 ? null : `Not on ${a.missingFrom.join(' or ')}`
}

/** Which gateways serve an API, for the small tag next to it: nothing when there is only one gateway to name. */
export function servedBy(a: ApiSummary, gatewayCount: number): string | null {
  return gatewayCount < 2 || a.gateways.length === 0 ? null : a.gateways.length === gatewayCount ? 'all' : a.gateways.join(' + ')
}

/** The class that colours a method chip. */
export function methodClass(method: string): string {
  const m = method.toUpperCase()
  return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(m) ? m.toLowerCase() : 'other'
}

/** The status family of a response code, for its colour: ok (2xx), redirect (3xx), client (4xx) or server (5xx). */
export function statusClass(code: number): 'ok' | 'redirect' | 'client' | 'server' | 'other' {
  return code >= 200 && code < 300 ? 'ok' : code >= 300 && code < 400 ? 'redirect' : code >= 400 && code < 500 ? 'client' : code >= 500 && code < 600 ? 'server' : 'other'
}

/** The operations filtered by the search words (method, name or URL template) in the middle column. */
export function filterOperations(operations: readonly ApiOperationInfo[], text: string): ApiOperationInfo[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return operations.filter((o) => words.every((w) => `${o.method} ${o.name} ${o.urlTemplate}`.toLowerCase().includes(w)))
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Policy XML as HTML: everything is escaped first, then tags, attribute names and values get a class so the page can colour them. The text is never trusted as markup.
 */
export function highlightXml(xml: string): string {
  return esc(xml)
    .replace(/(&lt;\/?)([\w:.-]+)/g, '$1<span class="x-tag">$2</span>')
    .replace(/([\w:.-]+)=(&quot;.*?&quot;)/g, '<span class="x-attr">$1</span>=<span class="x-val">$2</span>')
}

/** Policy fragment ids a policy includes, for a link to each. */
export function fragmentIds(xml: string | null | undefined): string[] {
  if (!xml) return []
  return [...xml.matchAll(/<include-fragment\b[^>]*?\bfragment-id\s*=\s*"([^"{]+)"/gi)].map((m) => m[1]!).filter((id, i, all) => all.indexOf(id) === i)
}
