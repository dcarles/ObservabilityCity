import * as THREE from 'three'
import { box, cyl, flat } from '../../buildings/mk'
import { kit } from '../../assets/kit'
import { palette } from '../active'
import { GROUND } from '../../scene/island'
import { ROAD_W } from '../../scene/props'
import type { BridgeStyle } from '../types'

/** A stone and concrete deck on tapered piers, with parapets, lamps and gate posts at each end. */
export const harbourBridge: BridgeStyle = {
  dress(deck, len, width, ends) {
    const stone = flat('#e4ddcc'), cap = flat('#f4efe3'), concrete = flat('#bdb6a6'), under = flat('#8d8777')
    deck.add(box(width, 0.34, len, concrete, { y: GROUND - 0.4 }), box(width - 0.5, 0.5, len, under, { y: GROUND - 0.88 }))
    for (const side of [-1, 1]) {
      // pavement, parapet and its cap
      deck.add(box(0.95, 0.12, len, flat(palette.island.pavement), { x: side * (ROAD_W / 2 + 0.45), y: GROUND - 0.06 }))
      deck.add(box(0.3, 0.8, len, stone, { x: side * (width / 2 - 0.15), y: GROUND - 0.06 }))
      deck.add(box(0.46, 0.12, len + 0.02, cap, { x: side * (width / 2 - 0.15), y: GROUND + 0.74 }))
    }
    // lamps along the parapets, arms leaning over the road
    const lamps = Math.max(1, Math.floor(len / 8))
    for (let i = 0; i < lamps; i++) {
      const z = -len / 2 + (i + 0.5) * (len / lamps)
      for (const side of [-1, 1]) {
        const l = kit('streetlight')
        l.scale.setScalar(2.0)
        l.position.set(side * (width / 2 - 0.5), GROUND + 0.05, z)
        l.rotation.y = side < 0 ? 0 : Math.PI
        deck.add(l)
      }
    }
    // gate posts at both ends
    for (const end of ends ? [-1, 1] : []) {
      for (const side of [-1, 1]) {
        const x = side * (width / 2 - 0.2), z = end * (len / 2 - 0.25)
        deck.add(box(0.7, 1.9, 0.7, stone, { x, y: GROUND - 0.06, z }), box(0.9, 0.14, 0.9, cap, { x, y: GROUND + 1.84, z }))
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffe7a3', toneMapped: false }))
        bulb.position.set(x, GROUND + 2.2, z)
        deck.add(bulb)
      }
    }
    // tapered piers into the water, with a rounded nose upstream and downstream
    const piers = Math.floor(len / 9)
    for (let i = 0; i < piers; i++) {
      const z = -len / 2 + (i + 1) * (len / (piers + 1))
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.25, 3.6, 8), stone)
      body.scale.set(1, 1, 1.5)
      body.position.set(0, GROUND - 2.6, z)
      body.castShadow = true
      const crown = box(width - 0.8, 0.3, 1.9, cap, { y: GROUND - 0.9, z })
      deck.add(body, crown)
    }
  },
}

/** A short wooden pier reaching out from the coast, with posts. */
export function harbourPier(length: number): THREE.Group {
  const g = new THREE.Group()
  const wood = flat(palette.wood), dark = flat(palette.woodDark)
  for (let i = 0; i < Math.round(length / 0.8); i++) g.add(box(3.4, 0.16, 0.74, i % 2 ? wood : dark, { y: GROUND - 0.1, z: i * 0.8 }))
  for (let i = 0; i <= Math.floor(length / 2.4); i++) {
    for (const side of [-1, 1]) g.add(cyl(0.16, 0.2, 2.2, dark, { x: side * 1.55, y: GROUND - 1.9, z: i * 2.4 }, 8))
  }
  // mooring posts at the end
  for (const side of [-1, 1]) g.add(cyl(0.14, 0.18, 0.7, dark, { x: side * 1.45, y: GROUND, z: length - 0.4 }, 8))
  return g
}

