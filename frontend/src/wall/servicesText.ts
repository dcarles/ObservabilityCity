// How an island is described in the wall's captions: by its services, the groups of buildings drawn together, not by every building. Pure.

import type { NodeSnapshot } from '../types'

/**
 * The number of services: buildings with the same service name are one service (its API, worker and database count once), and a building with no service
 * name is a service of its own. A scheduler (a function) is not a service. Unused when the island has nothing to count.
 */
export function serviceCount(nodes: readonly Pick<NodeSnapshot, 'id' | 'kind' | 'service'>[]): number {
  return new Set(nodes.filter((n) => n.kind !== 'Function').map((n) => n.service ?? n.id)).size
}

/** "4 services plus scheduler", "1 service", "scheduler" for an island with only a scheduler. */
export function servicesText(nodes: readonly Pick<NodeSnapshot, 'id' | 'kind' | 'service'>[]): string {
  const services = serviceCount(nodes)
  const scheduler = nodes.some((n) => n.kind === 'Function')
  const words = `${services} service${services === 1 ? '' : 's'}`
  if (services === 0) return scheduler ? 'scheduler only' : 'nothing yet'
  return scheduler ? `${words} plus scheduler` : words
}
