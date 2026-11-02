import * as THREE from 'three'
import { box, cyl, flat } from '../../buildings/mk'
import { GROUND } from '../../scene/island'
import { ROAD_W } from '../../scene/props'
import { palette } from '../active'
import type { BridgeStyle } from '../types'
import { endList, glow } from '../common'

const STEEL = '#59626c'
const YELLOW = '#f2c230'

/** A steel truss bridge: a plated deck between two lattice girders, with yellow guard rails and steel legs into the canal. */
export const factoryBridge: BridgeStyle = {
  dress(deck, len, width, ends) {
    const steel = flat(STEEL, { metalness: 0.4 }), yellow = flat(YELLOW, { metalness: 0.2 }), dark = flat('#2f353c', { metalness: 0.3 })
    deck.add(box(width, 0.34, len, dark, { y: GROUND - 0.4 }), box(width - 0.5, 0.5, len, steel, { y: GROUND - 0.88 }))
    const bays = Math.max(1, Math.round(len / 3))
    const bay = len / bays
    const H = 1.7
    const diag = Math.hypot(bay, H)
    const tilt = Math.atan2(H, bay)
    for (const side of [-1, 1]) {
      const x = side * (width / 2 - 0.15)
      deck.add(box(0.95, 0.12, len, flat(palette.island.pavement), { x: side * (ROAD_W / 2 + 0.45), y: GROUND - 0.06 }))
      // top and bottom chords
      deck.add(box(0.16, 0.16, len, yellow, { x, y: GROUND + H }), box(0.16, 0.16, len, steel, { x, y: GROUND - 0.06 }))
      for (let i = 0; i <= bays; i++) deck.add(box(0.12, H, 0.12, steel, { x, y: GROUND, z: -len / 2 + i * bay }))
      for (let i = 0; i < bays; i++) {
        const d = box(0.1, diag, 0.1, steel, { x, y: GROUND + H / 2, z: -len / 2 + (i + 0.5) * bay })
        d.geometry.translate(0, -diag / 2, 0)
        d.rotation.x = (i % 2 ? 1 : -1) * (Math.PI / 2 - tilt)
        deck.add(d)
      }
      // floodlights on the top chord
      if (bays > 1) for (let i = 1; i < bays; i += 2) deck.add(box(0.3, 0.14, 0.5, glow('#fff1c9'), { x: x - side * 0.25, y: GROUND + H - 0.06, z: -len / 2 + i * bay }))
    }
    // cross beams along the top
    for (let i = 0; i <= bays; i++) deck.add(box(width - 0.3, 0.1, 0.1, steel, { y: GROUND + H + 0.03, z: -len / 2 + i * bay }))
    // gate posts: tall girders with an amber lamp
    for (const end of endList(ends)) {
      for (const side of [-1, 1]) {
        const x = side * (width / 2 - 0.2), z = end * (len / 2 - 0.25)
        deck.add(box(0.5, 2.3, 0.5, yellow, { x, y: GROUND - 0.06, z }))
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), glow('#ffb830'))
        lamp.position.set(x, GROUND + 2.5, z)
        deck.add(lamp)
      }
    }
    // steel legs into the canal, braced in pairs
    const piers = Math.floor(len / 9)
    for (let i = 0; i < piers; i++) {
      const z = -len / 2 + (i + 1) * (len / (piers + 1))
      for (const side of [-1, 1]) deck.add(cyl(0.22, 0.3, 3.6, steel, { x: side * 1.4, y: GROUND - 3.5, z }, 8))
      deck.add(box(3.2, 0.14, 0.14, steel, { y: GROUND - 2.2, z }), box(width - 0.8, 0.3, 1.2, yellow, { y: GROUND - 0.9, z }))
    }
  },
}

/** A concrete loading dock out from the quay, with steel piles, bollards and a yellow edge. */
export function factoryPier(length: number): THREE.Group {
  const g = new THREE.Group()
  const slab = flat('#a9a699'), edge = flat(YELLOW), steel = flat(STEEL, { metalness: 0.4 })
  g.add(box(3.4, 0.3, length, slab, { y: GROUND - 0.25, z: length / 2 }))
  g.add(box(0.12, 0.06, length, edge, { x: -1.55, y: GROUND + 0.05, z: length / 2 }), box(0.12, 0.06, length, edge, { x: 1.55, y: GROUND + 0.05, z: length / 2 }))
  for (let i = 0; i <= Math.floor(length / 2.4); i++) {
    for (const side of [-1, 1]) g.add(cyl(0.16, 0.2, 2.2, steel, { x: side * 1.55, y: GROUND - 1.9, z: i * 2.4 }, 8))
  }
  for (const side of [-1, 1]) g.add(cyl(0.18, 0.22, 0.5, flat('#23272d'), { x: side * 1.4, y: GROUND, z: length - 0.4 }, 10))
  return g
}
