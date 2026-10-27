import * as THREE from 'three'
import { box, flat } from '../buildings/mk'
import { GROUND } from '../scene/island'
import type { AirportSite } from './types'

/** A flat plate from an outline in the x/z plane (x forward, z across), `thick` deep, centred on y = 0. For wings and tail planes. */
export function plate(outline: [number, number][], thick: number, material: THREE.Material): THREE.Mesh {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)))
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false })
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(0, -thick / 2, 0)
  const m = new THREE.Mesh(geometry, material)
  m.castShadow = true
  return m
}

/** A flat fin from an outline in the x/y plane (x forward, y up), `thick` across, centred on z = 0. */
export function fin(outline: [number, number][], thick: number, material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y))), { depth: thick, bevelEnabled: false })
  geometry.translate(0, 0, -thick / 2)
  const m = new THREE.Mesh(geometry, material)
  m.castShadow = true
  return m
}

/** A fuselage turned from a profile of [distance along the axis, radius], nose at the largest distance; the axis is +x. */
export function fuselage(profile: [number, number][], material: THREE.Material, segments = 14): THREE.Mesh {
  const geometry = new THREE.LatheGeometry(profile.map(([along, r]) => new THREE.Vector2(r, along)), segments)
  geometry.rotateZ(-Math.PI / 2)
  const m = new THREE.Mesh(geometry, material)
  m.castShadow = true
  return m
}

/** A tube along x: an engine, a pod. */
export function tube(r: number, length: number, material: THREE.Material, at: [number, number, number], segments = 10): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length, segments), material)
  m.rotation.z = Math.PI / 2
  m.position.set(...at)
  m.castShadow = true
  return m
}

/** The runway with its edge lines, centre dashes and end numbers, on the island's ground. Shared by the themes that land planes. */
export function runway(decor: THREE.Group, site: AirportSite, tarmac: string, paint: string): void {
  const dark = flat(tarmac, { roughness: 0.95 }), white = flat(paint, { roughness: 0.9 })
  const { runwayZ: z, runwayHalf: half } = site
  decor.add(box(2 * half + 8, 0.12, 5.4, dark, { y: GROUND - 0.02, z }))
  for (let i = -half + 2; i <= half - 2; i += 5.5) decor.add(box(2.6, 0.02, 0.28, white, { x: i, y: GROUND + 0.11, z }))
  for (const side of [-1, 1]) {
    decor.add(box(2 * half + 6, 0.02, 0.14, white, { y: GROUND + 0.11, z: z + side * 2.4 }))
    for (let k = -2; k <= 2; k++) decor.add(box(0.5, 0.02, 3.2, white, { x: side * (half + 1.6), y: GROUND + 0.11, z: z + k * 0.9 }))
  }
}
