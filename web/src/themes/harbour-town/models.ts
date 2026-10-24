import * as THREE from 'three'
import type { NodeKind } from '../../types'
import type { BuildingModel } from '../../buildings/model'
import { at, box, canvasTexture, cone, cyl, dome, flat, group, sphere } from '../../buildings/mk'
import { makeWindowMaterial } from '../../buildings/windowMaterial'
import { palette } from './palette'

const P = palette.building
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** Builds the model for a building kind. The accent is the owning island's flag colour. */
export function buildModel(kind: NodeKind, accent: string): BuildingModel {
  switch (kind) {
    case 'Api': return apiTower(accent)
    case 'Worker': return factory(accent)
    case 'Database': return tanks()
    case 'Cache': return waterTower()
    case 'Cron': return clockTower()
    case 'Gateway': return gateway(accent)
    case 'Broker': return port()
    case 'Egress': return egress(accent)
  }
}

function door(w: number, h: number, z: number, color = '#2b3340'): THREE.Mesh {
  return box(w, h, 0.12, flat(color, { roughness: 0.4 }), { z })
}

/** Sloped awning in the island's colour over a door. */
function awning(w: number, y: number, z: number, color: string): THREE.Mesh {
  return box(w, 0.1, 0.7, flat(color), { y, z, rx: 0.25 })
}

function mast(h: number): THREE.Mesh {
  return cyl(0.05, 0.07, h, flat('#9aa3ad', { metalness: 0.3 }), {}, 8)
}

// ── API: office tower ────────────────────────────────────────────────────────

function apiTower(accent: string): BuildingModel {
  const W = 3.5
  const FH = 1.5
  const base = group(
    box(4.8, 1.0, 4.6, flat(P.apiPodium), {}),
    box(5.0, 0.12, 4.8, flat('#bdb4a2'), { y: 1.0 }),
    door(1.2, 0.8, 2.31),
    awning(1.9, 0.95, 2.55, accent),
  )
  const roof = group(
    box(W + 0.3, 0.22, W + 0.3, flat('#aab4c0')),
    box(1.0, 0.45, 0.8, flat('#8a94a0'), { x: -0.9, y: 0.22, z: -0.7 }),
    box(0.7, 0.3, 0.7, flat('#8a94a0'), { x: 1.0, y: 0.22, z: 0.8 }),
    at(mast(1.5), 0, 0.22, 0),
  )
  return {
    base,
    baseHeight: 1.12,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.apiBody, cols: 4, rows: 1, winW: 0.62, winH: 0.58 })
      return { object: box(W, FH, W, material), uniforms }
    },
    roof,
    beaconAt: v(0, 1.72, 0),
    door: v(0, 0, 2.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.75, 0.55, 2.32), width: 1.5 },
    radius: 3,
  }
}

// ── Worker: factory with sawtooth roof and a smoking chimney ────────────────

function factory(accent: string): BuildingModel {
  const FH = 1.15
  const smoke: THREE.Mesh[] = []
  const smokeMat = new THREE.MeshStandardMaterial({ color: '#f4f4f4', transparent: true, opacity: 0.8, roughness: 1, flatShading: true })
  for (let i = 0; i < 6; i++) {
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), smokeMat.clone())
    smoke.push(puff)
  }
  const chimney = group(
    cyl(0.4, 0.5, 3.4, flat('#a9553d'), {}, 10),
    cyl(0.43, 0.43, 0.3, flat('#f2efe8'), { y: 3.0 }, 10),
    ...smoke,
  )
  chimney.position.set(-2.0, 0, -1.2)

  const base = group(
    box(6.2, 0.45, 5.0, flat('#b9b2a4')),
    box(2.0, 1.0, 0.14, flat('#59606c', { roughness: 0.5 }), { y: 0.45, z: 2.52 }),
    awning(2.4, 1.52, 2.7, accent),
  )
  // sawtooth roof: three triangular prisms
  const shape = new THREE.Shape()
  shape.moveTo(0, 0); shape.lineTo(1.75, 0); shape.lineTo(1.75, 0.9); shape.lineTo(0, 0)
  const sawGeo = new THREE.ExtrudeGeometry(shape, { depth: 4.3, bevelEnabled: false })
  sawGeo.translate(0, 0, -2.15)
  const roof = group()
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(sawGeo, flat(palette.building.workerRoof))
    m.position.x = -2.6 + i * 1.75
    m.castShadow = true
    roof.add(m)
  }
  roof.add(box(5.6, 0.18, 4.5, flat('#5b6270')))
  roof.children[roof.children.length - 1].position.y = -0.02
  roof.add(at(mast(1.2), 1.7, 0.0, 1.0))

  return {
    base: group(base, chimney),
    baseHeight: 0.45,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.workerBody, cols: 6, rows: 1, winW: 0.55, winH: 0.45 })
      return { object: box(5.7, FH, 4.6, material), uniforms }
    },
    roof,
    beaconAt: v(1.7, 1.25, 1.0),
    door: v(0, 0, 3.1),
    doorDir: v(0, 0, 1),
    plaque: { position: v(2.35, 0.2, 2.52), width: 1.5 },
    radius: 3.6,
    animate: (time) => {
      smoke.forEach((p, i) => {
        const life = ((time * 0.35 + i / smoke.length) % 1)
        p.position.set(Math.sin(i * 2.1 + time * 0.4) * 0.15 * life, 3.3 + life * 3.2, 0)
        p.scale.setScalar(0.5 + life * 1.4)
        ;(p.material as THREE.MeshStandardMaterial).opacity = 0.85 * (1 - life)
      })
    },
  }
}

// ── Database: storage tanks ─────────────────────────────────────────────────

function tanks(): BuildingModel {
  const FH = 1.0
  const R = 1.15
  const spots: [number, number][] = [[-1.35, -0.85], [1.35, -0.85], [0, 1.0]]
  const hut = group(
    box(1.8, 1.1, 1.3, flat('#e8e2d4'), {}),
    box(1.9, 0.12, 1.4, flat('#6c7480'), { y: 1.1 }),
    door(0.6, 0.75, 0.66),
  )
  hut.position.set(0, 0, 2.4)
  const base = group(box(5.8, 0.28, 5.8, flat('#b4ae9f')), hut)
  const roof = group()
  spots.forEach(([x, z]) => {
    roof.add(dome(R, flat('#9fc9d6'), { x, z }))
    roof.add(cyl(0.12, 0.12, 0.5, flat('#8a94a0'), { x, y: 1.0, z }, 8))
  })
  roof.add(box(2.7, 0.07, 0.35, flat('#5b6270'), { y: 0.55, z: -0.85 }))
  roof.add(at(mast(1.3), 0, 0.2, 0.1))
  return {
    base,
    baseHeight: 0.28,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.dbTank, cols: 8, rows: 1, winW: 0.28, winH: 0.4, roughness: 0.5 })
      const f = group()
      spots.forEach(([x, z]) => {
        const body = cyl(R, R, FH, material, { x, z }, 14)
        const band = cyl(R + 0.05, R + 0.05, 0.1, flat(P.dbBand), { x, y: 0, z }, 14)
        f.add(body, band)
      })
      return { object: f, uniforms }
    },
    roof,
    beaconAt: v(0, 1.5, 0.1),
    door: v(0, 0, 3.4),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.2, 0.5, 3.08), width: 1.3 },
    radius: 3.4,
  }
}

// ── Cache: water tower ──────────────────────────────────────────────────────

function waterTower(): BuildingModel {
  const FH = 1.05
  const legMat = flat(P.cacheLegs, { roughness: 0.7 })
  const base = group(box(3.4, 0.18, 3.4, flat('#b9b2a4')))
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const leg = cyl(0.09, 0.09, 3.1, legMat, { x: x * 1.2, z: z * 1.2, rx: z * -0.2, rz: x * 0.2 }, 6)
    leg.position.y = 0.1
    leg.scale.y = 1
    base.add(leg)
  }
  base.add(box(2.4, 0.07, 0.07, legMat, { y: 1.2, z: 0.95 }), box(2.4, 0.07, 0.07, legMat, { y: 1.2, z: -0.95 }))
  base.add(box(0.07, 0.07, 2.4, legMat, { y: 1.9, x: 0.95 }), box(0.07, 0.07, 2.4, legMat, { y: 1.9, x: -0.95 }))
  const shed = group(box(1.2, 0.9, 1.0, flat('#e8dfc9')), box(1.3, 0.1, 1.1, flat('#8a5a38'), { y: 0.9 }), door(0.45, 0.62, 0.52))
  shed.position.set(0, 0.18, 1.9)
  base.add(shed)
  const roof = group(cone(1.55, 1.0, flat('#d9892f'), {}, 12), sphere(0.12, flat('#d9892f'), { y: 1.05 }, 8))
  roof.add(at(mast(1.1), 0, 0.9, 0))
  return {
    base,
    baseHeight: 3.2,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cacheTank, cols: 10, rows: 1, winW: 0.3, winH: 0.4, roughness: 0.55 })
      const f = group(cyl(1.38, 1.38, FH, material, {}, 14), cyl(1.43, 1.43, 0.09, flat('#a8761d'), {}, 14), cyl(1.43, 1.43, 0.09, flat('#a8761d'), { y: FH - 0.09 }, 14))
      return { object: f, uniforms }
    },
    roof,
    beaconAt: v(0, 2.0, 0),
    door: v(0, 0, 2.7),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.0, 0.5, 2.42), width: 1.25 },
    radius: 2.6,
  }
}

// ── Cron: clock tower ───────────────────────────────────────────────────────

function clockTower(): BuildingModel {
  const FH = 1.5
  const stone = flat(P.cronStone)
  const base = group(
    box(3.0, 0.6, 3.0, flat('#b6ab94')),
    box(2.3, 2.4, 2.3, stone, { y: 0.6 }),
    box(0.8, 1.1, 0.12, flat('#5a4636', { roughness: 0.5 }), { y: 0.6, z: 1.17 }),
    cone(0.42, 0.25, flat('#5a4636'), { y: 1.7, z: 1.17 }, 12),
  )
  const faceTex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#fdf7e6'; ctx.beginPath(); ctx.arc(128, 128, 120, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = '#3b3128'; ctx.lineWidth = 10; ctx.stroke()
    ctx.lineWidth = 7
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      ctx.beginPath(); ctx.moveTo(128 + Math.cos(a) * 92, 128 + Math.sin(a) * 92); ctx.lineTo(128 + Math.cos(a) * 108, 128 + Math.sin(a) * 108); ctx.stroke()
    }
  })
  const faceMat = new THREE.MeshBasicMaterial({ map: faceTex })
  const hands = new THREE.Group()
  const hourHand = box(0.07, 0.34, 0.03, flat('#2b2622'))
  const minuteHand = box(0.05, 0.5, 0.03, flat('#2b2622'))
  hands.add(hourHand, minuteHand)
  const roof = group(box(2.8, 1.9, 2.8, stone))
  for (const [x, z, ry] of [[0, 1.41, 0], [0, -1.41, Math.PI], [1.41, 0, Math.PI / 2], [-1.41, 0, -Math.PI / 2]] as const) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.78, 24), faceMat)
    face.position.set(x, 0.95, z)
    face.rotation.y = ry
    roof.add(face)
  }
  hands.position.set(0, 0.95, 1.44)
  roof.add(hands)
  roof.add(cone(2.05, 1.9, flat(P.cronRoof), { y: 1.9, ry: Math.PI / 4 }, 4))
  roof.add(at(mast(1.0), 0, 3.6, 0))
  return {
    base,
    baseHeight: 3.0,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cronStone, cols: 2, rows: 1, winW: 0.34, winH: 0.6 })
      return { object: box(2.2, FH, 2.2, material), uniforms }
    },
    roof,
    beaconAt: v(0, 4.6, 0),
    door: v(0, 0, 1.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.0, 0.5, 1.51), width: 1.2 },
    radius: 2.2,
    animate: (time) => {
      minuteHand.rotation.z = -time * 0.5
      hourHand.rotation.z = -time * 0.04
    },
  }
}

// ── Gateway: the hub's gate house ───────────────────────────────────────────

function gateway(accent: string): BuildingModel {
  const FH = 1.5
  const stone = flat(P.gatewayStone)
  const gold = flat(P.gatewayAccent, { metalness: 0.2, roughness: 0.5 })
  const flags = [-4.2, 4.2].map((x) => {
    const pole = cyl(0.05, 0.05, 1.8, flat('#caa24a'), { x, y: 0, z: 0 }, 6)
    const flag = box(0.9, 0.55, 0.04, flat(accent), { x: x + 0.47, y: 1.2 })
    return group(pole, flag)
  })
  const base = group(
    box(10.4, 0.5, 4.2, flat('#c3b999')),
    // arch hall between the towers: piers, lintel with a gold band and a dark opening
    box(1.4, 3.0, 3.6, stone, { x: -2.5, y: 0.5 }),
    box(1.4, 3.0, 3.6, stone, { x: 2.5, y: 0.5 }),
    box(6.4, 1.1, 3.6, stone, { y: 2.4 }),
    box(6.6, 0.22, 3.8, gold, { y: 3.5 }),
    box(3.0, 2.0, 3.2, flat('#26303c', { roughness: 0.4 }), { y: 0.5, z: -0.1 }),
    cyl(1.5, 1.5, 3.2, flat('#26303c', { roughness: 0.4 }), { y: 2.5, rx: Math.PI / 2, z: -0.1 }, 16),
  )
  base.children[base.children.length - 1].scale.set(1, 1, 0.34)
  const sign = canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = '#26303c'; ctx.fillRect(0, 0, 512, 96)
    ctx.fillStyle = '#f5d98c'; ctx.font = '700 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('API GATEWAY', 256, 50)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.86), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 2.95, 1.83)
  base.add(signMesh, ...flags)
  const roof = group(box(2.1, 0.2, 2.1, gold), box(1.5, 0.5, 1.5, stone, { y: 0.2 }), at(mast(1.2), 0, 0.7, 0))
  return {
    base,
    baseHeight: 0.5,
    floorHeight: FH,
    // The towers rise on the sides of the arch, so a floor is the same slice on both of them.
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.gatewayStone, cols: 3, rows: 1, winW: 0.5, winH: 0.55 })
      const f = group(box(2.4, FH, 3.6, material, { x: -4.0 }), box(2.4, FH, 3.6, material, { x: 4.0 }))
      return { object: f, uniforms }
    },
    roof: group(
      at(group(box(2.8, 0.2, 3.9, gold), cone(1.9, 1.2, flat('#7a5c2e'), { y: 0.2, ry: Math.PI / 4 })), -4.0, 0, 0),
      at(group(box(2.8, 0.2, 3.9, gold), cone(1.9, 1.2, flat('#7a5c2e'), { y: 0.2, ry: Math.PI / 4 })), 4.0, 0, 0),
      at(roof, 0, -1.2, 0),
    ),
    beaconAt: v(0, 0.2, 0),
    door: v(0, 0, 2.6),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-2.5, 0.65, 1.82), width: 1.2 },
    radius: 6,
  }
}

// ── Broker: the port, a warehouse on a jetty with a crane ───────────────────

function port(): BuildingModel {
  const FH = 1.35
  const boxColors = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a', '#e0573f', '#8e6bd9']
  const dock = group(
    box(6.6, 0.3, 12.5, flat(palette.wood), { y: 0, z: 8.5 }),
    ...[-3, 3].map((x) => box(0.3, 1.0, 12.5, flat(palette.woodDark), { x, y: -0.7, z: 8.5 })),
  )
  for (let i = 0; i < 6; i++) {
    dock.add(box(1.5, 1.0, 2.4, flat(boxColors[i]), { x: i % 2 ? 1.9 : -1.9, y: 0.3, z: 5.2 + Math.floor(i / 2) * 2.8 }))
  }
  const crane = group(
    box(0.5, 4.4, 0.5, flat('#e0733f')),
    box(0.4, 0.4, 4.6, flat('#e0733f'), { y: 4.2, z: 1.6 }),
    box(0.1, 1.6, 0.1, flat('#333a44'), { y: 2.6, z: 3.5 }),
    box(0.7, 0.5, 0.9, flat('#f2b632'), { y: 2.2, z: 3.5 }),
  )
  crane.position.set(0, 0.3, 9.5)
  const base = group(box(8.2, 0.4, 5.4, flat('#b9b2a4')), dock, door(1.5, 1.05, -2.67, '#1d2733'))
  base.children[2].position.y = 0.4
  const roof = group(box(7.6, 0.16, 4.8, flat(P.brokerRoof)), box(7.2, 0.5, 0.2, flat(P.brokerRoof), { y: 0.1, z: 0, rx: 0.5 }), at(mast(1.1), 0, 0.1, 0))
  const sign = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = '#f4efe2'; ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = '#26364f'; ctx.font = '700 36px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('SERVICE BUS', 128, 34)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 1.5, 2.72)
  base.add(signMesh, crane)
  return {
    base,
    baseHeight: 0.4,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.brokerWall, cols: 6, rows: 1, winW: 0.5, winH: 0.4 })
      return { object: box(7.6, FH, 4.8, material), uniforms }
    },
    roof,
    beaconAt: v(0, 1.2, 0),
    door: v(0, 0, -3.5),
    doorDir: v(0, 0, -1),
    plaque: { position: v(-3.0, 0.55, -2.72), width: 1.4, rotY: Math.PI },
    radius: 4.5,
    animate: (time) => {
      crane.rotation.y = Math.sin(time * 0.25) * 0.5
    },
  }
}

// ── Egress: tower with a satellite dish ─────────────────────────────────────

function egress(accent: string): BuildingModel {
  const FH = 1.4
  const base = group(box(4.2, 0.9, 4.0, flat('#d8d1c1')), door(1.1, 0.75, 2.01), awning(1.7, 0.9, 2.25, accent))
  const dishPivot = new THREE.Group()
  dishPivot.add(
    cyl(0.12, 0.12, 0.9, flat('#9aa3ad'), {}, 8),
    at(dome(1.0, flat(P.egressDish, { roughness: 0.4 })), 0, 0.9, 0),
    at(cyl(0.04, 0.04, 0.9, flat('#9aa3ad'), {}, 6), 0, 1.4, 0),
  )
  dishPivot.children[1].rotation.x = Math.PI * 0.72
  dishPivot.children[1].position.set(0, 1.35, 0)
  const roof = group(box(2.7, 0.2, 2.7, flat('#8d98a6')), at(dishPivot, 0.0, 0.2, 0.2), at(mast(1.1), 0.95, 0.2, -0.9))
  return {
    base,
    baseHeight: 0.9,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.egressBody, cols: 3, rows: 1, winW: 0.5, winH: 0.55 })
      return { object: box(2.5, FH, 2.5, material), uniforms }
    },
    roof,
    beaconAt: v(0.95, 1.3, -0.9),
    door: v(0, 0, 2.7),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.5, 0.45, 2.02), width: 1.3 },
    radius: 3,
    animate: (time) => {
      dishPivot.rotation.y = time * 0.25
    },
  }
}
