import * as THREE from 'three'
import { LANE_SLOTS, LANE_Z, QUEUE_GAP } from './plan'
import type { Route } from './cars'

/** A building as the service lane needs to know it: where it stands, the road in front of it, and which side of the spine it is on. */
export interface BayTarget {
  x: number
  roadZ: number
  col: 0 | 1
}

/**
 * Where a car turns off the road for a destination, and the service lane it then waits in: first slot at the door, the others behind it
 * toward the spine. `w` turns island-local coordinates into world ones. Returns null when the caller stands past the lane's far end
 * (startX is where a car on the same road would set off from), because it cannot get there.
 */
export function bayTo(dest: BayTarget, w: (x: number, z: number) => THREE.Vector3, head: THREE.Vector3[], startX: number | null): Pick<Route, 'path' | 'bay'> | null {
  const out = dest.col === 0 ? -1 : 1
  const slot = (k: number) => w(dest.x - out * QUEUE_GAP * k, dest.roadZ - LANE_Z)
  // five cars wait where the lane is long enough, three beside the spine
  const n = Math.max(3, Math.min(LANE_SLOTS, Math.floor((Math.abs(dest.x) - 5) / QUEUE_GAP) + 1))
  const tailX = dest.x - out * ((n - 1) * QUEUE_GAP)
  let mergeX = tailX - out * 3.6
  if (Math.abs(mergeX) < 2.8) mergeX = out * 2.8
  if (startX !== null) {
    if ((tailX - startX) * out < 1.5) return null // the caller stands past the lane's far end: it cannot get there
    if ((mergeX - startX) * out < 0.5) mergeX = startX + out * 0.5
  }
  return { path: [...head, w(mergeX, dest.roadZ)], bay: { drive: Array.from({ length: n }, (_, i) => slot(n - 1 - i)), slots: n, marker: slot(1) } }
}
