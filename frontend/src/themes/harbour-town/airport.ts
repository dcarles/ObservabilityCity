import * as THREE from 'three'
import { box, cyl, flat, group } from '../../buildings/mk'
import { kit } from '../../assets/kit'
import { GROUND, type Rect } from '../../scene/island'
import { blockPad, lamp, street, ROAD_W } from '../../scene/props'
import { fin, fuselage, plate, runway, tube } from '../aircraft'
import type { AirportKit, AirportSite } from '../types'

/** An airliner: a turned fuselage with a rounded nose and a tapering tail, swept wings with engines under them, a swept fin and tail planes. Nose along +x, about 13 long. */
function airliner(): THREE.Group {
  const body = new THREE.MeshLambertMaterial({ color: '#f6f8fb', flatShading: true })
  const dark = new THREE.MeshLambertMaterial({ color: '#4d5663', flatShading: true })
  const glass = new THREE.MeshLambertMaterial({ color: '#2b3f5c', flatShading: true })
  const tailMat = new THREE.MeshLambertMaterial({ color: '#e4572e', flatShading: true })
  const g = new THREE.Group()
  g.add(fuselage([[-6.6, 0.1], [-5.6, 0.32], [-4.2, 0.62], [-2.5, 0.84], [3.4, 0.86], [4.8, 0.74], [5.8, 0.48], [6.5, 0.18], [6.7, 0]], body))
  // wings, swept back, low on the body, with a drooped tip
  const wings = plate([[1.6, 0], [-1.6, 6.6], [-2.8, 6.6], [-2.3, 0], [-2.8, -6.6], [-1.6, -6.6]], 0.16, dark)
  wings.position.set(0.5, -0.35, 0)
  const wingtips = [-1, 1].map((s) => {
    const t = plate([[-1.6, 0], [-2.2, 0.9 * s], [-2.8, 0.9 * s], [-2.8, 0]], 0.12, tailMat)
    t.position.set(0.5, -0.1, 6.6 * s)
    t.rotation.x = 0.5 * -s
    t.userData.tail = true
    return t
  })
  // engines slung under the wings, each with a dark intake
  const engines = [-2.7, 2.7].flatMap((z) => [tube(0.5, 1.9, body, [1.0, -0.95, z], 12), tube(0.42, 0.12, dark, [2.0, -0.95, z], 12)])
  // tail: a swept fin in the airline colour, tail planes, and a stripe along the windows
  const fn = fin([[-5.2, 0.45], [-3.5, 0.45], [-4.5, 2.9], [-5.6, 2.9]], 0.16, tailMat)
  fn.userData.tail = true
  const stab = plate([[-4.1, 0], [-5.3, 2.2], [-6.0, 2.2], [-5.6, 0], [-6.0, -2.2], [-5.3, -2.2]], 0.12, dark)
  stab.position.set(0, 0.28, 0)
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.22, 1.1), glass)
  cockpit.position.set(5.3, 0.36, 0)
  const windows = [-1, 1].map((s) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.16, 0.06), glass)
    w.position.set(0.3, 0.22, 0.83 * s)
    return w
  })
  g.add(wings, ...wingtips, ...engines, fn, stab, cockpit, ...windows)
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
  return g
}

function dress(decor: THREE.Group, site: AirportSite): { avoid: Rect[]; tick: (time: number) => void } {
  const { runwayZ, runwayHalf, terminalZ, apronZ, gateZ } = site
  const avoid: Rect[] = [
    { x: 0, z: runwayZ, w: 2 * runwayHalf + 14, d: 12 },
    { x: 0, z: (gateZ + terminalZ) / 2, w: 40, d: gateZ - terminalZ + 6 },
    { x: 0, z: terminalZ, w: 66, d: 14 },
  ]
  const white = flat('#f4f1e8', { roughness: 0.9 })
  const dark = flat('#3b4250', { roughness: 0.95 })
  runway(decor, site, '#3b4250', '#f4f1e8')
  // the taxiway and the apron in front of the terminal
  decor.add(blockPad(0, runwayZ + 3, terminalZ + 7.5, 46))
  decor.add(box(4.6, 0.12, 8, dark, { x: 24, y: GROUND - 0.02, z: runwayZ + 7.4 }))

  // terminal: a long low hall with a glass front, a tower and a hangar
  const wall = flat('#e9edf2'), roofM = flat('#5b6b82'), glass = flat('#6fb6e0', { emissive: '#2a6fa0', emissiveIntensity: 0.35 }), trim = flat('#ff7a45')
  const terminal = group(
    box(24, 4.4, 8, wall, { y: GROUND }),
    box(25.2, 0.5, 9.4, roofM, { y: GROUND + 4.4 }),
    box(22, 2.2, 0.2, glass, { y: GROUND + 1.2, z: 4.1 }),
    box(25.2, 0.28, 0.4, trim, { y: GROUND + 4.9, z: 4.6 }),
  )
  terminal.position.z = terminalZ
  decor.add(terminal)
  const tower = group(
    cyl(1.2, 1.5, 9, wall, { y: GROUND }),
    cyl(2.6, 2.1, 1.7, glass, { y: GROUND + 9 }),
    cyl(2.9, 2.9, 0.4, roofM, { y: GROUND + 10.7 }),
    cyl(0.06, 0.06, 2.2, roofM, { y: GROUND + 11.1 }),
  )
  tower.position.set(-17, 0, terminalZ - 1)
  decor.add(tower)
  const hangar = group(box(10, 4.2, 8, flat('#c7ced8'), { y: GROUND }), box(10.4, 1.4, 8.4, roofM, { y: GROUND + 4.2 }), box(6, 3.2, 0.2, flat('#8b95a3'), { y: GROUND, z: 4.1 }))
  hangar.position.set(21, 0, terminalZ - 0.5)
  decor.add(hangar)
  avoid.push({ x: -17, z: terminalZ - 1, w: 7, d: 7 }, { x: 21, z: terminalZ - 0.5, w: 13, d: 11 })

  // a windsock at the runway's end
  const pole = cyl(0.1, 0.12, 3.4, white, { y: GROUND })
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.8, 7, 1, true), new THREE.MeshStandardMaterial({ color: '#ff7a45', side: THREE.DoubleSide, flatShading: true }))
  sock.geometry.rotateZ(-Math.PI / 2)
  sock.position.set(0.9, GROUND + 3.2, 0)
  sock.userData.keep = true
  const sockGroup = group(pole, sock)
  sockGroup.position.set(runwayHalf + 6, 0, runwayZ - 4.5)
  decor.add(sockGroup)

  // the road from the gate to the terminal, with a small car park beside it
  decor.add(street(0, apronZ, gateZ + 0.2))
  decor.add(blockPad(14, apronZ - 1, apronZ + 6, 12))
  for (let i = 0; i < 5; i++) {
    const car = kit(i % 2 ? 'car_hatchback' : 'car_stationwagon')
    car.scale.setScalar(0.9)
    car.position.set(9.5 + i * 2.2, GROUND + 0.1, apronZ + 2.2)
    car.rotation.y = Math.PI / 2
    decor.add(car)
  }
  for (const side of [-1, 1]) decor.add(lamp(side * (ROAD_W / 2 + 1.6), apronZ + 3 + (side + 1) * 3, 0))
  avoid.push({ x: 14, z: apronZ + 2.5, w: 14, d: 9 })
  return { avoid, tick: (time) => { sock.rotation.y = Math.sin(time * 0.6) * 0.25; sock.rotation.z = Math.sin(time * 2.1) * 0.06 } }
}

/** The harbour town's airport: a tarmac runway, a glass-fronted terminal, a control tower and a hangar; airliners land on it. */
export const harbourAirport: AirportKit = { look: 'airliner', landing: { kind: 'runway' }, dress, craft: airliner }
