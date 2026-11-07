// Where an event's patch of ground goes: in open sea just beyond a chosen island, on the side facing away from the middle of the town, clear of
// every island, pier and lane. Pure, so a test can check it for towns of any shape.

import type { Disc } from './rig'

export interface Placement {
  x: number
  z: number
  /** The way the patch's +z points: away from the town, out to sea. */
  yaw: number
  /** The index of the island it stands beside. */
  beside: number
}

/** Space left between the patch and anything else, for the piers, lanes and boats that run out from an island. */
export const MARGIN = 16

/**
 * `islands` are the round footprints of everything standing in the sea (the hub among them), `centre` the middle of the town, `radius` the
 * patch's own reach, and `pick` a number from 0 up to (not including) 1 that chooses the island (and breaks the tie when it lies in the middle).
 */
export function placeBeside(islands: readonly Disc[], centre: { x: number; z: number }, radius: number, pick: number): Placement {
  if (islands.length === 0) return { x: centre.x, z: centre.z + radius + MARGIN, yaw: 0, beside: -1 }
  // the outermost islands first: an island in the middle has others all round it, so there is no open sea beside it
  const order = islands
    .map((d, i) => ({ i, far: Math.hypot(d.x - centre.x, d.z - centre.z) + d.r }))
    .sort((a, b) => b.far - a.far)
  const pool = order.slice(0, Math.max(1, Math.ceil(order.length / 2)))
  const chosen = pool[Math.min(pool.length - 1, Math.floor(pick * pool.length))].i
  const isl = islands[chosen]
  let dx = isl.x - centre.x
  let dz = isl.z - centre.z
  let len = Math.hypot(dx, dz)
  if (len < 1e-3) {
    const a = pick * Math.PI * 2
    dx = Math.sin(a)
    dz = Math.cos(a)
    len = 1
  }
  dx /= len
  dz /= len
  let dist = isl.r + radius + MARGIN
  for (let guard = 0; guard < 200; guard++) {
    const x = isl.x + dx * dist
    const z = isl.z + dz * dist
    if (islands.every((o) => Math.hypot(o.x - x, o.z - z) >= o.r + radius + MARGIN)) return { x, z, yaw: Math.atan2(dx, dz), beside: chosen }
    dist += 4
  }
  return { x: isl.x + dx * dist, z: isl.z + dz * dist, yaw: Math.atan2(dx, dz), beside: chosen }
}
