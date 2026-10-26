import * as THREE from 'three'
import { box, flat, group } from '../../buildings/mk'
import type { BoatLook, VehicleKit, VehicleParts } from '../types'
import { coloured, column, paintedMaterial, slab } from '../common'

const wheel = (x: number, z: number) => ({ geometry: column(0.26, 0.26, 0.2, 10), color: '#23272d', at: [x, 0.26, z] as [number, number, number], rot: [0, 0, Math.PI / 2] as [number, number, number] })

/** A delivery van: a boxy load behind a cab. Front along +z. */
function van(cab: string, load: string): VehicleParts {
  const geometry = coloured([
    { geometry: slab(0.95, 0.2, 2.1), color: '#2f343b', at: [0, 0.2, 0] },
    { geometry: slab(1.0, 0.85, 1.25), color: load, at: [0, 0.4, -0.4] },
    { geometry: slab(1.0, 0.6, 0.7), color: cab, at: [0, 0.4, 0.7] },
    { geometry: slab(0.9, 0.22, 0.5), color: '#9cc3d9', at: [0, 0.88, 0.8] },
    wheel(0.5, 0.7), wheel(-0.5, 0.7), wheel(0.5, -0.65), wheel(-0.5, -0.65),
  ])
  return { geometry, material: paintedMaterial() }
}

const CONTAINERS = ['#d9573f', '#3f7fc9', '#e3a72c', '#4f9f6a', '#7d6bb9']

/** A flat-bottomed barge with a deckhouse at the stern and containers on deck. */
function barge(seed: number): BoatLook {
  const L = 5.6, W = 2.2
  const hullShape = new THREE.Shape()
  hullShape.moveTo(-W / 2, -L / 2)
  hullShape.lineTo(-W / 2, L / 2 - 0.5)
  hullShape.lineTo(-W / 2 + 0.4, L / 2 + 0.8)
  hullShape.lineTo(W / 2 - 0.4, L / 2 + 0.8)
  hullShape.lineTo(W / 2, L / 2 - 0.5)
  hullShape.lineTo(W / 2, -L / 2)
  hullShape.closePath()
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 0.7, bevelEnabled: false })
  hullGeo.rotateX(-Math.PI / 2)
  hullGeo.translate(0, -0.3, 0)
  const hull = new THREE.Mesh(hullGeo, flat('#3b4650', { metalness: 0.3 }))
  hull.castShadow = true
  hull.receiveShadow = true
  const object = group(
    hull,
    box(W + 0.04, 0.1, L + 1.3, flat('#f2c230'), { y: 0.3, z: 0.15 }),
    box(1.3, 1.0, 1.1, flat('#e8e4d8'), { y: 0.4, z: -L / 2 + 0.7 }),
    box(1.4, 0.12, 1.2, flat('#d9573f'), { y: 1.4, z: -L / 2 + 0.7 }),
    box(0.16, 0.7, 0.16, flat('#23272d'), { x: 0.4, y: 1.5, z: -L / 2 + 0.7 }),
  )
  const cargo = new THREE.Group()
  for (let i = 0; i < 6; i++) cargo.add(box(0.85, 0.75, 1.2, flat(CONTAINERS[(seed + i) % CONTAINERS.length], { metalness: 0.2 }), { x: i % 2 ? 0.46 : -0.46, y: 0.4, z: 1.6 - Math.floor(i / 2) * 1.35 }))
  object.add(cargo)
  object.scale.setScalar(0.7)
  return { object, cargo }
}

export const factoryVehicles: VehicleKit = {
  cars: () => [van('#3f7fc9', '#e8e4d8'), van('#f2c230', '#d9573f')],
  boat: barge,
  boatLift: 0,
  boatBob: 0.03,
}
