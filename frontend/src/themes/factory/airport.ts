import * as THREE from 'three'
import { box, cyl, flat, group } from '../../buildings/mk'
import { GROUND, type Rect } from '../../scene/island'
import { lamp, street, ROAD_W } from '../../scene/props'
import { fin, fuselage, plate, runway, tube } from '../aircraft'
import type { AirportKit, AirportSite } from '../types'

/** A freighter: a deep, blunt fuselage with a swept-up tail, a high straight wing carrying four propellers, and a T-tail. Nose along +x, about 14 long. */
function freighter(): THREE.Group {
  const body = new THREE.MeshLambertMaterial({ color: '#cfd4da', flatShading: true })
  const belly = new THREE.MeshLambertMaterial({ color: '#7d858e', flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: '#41454a', flatShading: true })
  const glass = new THREE.MeshLambertMaterial({ color: '#2f4458', flatShading: true })
  const stripe = new THREE.MeshLambertMaterial({ color: '#e07a3f', flatShading: true })
  const tailMat = new THREE.MeshLambertMaterial({ color: '#e4572e', flatShading: true })
  const g = new THREE.Group()
  g.add(fuselage([[-7.4, 0.3], [-6.4, 0.7], [-4.6, 1.3], [-2.5, 1.55], [3.8, 1.6], [5.4, 1.45], [6.5, 1.0], [7.0, 0.5], [7.1, 0]], body, 12))
  // cargo ramp under the raised tail, an orange band round the middle, and the cockpit
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.2, 2.2), belly)
  ramp.position.set(-5.4, -0.55, 0)
  ramp.rotation.z = 0.28
  const band = tube(1.64, 0.7, stripe, [0.3, 0, 0], 12)
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.9), glass)
  cockpit.position.set(5.6, 0.75, 0)
  // sponsons for the landing gear
  const pods = [-1, 1].map((s) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.9, 0.9), belly)
    p.position.set(-0.5, -1.15, 1.45 * s)
    return p
  })
  // a high straight wing with four turboprops; each propeller is a dark disc and a spinner
  const wing = plate([[1.6, 0], [1.1, 8.8], [-1.6, 8.8], [-1.6, 0], [-1.6, -8.8], [1.1, -8.8]], 0.22, body)
  wing.position.set(0.8, 1.7, 0)
  const props = [-6.2, -3.0, 3.0, 6.2].flatMap((z) => [
    tube(0.4, 2.6, belly, [1.9, 1.35, z], 10),
    tube(1.05, 0.05, dark, [3.3, 1.35, z], 14),
    tube(0.2, 0.5, stripe, [3.4, 1.35, z], 8),
  ])
  // T-tail: a tall fin in the airline colour, the tail plane on top of it
  const fn = fin([[-6.6, 1.1], [-4.0, 1.4], [-5.4, 5.0], [-7.2, 5.0]], 0.2, tailMat)
  fn.userData.tail = true
  const stab = plate([[-5.2, 0], [-6.6, 3.2], [-7.4, 3.2], [-7.0, 0], [-7.4, -3.2], [-6.6, -3.2]], 0.16, body)
  stab.position.set(0, 4.95, 0)
  g.add(ramp, band, cockpit, ...pods, wing, ...props, fn, stab)
  g.scale.setScalar(0.85)
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
  return g
}

const BOX_COLOURS = ['#3f7fc9', '#d9573f', '#f2c230', '#5f8fb0', '#8a8f78']

function dress(decor: THREE.Group, site: AirportSite): { avoid: Rect[]; tick: (time: number) => void } {
  const { runwayZ, runwayHalf, terminalZ, apronZ, gateZ } = site
  const avoid: Rect[] = [
    { x: 0, z: runwayZ, w: 2 * runwayHalf + 14, d: 12 },
    { x: 0, z: (gateZ + terminalZ) / 2, w: 40, d: gateZ - terminalZ + 6 },
    { x: 0, z: terminalZ, w: 66, d: 14 },
  ]
  runway(decor, site, '#41454a', '#f2c230')
  const concrete = flat('#c1bdae', { roughness: 0.95 })
  decor.add(box(46, 0.1, terminalZ + 7.5 - (runwayZ + 3), concrete, { y: GROUND - 0.02, z: (runwayZ + 3 + terminalZ + 7.5) / 2 }))
  decor.add(box(4.6, 0.12, 8, flat('#41454a', { roughness: 0.95 }), { x: 24, y: GROUND - 0.02, z: runwayZ + 7.4 }))

  // freight terminal: a brick hall with a saw-tooth roof and loading doors along the front
  const brick = flat('#b5573d'), roofM = flat('#5c6168'), door = flat('#2a2e34'), hazard = flat('#f2c230')
  const hall = group(box(24, 4.6, 8, brick, { y: GROUND }), box(25, 0.3, 9, roofM, { y: GROUND + 4.6 }))
  for (let i = 0; i < 4; i++) {
    const tooth = box(5.6, 1.8, 0.4, roofM, { x: -9 + i * 6, y: GROUND + 4.9, z: 1.5 })
    tooth.rotation.x = -0.5
    hall.add(tooth)
    hall.add(box(3.4, 3.0, 0.2, door, { x: -9 + i * 6, y: GROUND, z: 4.05 }))
    hall.add(box(3.8, 0.14, 0.26, hazard, { x: -9 + i * 6, y: GROUND + 3.0, z: 4.07 }))
  }
  hall.position.z = terminalZ
  decor.add(hall)
  // control tower: a concrete shaft with a glazed cab
  const tower = group(
    box(2.6, 9, 2.6, flat('#cfd6dc'), { y: GROUND }),
    box(4.4, 2, 4.4, flat('#3e5870', { emissive: '#1d3b54', emissiveIntensity: 0.3 }), { y: GROUND + 9 }),
    box(5, 0.4, 5, roofM, { y: GROUND + 11 }),
    cyl(0.06, 0.06, 2.4, roofM, { y: GROUND + 11.4 }),
  )
  tower.position.set(-17, 0, terminalZ - 1)
  decor.add(tower)
  // a container yard with a gantry crane over it
  for (let c = 0; c < 3; c++) for (let r = 0; r < 2; r++) {
    for (let h = 0; h < 2 - (c === 1 ? 0 : r); h++) decor.add(box(5, 1.5, 2.2, flat(BOX_COLOURS[(c * 2 + r + h) % BOX_COLOURS.length], { metalness: 0.2 }), { x: 17 + c * 5.4, y: GROUND + h * 1.5, z: terminalZ - 2.5 + r * 2.6 }))
  }
  const steel = flat('#f2c230', { metalness: 0.2 })
  const crane = group(
    box(0.5, 6.4, 0.5, steel, { x: -7.4, y: GROUND }), box(0.5, 6.4, 0.5, steel, { x: 7.4, y: GROUND }),
    box(0.5, 6.4, 0.5, steel, { x: -7.4, y: GROUND, z: 5.8 }), box(0.5, 6.4, 0.5, steel, { x: 7.4, y: GROUND, z: 5.8 }),
    box(15.6, 0.6, 0.6, steel, { y: GROUND + 6.4 }), box(15.6, 0.6, 0.6, steel, { y: GROUND + 6.4, z: 5.8 }),
  )
  crane.position.set(22.4, 0, terminalZ - 3.4)
  decor.add(crane)
  avoid.push({ x: -17, z: terminalZ - 1, w: 7, d: 7 }, { x: 22, z: terminalZ - 1.5, w: 20, d: 12 })

  // a windsock at the runway's end
  const pole = cyl(0.1, 0.12, 3.4, flat('#f4f1e8'), { y: GROUND })
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.8, 7, 1, true), new THREE.MeshStandardMaterial({ color: '#f2c230', side: THREE.DoubleSide, flatShading: true }))
  sock.geometry.rotateZ(-Math.PI / 2)
  sock.position.set(0.9, GROUND + 3.2, 0)
  sock.userData.keep = true
  const sockGroup = group(pole, sock)
  sockGroup.position.set(runwayHalf + 6, 0, runwayZ - 4.5)
  decor.add(sockGroup)

  // the road from the gate to the terminal, with a row of drums beside it
  decor.add(street(0, apronZ, gateZ + 0.2))
  for (let i = 0; i < 4; i++) decor.add(cyl(0.34, 0.34, 0.9, flat(BOX_COLOURS[i], { metalness: 0.3 }), { x: 10 + i * 1.1, y: GROUND, z: apronZ + 2.4 }, 12))
  for (const side of [-1, 1]) decor.add(lamp(side * (ROAD_W / 2 + 1.6), apronZ + 3 + (side + 1) * 3, 0))
  avoid.push({ x: 12, z: apronZ + 2.5, w: 8, d: 4 })
  return { avoid, tick: (time) => { sock.rotation.y = Math.sin(time * 0.6) * 0.25; sock.rotation.z = Math.sin(time * 2.1) * 0.06 } }
}

/** The works' airport: an air-freight field with a brick terminal, containers under a gantry, and cargo planes. */
export const factoryAirport: AirportKit = { look: 'cargo plane', landing: { kind: 'runway' }, dress, craft: freighter }
