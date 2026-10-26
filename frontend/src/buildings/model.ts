import type * as THREE from 'three'
import type { TenantUnitSnapshot } from '../types'
import type { TenantLevel, TenantView } from '../tenants'
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
  /** The words on the building's own sign, for a model that has one worth testing (a broker's port). */
  signText?: string
  /** Floors are fixed instead of following the instance count (a data store is not measured in instances). */
  fixedFloors?: number
  /** How busy the building is (0 to 1, from CPU), for things like chimney smoke. */
  setActivity?(level: number): void
  /** Per-frame animation (clock hands, cranes, smoke). */
  animate?(time: number, dt: number): void
  /** Optional hook when the building is closed for repairs or running. */
  setRunning?(running: boolean): void
  /**
   * Only the storage yard of a data store with a database for each tenant: one unit per tenant, whose colour follows the unit's state and whose
   * height follows its use of capacity. `throttleAmber` is the store's threshold for counting a tenant as throttled.
   */
  setTenants?(units: readonly TenantUnitSnapshot[], throttleAmber: number, view: TenantView): void
  /** What the yard shows right now, as plain values. For tests. */
  tenantStatus?(): TenantYardStatus
}

/** One tenant unit as drawn, for tests. */
export interface TenantUnitStatus {
  id: string
  level: TenantLevel
  /** Test tenants are drawn paler and striped. */
  test: boolean
  /** A tenant the environment does not list. */
  unknown: boolean
  /** False for a test tenant the viewer hid: it is not drawn at all. */
  shown: boolean
  /** True for every unit but the followed tenant's while one is followed. */
  dimmed: boolean
  throttled: boolean
  /** Height as a share of the tallest a unit gets (0 to 1). */
  fill: number
}

export interface TenantYardStatus {
  units: TenantUnitStatus[]
  /** The two lines of the yard's sign. */
  sign: { text: string; note: string }
}
