import * as THREE from 'three'
import { box, flat, group } from '../../buildings/mk'
import { kitParts } from '../../assets/kit'
import type { BoatLook, VehicleKit } from '../types'

const CRATE_COLORS = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a', '#8e6bd9']

/** One cargo boat: a pointed hull, a wheelhouse and a deck load of crates. */
function makeBoat(seed: number): BoatLook {
  const L = 5.4, W = 1.9
  const prof = new THREE.Shape()
  prof.moveTo(-W / 2, L / 2)
  prof.lineTo(-W / 2, -L / 2 + 0.2)
  prof.lineTo(0, -L / 2 - 1.1)
  prof.lineTo(W / 2, -L / 2 + 0.2)
  prof.lineTo(W / 2, L / 2)
  prof.closePath()
  const hullGeo = new THREE.ExtrudeGeometry(prof, { depth: 0.75, bevelEnabled: false })
  hullGeo.rotateX(-Math.PI / 2)
  hullGeo.translate(0, -0.3, 0)
  const hull = new THREE.Mesh(hullGeo, flat('#2f5d8a'))
  hull.castShadow = true
  hull.receiveShadow = true
  const stripe = box(W + 0.04, 0.12, L + 1.3, flat('#f4efe2'), { y: 0.3 })
  stripe.scale.set(1, 1, 1)
  const deck = box(W - 0.2, 0.06, L - 0.6, flat('#b58a58'), { y: 0.43, z: 0.1 })
  const house = group(
    box(1.2, 0.9, 1.2, flat('#f1ece0'), { y: 0.45, z: -L / 2 + 0.9 }),
    box(1.3, 0.12, 1.3, flat('#c0483f'), { y: 1.35, z: -L / 2 + 0.9 }),
  )
  const cargo = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    cargo.add(box(0.75, 0.7, 0.75, flat(CRATE_COLORS[(seed + i) % CRATE_COLORS.length]), { x: i % 2 ? 0.42 : -0.42, y: 0.46, z: 1.2 - Math.floor(i / 2) * 0.9 }))
  }
  const object = new THREE.Group()
  object.add(hull, stripe, deck, house, cargo)
  object.scale.setScalar(0.7)
  return { object, cargo }
}

export const harbourVehicles: VehicleKit = {
  cars: () => [kitParts('car_sedan'), kitParts('car_taxi')],
  boat: makeBoat,
  boatLift: 0,
  boatBob: 0.05,
}
