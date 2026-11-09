import * as THREE from 'three'
import { box, flat, group, sphere } from '../../buildings/mk'
import { kitParts } from '../../assets/kit'
import type { BoatLook, VehicleKit } from '../types'
import { boatPaint } from '../boatColours'

const CRATE_COLORS = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a', '#8e6bd9']

/** One cargo boat: a pointed hull in the lane's colour, a white deckhouse with a funnel, rails, a bow lantern and a deck load of crates. */
function makeBoat(seed: number, internal = false): BoatLook {
  const paint = boatPaint(internal)
  const L = 5.4, W = 2.0
  const prof = new THREE.Shape()
  prof.moveTo(-W / 2, L / 2)
  prof.lineTo(-W / 2, -L / 2 + 0.2)
  prof.lineTo(0, -L / 2 - 1.3)
  prof.lineTo(W / 2, -L / 2 + 0.2)
  prof.lineTo(W / 2, L / 2)
  prof.closePath()
  const hullGeo = new THREE.ExtrudeGeometry(prof, { depth: 0.95, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 })
  hullGeo.rotateX(-Math.PI / 2)
  hullGeo.translate(0, -0.3, 0)
  const hull = new THREE.Mesh(hullGeo, flat(paint.body))
  hull.castShadow = true
  hull.receiveShadow = true
  const stripe = box(W + 0.14, 0.14, L + 1.5, flat('#f4efe2'), { y: 0.5 })
  // the deck plank clears the hull top (0.71) by a wide margin: sitting just under it made the two faces fight (flicker) on a boat with no crates
  const deck = box(W - 0.2, 0.1, L - 0.4, flat('#b58a58'), { y: 0.75, z: 0.1 })
  const white = flat('#f6f2e8')
  const trim = flat(paint.trim)
  const sx = W / 2 - 0.08
  const rails = [-sx, sx].map((x) => box(0.07, 0.34, L + 0.2, trim, { x, y: 0.82, z: 0.1 }))
  const house = group(
    box(1.4, 1.0, 1.3, white, { y: 0.72, z: -L / 2 + 0.9 }),
    box(1.5, 0.14, 1.4, trim, { y: 1.28, z: -L / 2 + 0.9 }),
    box(1.42, 0.3, 0.06, flat('#2c3a4a'), { y: 0.95, z: -L / 2 + 1.56 }),
    box(0.4, 0.7, 0.4, trim, { x: 0.3, y: 1.62, z: -L / 2 + 0.6 }),
    box(0.44, 0.12, 0.44, flat('#23272d'), { x: 0.3, y: 2.0, z: -L / 2 + 0.6 }),
  )
  const lantern = sphere(0.14, flat('#ffe9a0', { emissive: '#ffd45e', emissiveIntensity: 0.7 }), { y: 0.86, z: L / 2 + 0.75 }, 8)
  const cargo = new THREE.Group()
  for (let i = 0; i < 6; i++) {
    cargo.add(box(0.85, 0.8, 0.85, flat(CRATE_COLORS[(seed + i) % CRATE_COLORS.length]), { x: i % 2 ? 0.48 : -0.48, y: 0.74, z: 1.25 - Math.floor(i / 2) * 1.0 }))
  }
  const object = new THREE.Group()
  object.add(hull, stripe, deck, ...rails, house, lantern, cargo)
  object.scale.setScalar(0.7)
  return { object, cargo }
}

export const harbourVehicles: VehicleKit = {
  cars: () => [kitParts('car_sedan'), kitParts('car_taxi')],
  boat: makeBoat,
  boatLift: 0,
  boatBob: 0.05,
}
