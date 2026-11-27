// What a car's sign says. A system's short name is its group code and its service code ("ams.as"): the same two parts every
// system id and pillar file already has, so no new setting. A car from outside the town says "outside".

import type { NodeSnapshot } from '../types'
import type { Building } from '../buildings/building'
import type { CarView } from './cars'

/** The short name of a system: group code, a dot and service code. A hub building (id "hub.x") keeps its own id. */
export function systemCode(node: Pick<NodeSnapshot, 'id' | 'service' | 'serviceCode'> | null | undefined): string {
  if (!node) return '?'
  const dot = node.id.indexOf('.')
  if (dot < 0) return node.serviceCode ?? node.id
  const group = node.id.slice(0, dot)
  const rest = node.id.slice(dot + 1)
  if (group === 'hub') return node.id
  return `${group}.${node.serviceCode || node.service || rest}`
}

export const OUTSIDE = 'outside'

/** The two ends of a car's request as short names. */
export function carEnds(car: Pick<CarView, 'from' | 'to'>): { from: string; to: string } {
  return { from: car.from ? systemCode(car.from.node) : OUTSIDE, to: systemCode(car.to.node) }
}

/** The text of a sign over a car: "ams.as → cl.mgs". */
export function carSignText(car: Pick<CarView, 'from' | 'to'>): string {
  const e = carEnds(car)
  return `${e.from} → ${e.to}`
}

/** A building's name as the card says it. */
export function buildingName(b: Building | null): string {
  return b?.node?.name ?? (b ? b.id : 'Outside the town')
}
