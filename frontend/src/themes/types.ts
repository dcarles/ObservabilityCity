import type * as THREE from 'three'
import type { NodeKind } from '../types'
import type { BuildingModel } from '../buildings/model'
import type { Lighting, LightingPreset } from '../lighting'
import type { harbourPalette } from './harbour-town/palette'

type Widen<T> = T extends string ? string : T extends readonly (infer U)[] ? Widen<U>[] : { [K in keyof T]: Widen<T[K]> }

/** Every colour a theme sets: the sky and ground, the island's surfaces, the trees, the beacons and the buildings' own colours. */
export type Palette = Widen<typeof harbourPalette>

/** The geometry and material a car is drawn with (instanced, so one of each). The front points along +z; the model is scaled to a car's length. */
export interface VehicleParts {
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

export interface BoatLook {
  object: THREE.Group
  /** Everything the boat carries; the first `n` children are shown for a load of `n`. */
  cargo: THREE.Group
}

/** What carries the traffic: cars for requests (internal first, then outside callers) and boats for messages. */
export interface VehicleKit {
  cars(): [VehicleParts, VehicleParts]
  boat(seed: number): BoatLook
  /** How high a boat rides above the water (a shuttle hovers), and how much it bobs. */
  boatLift: number
  boatBob: number
}

/** How a bridge looks. The road across it is the same in every theme; this dresses the deck, rails, lamps, gates and piers. */
export interface BridgeStyle {
  /** Adds the look to a deck group centred on the bridge, running along z, `len` long and `width` wide. */
  dress(deck: THREE.Group, len: number, width: number, ends: boolean): void
}

export interface ThemeKit {
  id: string
  palette: Palette
  lighting: Record<Lighting, LightingPreset>
  buildModel(kind: NodeKind, accent: string, opts: { tenanted?: boolean; name?: string }): BuildingModel
  vehicles: VehicleKit
  bridge: BridgeStyle
  /** The jetty a sea lane ends on, running along +z. */
  pier(length: number): THREE.Group
  /** Colour multiplied into the kit's road tiles and lamps, so the roads belong to the theme. */
  roadTint: string | null
  /** Draw stars in the sky. */
  stars: boolean
  /** A prop standing in for a kit prop, or null to use the kit's own. */
  prop(name: string): THREE.Object3D | null
}
