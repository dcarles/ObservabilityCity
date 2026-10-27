import * as THREE from 'three'
import { box, cyl, dome, flat, group, sphere } from '../../buildings/mk'
import { GROUND, type Rect } from '../../scene/island'
import { lamp, street, ROAD_W } from '../../scene/props'
import { glow } from '../common'
import type { AirportKit, AirportSite } from '../types'

const PADS = [-27, -9, 9, 27]

/** A flying saucer: a lens-shaped hull with a glass dome, a glowing rim and underside ring, three legs, and a beam that shows while it hovers. */
function saucer(): THREE.Group {
  const hull = new THREE.MeshLambertMaterial({ color: '#dfe6fa', flatShading: true })
  const rimMat = new THREE.MeshLambertMaterial({ color: '#a98bff', flatShading: true, emissive: '#3a2c7a' })
  const g = new THREE.Group()
  const lens = new THREE.LatheGeometry([[0, -0.5], [1.6, -0.45], [3.3, -0.1], [4.0, 0.12], [3.2, 0.5], [1.7, 0.85], [0, 0.95]].map(([r, y]) => new THREE.Vector2(r, y)), 18)
  const body = new THREE.Mesh(lens, hull)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(3.7, 0.22, 6, 24), rimMat)
  rim.rotation.x = Math.PI / 2
  rim.position.y = 0.14
  rim.userData.tail = true
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#8fe8ff', flatShading: true, emissive: '#1f7a99' }))
  canopy.position.y = 0.8
  canopy.scale.y = 0.85
  const under = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.1, 6, 20), glow('#6fe7ff'))
  under.rotation.x = Math.PI / 2
  under.position.y = -0.52
  g.add(body, rim, canopy, under)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 4), glow(i % 2 ? '#6fe7ff' : '#ffd45e'))
    light.position.set(Math.cos(a) * 3.9, 0.14, Math.sin(a) * 3.9)
    g.add(light)
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 1.1, 6), new THREE.MeshLambertMaterial({ color: '#59618f' }))
    leg.position.set(Math.cos(a) * 1.9, -0.95, Math.sin(a) * 1.9)
    g.add(leg)
  }
  const beam = new THREE.Mesh(new THREE.ConeGeometry(2.6, 4.2, 18, 1, true), new THREE.MeshBasicMaterial({ color: '#6fe7ff', transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }))
  beam.position.y = -2.6
  beam.userData.beam = true
  beam.visible = false
  g.add(beam)
  g.scale.setScalar(0.95)
  g.traverse((o) => { if (o instanceof THREE.Mesh && !o.userData.beam) o.castShadow = true })
  return g
}

function dress(decor: THREE.Group, site: AirportSite): { avoid: Rect[]; tick: (time: number) => void } {
  const { runwayZ, runwayHalf, terminalZ, apronZ, gateZ } = site
  const avoid: Rect[] = [
    { x: 0, z: runwayZ, w: 2 * runwayHalf + 14, d: 12 },
    { x: 0, z: (gateZ + terminalZ) / 2, w: 40, d: gateZ - terminalZ + 6 },
    { x: 0, z: terminalZ, w: 66, d: 14 },
  ]
  const plating = flat('#343a52', { roughness: 0.8, metalness: 0.3 }), light = flat('#dfe6fa', { metalness: 0.2 }), metal = flat('#59618f', { metalness: 0.4 })
  // a landing deck with a round pad for each arriving ship, ringed in light
  decor.add(box(2 * runwayHalf + 8, 0.12, 7, flat('#2a3047', { roughness: 0.8, metalness: 0.3 }), { y: GROUND - 0.02, z: runwayZ }))
  for (const x of PADS) {
    decor.add(cyl(3.5, 3.5, 0.16, plating, { x, y: GROUND, z: runwayZ }, 24))
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.09, 4, 28), glow('#6fe7ff'))
    ring.rotation.x = Math.PI / 2
    ring.position.set(x, GROUND + 0.22, runwayZ)
    decor.add(ring)
    decor.add(cyl(1.0, 1.0, 0.04, glow('#a98bff'), { x, y: GROUND + 0.16, z: runwayZ }, 16))
  }
  decor.add(box(46, 0.1, terminalZ + 7.5 - (runwayZ + 3), flat('#a4acd0', { roughness: 0.9 }), { y: GROUND - 0.02, z: (runwayZ + 3 + terminalZ + 7.5) / 2 }))

  // terminal: a low hall with two glass habitat domes and a glowing front
  const terminal = group(
    box(24, 3.4, 8, light, { y: GROUND }),
    box(25, 0.3, 9, metal, { y: GROUND + 3.4 }),
    box(22, 1.8, 0.2, flat('#6fe7ff', { emissive: '#2aa6c9', emissiveIntensity: 0.6 }), { y: GROUND + 0.9, z: 4.1 }),
    box(25, 0.12, 0.2, glow('#a98bff'), { y: GROUND + 3.55, z: 4.6 }),
    dome(3.6, flat('#8fe8ff', { roughness: 0.2, emissive: '#1f7a99', emissiveIntensity: 0.5 }), { x: -6, y: GROUND + 3.7 }),
    dome(3.6, flat('#8fe8ff', { roughness: 0.2, emissive: '#1f7a99', emissiveIntensity: 0.5 }), { x: 6, y: GROUND + 3.7 }),
  )
  terminal.position.z = terminalZ
  decor.add(terminal)
  // control spire with a glowing ring and a beacon
  const spire = group(
    cyl(0.7, 1.3, 10, light, { y: GROUND }, 12),
    cyl(2.4, 0.9, 1.6, flat('#6fe7ff', { emissive: '#2aa6c9', emissiveIntensity: 0.6 }), { y: GROUND + 8.4 }, 12),
    sphere(0.6, glow('#ffd45e'), { y: GROUND + 11.4 }, 10),
  )
  const spireRing = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.08, 4, 24), glow('#a98bff'))
  spireRing.rotation.x = Math.PI / 2
  spireRing.position.y = GROUND + 7.6
  spire.add(spireRing)
  spire.position.set(-17, 0, terminalZ - 1)
  decor.add(spire)
  // cargo pods lying side by side, where the hangar stands in other towns
  for (let i = 0; i < 3; i++) {
    const pod = cyl(2.0, 2.0, 8, flat(['#7684d8', '#dfe6fa', '#5c6fd6'][i], { metalness: 0.3 }), { x: 21 + (i - 1) * 4.6, y: GROUND + 2.0, z: terminalZ - 0.5, rx: Math.PI / 2 }, 12)
    decor.add(pod, box(4.1, 0.1, 0.1, glow('#6fe7ff'), { x: 21 + (i - 1) * 4.6, y: GROUND + 3.9, z: terminalZ - 0.5 }))
  }
  avoid.push({ x: -17, z: terminalZ - 1, w: 7, d: 7 }, { x: 21, z: terminalZ - 0.5, w: 16, d: 11 })

  // a radar dish that turns slowly, where the windsock is elsewhere
  const mastM = cyl(0.12, 0.16, 3, metal, { y: GROUND }, 8)
  const dish = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), flat('#dfe6fa', { metalness: 0.3 }))
  dish.rotation.x = -0.9
  dish.position.y = GROUND + 3.2
  dish.userData.keep = true
  const dishGroup = group(mastM, dish)
  dishGroup.position.set(runwayHalf + 6, 0, runwayZ - 4.5)
  decor.add(dishGroup)

  decor.add(street(0, apronZ, gateZ + 0.2))
  for (let i = 0; i < 5; i++) decor.add(cyl(0.18, 0.18, 0.7, glow(i % 2 ? '#6fe7ff' : '#a98bff'), { x: 10 + i * 1.6, y: GROUND, z: apronZ + 2.4 }, 8))
  for (const side of [-1, 1]) decor.add(lamp(side * (ROAD_W / 2 + 1.6), apronZ + 3 + (side + 1) * 3, 0))
  avoid.push({ x: 13, z: apronZ + 2.5, w: 10, d: 4 })
  return { avoid, tick: (time) => { dish.rotation.y = time * 0.5 } }
}

/** The colony's spaceport: round landing pads ringed in light, glass habitat domes, a control spire, and flying saucers that drop onto the pads. */
export const spaceAirport: AirportKit = { look: 'saucer', landing: { kind: 'pads', x: PADS }, dress, craft: saucer }
