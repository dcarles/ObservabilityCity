import * as THREE from 'three'
import { box, cyl, flat } from '../../buildings/mk'
import { GROUND } from '../../scene/island'
import { ROAD_W } from '../../scene/props'
import type { BridgeStyle } from '../types'
import { glow } from '../common'

const METAL = '#2c3152'
const PLATE = '#8d97c4'
const CYAN = '#6fe7ff'

/** A light bridge: a dark plated deck with glowing edges, a thin field instead of a parapet, and slim pylons holding it up. */
export const spaceBridge: BridgeStyle = {
  dress(deck, len, width, ends) {
    const field = new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.16, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
    deck.add(box(width, 0.34, len, flat(METAL, { metalness: 0.4 }), { y: GROUND - 0.4 }), box(width - 0.5, 0.4, len, flat('#1b1f38'), { y: GROUND - 0.8 }))
    for (const side of [-1, 1]) {
      deck.add(box(0.95, 0.12, len, flat(PLATE), { x: side * (ROAD_W / 2 + 0.45), y: GROUND - 0.06 }))
      deck.add(box(0.12, 0.1, len, glow(CYAN), { x: side * (width / 2 - 0.1), y: GROUND + 0.06 }))
      deck.add(box(0.04, 0.9, len, field, { x: side * (width / 2 - 0.1), y: GROUND + 0.1 }))
    }
    // lamps: glowing orbs on slim posts along both edges
    const lamps = Math.max(1, Math.floor(len / 8))
    for (let i = 0; i < lamps; i++) {
      const z = -len / 2 + (i + 0.5) * (len / lamps)
      for (const side of [-1, 1]) {
        deck.add(cyl(0.05, 0.07, 1.9, flat(PLATE, { metalness: 0.4 }), { x: side * (width / 2 - 0.3), y: GROUND, z }, 6))
        const orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), glow('#d6f6ff'))
        orb.position.set(side * (width / 2 - 0.3), GROUND + 2.0, z)
        deck.add(orb)
      }
    }
    // gate pylons at both ends
    for (const end of ends ? [-1, 1] : []) {
      for (const side of [-1, 1]) {
        const x = side * (width / 2 - 0.2), z = end * (len / 2 - 0.25)
        deck.add(cyl(0.22, 0.34, 2.3, flat(PLATE, { metalness: 0.4 }), { x, y: GROUND - 0.06, z }, 8))
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 6, 16), glow(CYAN))
        ring.rotation.x = Math.PI / 2
        ring.position.set(x, GROUND + 1.9, z)
        deck.add(ring)
      }
    }
    // pylons down into the void, each with a glowing ring
    const piers = Math.floor(len / 9)
    for (let i = 0; i < piers; i++) {
      const z = -len / 2 + (i + 1) * (len / (piers + 1))
      deck.add(cyl(0.3, 0.55, 3.8, flat(METAL, { metalness: 0.4 }), { y: GROUND - 3.9, z }, 8), box(width - 0.8, 0.3, 0.9, flat(PLATE), { y: GROUND - 0.9, z }))
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 6, 18), glow('#a98bff'))
      ring.rotation.x = Math.PI / 2
      ring.position.set(0, GROUND - 1.6, z)
      deck.add(ring)
    }
  },
}

/** A docking gantry reaching out from the platform's edge, with glowing edges and posts. */
export function spacePier(length: number): THREE.Group {
  const g = new THREE.Group()
  const plate = flat(PLATE, { metalness: 0.3 }), dark = flat(METAL, { metalness: 0.4 })
  for (let i = 0; i < Math.round(length / 0.8); i++) g.add(box(3.4, 0.16, 0.74, i % 2 ? plate : flat('#7a84b0', { metalness: 0.3 }), { y: GROUND - 0.1, z: i * 0.8 }))
  g.add(box(0.1, 0.08, length, glow(CYAN), { x: -1.65, y: GROUND + 0.04 }), box(0.1, 0.08, length, glow(CYAN), { x: 1.65, y: GROUND + 0.04 }))
  for (let i = 0; i <= Math.floor(length / 2.4); i++) {
    for (const side of [-1, 1]) g.add(cyl(0.14, 0.2, 2.2, dark, { x: side * 1.55, y: GROUND - 1.9, z: i * 2.4 }, 8))
  }
  for (const side of [-1, 1]) g.add(cyl(0.14, 0.18, 0.7, flat('#59618f', { metalness: 0.4 }), { x: side * 1.45, y: GROUND, z: length - 0.4 }, 8))
  return g
}
