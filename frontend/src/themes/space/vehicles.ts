import * as THREE from 'three'
import { box, cone, cyl, flat, group, sphere } from '../../buildings/mk'
import type { BoatLook, VehicleKit, VehicleParts } from '../types'
import { coloured, glow, paintedMaterial, slab } from '../common'

/** A hover pod: a rounded canopy on a slim hull, riding a little above the road on a strip of light. */
function pod(hull: string, canopy: string, trim: string): VehicleParts {
  const geometry = coloured([
    { geometry: slab(0.95, 0.34, 2.1), color: hull, at: [0, 0.22, 0] },
    { geometry: slab(0.7, 0.2, 0.8), color: hull, at: [0, 0.22, 0.95] },
    { geometry: new THREE.SphereGeometry(0.46, 10, 8), color: canopy, at: [0, 0.74, -0.05], scale: [1, 0.7, 1.45] },
    { geometry: slab(1.35, 0.07, 0.5), color: trim, at: [0, 0.5, -0.85] },
    { geometry: slab(0.12, 0.3, 0.5), color: trim, at: [0, 0.55, -0.9] },
    { geometry: slab(0.75, 0.05, 1.8), color: '#6fe7ff', at: [0, 0.14, 0] },
  ])
  return { geometry, material: paintedMaterial() }
}

const CRATES = ['#ff7a59', '#59b0ff', '#ffd45e', '#59e3a0', '#b08cff']

/** A cargo shuttle: a blunt hull with a nose cone, twin engines and a cradle of crates. It hovers above the lane. */
function shuttle(seed: number): BoatLook {
  const hull = flat('#e6eaf8', { metalness: 0.3, roughness: 0.4 })
  const trim = flat('#59618f', { metalness: 0.4 })
  const object = group(
    box(2.0, 0.7, 4.6, hull, { y: 0.1, z: -0.2 }),
    cone(1.0, 1.7, hull, { y: 0.45, z: 2.1, rx: Math.PI / 2 }, 12),
    box(2.3, 0.1, 0.8, trim, { y: 0.35, z: -1.9 }),
    box(1.5, 0.2, 3.0, trim, { y: 0.8, z: -0.4 }),
    cyl(0.32, 0.4, 0.8, trim, { x: -0.7, y: 0.1, z: -2.9, rx: Math.PI / 2 }, 10),
    cyl(0.32, 0.4, 0.8, trim, { x: 0.7, y: 0.1, z: -2.9, rx: Math.PI / 2 }, 10),
    sphere(0.28, glow('#6fe7ff'), { x: -0.7, y: 0.5, z: -3.35 }, 8),
    sphere(0.28, glow('#6fe7ff'), { x: 0.7, y: 0.5, z: -3.35 }, 8),
    sphere(0.45, flat('#bfe9ff', { roughness: 0.15, metalness: 0.4 }), { y: 0.95, z: 1.2 }, 10),
  )
  const cargo = new THREE.Group()
  for (let i = 0; i < 6; i++) cargo.add(box(0.7, 0.62, 0.7, flat(CRATES[(seed + i) % CRATES.length], { metalness: 0.2 }), { x: i % 2 ? 0.4 : -0.4, y: 0.9, z: 0.7 - Math.floor(i / 2) * 0.85 }))
  object.add(cargo)
  object.scale.setScalar(0.7)
  return { object, cargo }
}

export const spaceVehicles: VehicleKit = {
  cars: () => [pod('#e6eaf8', '#7be3ff', '#59618f'), pod('#ffb347', '#fff1c9', '#8a5a1f')],
  boat: shuttle,
  boatLift: 0.9,
  boatBob: 0.09,
}

