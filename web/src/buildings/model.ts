import type * as THREE from 'three'
import type { WindowUniforms } from './windowMaterial'

/** One floor module: a stack slice with its own window uniforms, so it can go dark on its own. */
export interface FloorModule {
  object: THREE.Object3D
  uniforms: WindowUniforms
}

/**
 * Everything a theme supplies for one kind of building. The renderer stacks floors, sets lights and
 * beacons, and never knows what the building looks like. Local space: y up, the front (door) faces +z.
 */
export interface BuildingModel {
  /** Static part at ground level (podium, props). */
  base: THREE.Object3D
  /** Where the first floor starts. */
  baseHeight: number
  floorHeight: number
  makeFloor(index: number): FloorModule
  /** Placed on top of the stack. */
  roof: THREE.Object3D
  /** Beacon bulb position relative to the roof origin. */
  beaconAt: THREE.Vector3
  /** Where walkers enter and leave, at ground level in local space. */
  door: THREE.Vector3
  /** Outward direction of the door in local space (unit, on the ground plane). */
  doorDir: THREE.Vector3
  /** Information plaque position and width in local space (faces +z). */
  plaque: { position: THREE.Vector3; width: number; rotY?: number }
  /** Rough footprint radius, used for hit testing and labels. */
  radius: number
  /** Per-frame animation (clock hands, cranes, smoke). */
  animate?(time: number, dt: number): void
  /** Optional hook when the building is closed for repairs or running. */
  setRunning?(running: boolean): void
}
