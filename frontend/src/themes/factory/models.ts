import * as THREE from 'three'
import type { NodeKind } from '../../types'
import type { BuildingModel } from '../../buildings/model'
import { at, box, canvasTexture, cone, cyl, dome, flat, group } from '../../buildings/mk'
import { makeWindowMaterial } from '../../buildings/windowMaterial'
import { palette } from '../active'
import { storageYard } from '../harbour-town/yard'
import { portSignText } from '../../portSign'
import { CELL, glow, mast, v } from '../common'

const P = palette.building
const STEEL = '#8b929b'
const YELLOW = '#f2c230'
const BLACK = '#23272d'

/** Builds the model for a building kind. The accent is the owning island's flag colour. */
export function factoryModel(kind: NodeKind, accent: string, opts: { tenanted?: boolean; name?: string } = {}): BuildingModel {
  if (kind === 'Database' && opts.tenanted) return storageYard(accent)
  switch (kind) {
    case 'Api': return officeBlock(accent)
    case 'Worker': return productionHall(accent)
    case 'Database': return warehouse(accent)
    case 'Cache': return pressureTank()
    case 'Cron': return timerTower()
    case 'Gateway': return gatehouse(accent)
    case 'Broker': return freightDepot(opts.name)
    case 'Egress': return radioMast(accent)
  }
}

const hazard = (() => {
  let t: THREE.CanvasTexture | null = null
  return () => (t ??= canvasTexture(256, 16, (ctx) => {
    for (let i = 0; i < 16; i++) { ctx.fillStyle = i % 2 ? BLACK : YELLOW; ctx.beginPath(); ctx.moveTo(i * 16, 16); ctx.lineTo(i * 16 + 8, 0); ctx.lineTo(i * 16 + 24, 0); ctx.lineTo(i * 16 + 16, 16); ctx.fill() }
  }))
})()
const hazardStrip = (w: number, y: number, z: number) => box(w, 0.2, 0.02, new THREE.MeshStandardMaterial({ map: hazard(), roughness: 0.9 }), { y, z })
const rollerDoor = (w: number, h: number, x: number, z: number, color = '#b8bfc7') => group(
  box(w, h, 0.14, flat(color, { roughness: 0.5, metalness: 0.2 }), { x, z }),
  ...[0.25, 0.5, 0.75, 1.0, 1.25].filter((y) => y < h).map((y) => box(w - 0.1, 0.03, 0.04, flat('#7c848e'), { x, y, z: z + 0.1 })),
  box(w + 0.2, 0.12, 0.2, flat(YELLOW), { x, y: h, z }),
)
const apron = (w: number, d: number, z: number) => box(w, 0.08, d, flat('#aaa79b'), { z })

function officeBlock(accent: string): BuildingModel {
  const W = 4 * CELL, D = 4 * CELL, FH = 1.6
  const base = group(
    box(W + 0.2, 1.7, D + 0.2, flat('#9ea6ad')),
    box(W + 0.34, 0.16, D + 0.34, flat(accent), { y: 1.7 }),
    box(1.0, 1.3, 0.14, flat('#2f3a46', { roughness: 0.4 }), { z: D / 2 + 0.1 }),
    box(2.0, 0.1, 0.9, flat(YELLOW), { y: 1.4, z: D / 2 + 0.55 }),
    ...[-1.7, 1.7].map((x) => box(1.3, 0.8, 0.1, flat('#5b86a8', { roughness: 0.25 }), { x, y: 0.5, z: D / 2 + 0.1 })),
    apron(W + 1.6, 1.6, D / 2 + 0.9),
  )
  const cabin = group(box(1.8, 0.9, 1.4, flat('#cfd6dc')), box(1.9, 0.1, 1.5, flat(STEEL), { y: 0.9 }), box(1.4, 0.4, 0.04, flat('#5b86a8', { roughness: 0.2 }), { y: 0.35, z: 0.71 }))
  const unit = (x: number, z: number) => group(box(1.1, 0.5, 0.9, flat('#d4d9de'), { x, y: 0.14, z }), cyl(0.32, 0.32, 0.06, flat('#8a949f'), { x, y: 0.64, z }, 14))
  const roof = group(box(W + 0.3, 0.14, D + 0.3, flat('#7d858d')), at(cabin, -0.9, 0.14, -0.6), unit(1.2, 0.5), unit(1.4, -1.0), at(mast(1.6), 0.8, 0.14, 0.9))
  return {
    base,
    baseHeight: 1.86,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#b6bec6', trim: '#e8ecef', floorHeight: FH, width: W, depth: D, cell: CELL })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(0.8, 1.9, 0.9),
    door: v(0, 0, D / 2 + 1.6),
    doorDir: v(0, 0, 1),
    plaque: { position: v(W / 2 - 0.6, 0.55, D / 2 + 0.25), width: 1.5 },
    radius: 3.2,
  }
}

function productionHall(accent: string): BuildingModel {
  const W = 5 * CELL, D = 4 * CELL, FH = 1.6
  let activity = 0.4
  const smoke: THREE.Mesh[] = []
  for (let i = 0; i < 8; i++) smoke.push(new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), new THREE.MeshStandardMaterial({ color: '#e9e9e6', transparent: true, opacity: 0.8, roughness: 1, flatShading: true })))
  const STACKS = [{ x: 1.9, h: 3.8 }, { x: 1.0, h: 2.9 }]
  const stack = (x: number, h: number) => group(
    cyl(0.34, 0.46, h, flat('#9a4a36'), { x, y: 0.14, z: -1.4 }, 10),
    cyl(0.42, 0.42, 0.14, flat('#e9e3d2'), { x, y: 0.14 + h - 0.4, z: -1.4 }, 10),
    cyl(0.46, 0.46, 0.14, flat('#e9e3d2'), { x, y: 0.14 + h, z: -1.4 }, 10),
  )
  const base = group(
    box(W + 0.2, 1.7, D + 0.2, flat('#b5573d')),
    box(W + 0.34, 0.14, D + 0.34, flat('#e8e2d0'), { y: 1.7 }),
    hazardStrip(W + 0.22, 0.05, D / 2 + 0.11),
    rollerDoor(1.5, 1.4, -1.7, D / 2 + 0.1), rollerDoor(1.5, 1.4, -0.1, D / 2 + 0.1),
    box(0.8, 1.25, 0.14, flat('#2f3a46', { roughness: 0.4 }), { x: 1.8, z: D / 2 + 0.1 }),
    box(1.1, 0.1, 0.8, flat(accent), { x: 1.8, y: 1.3, z: D / 2 + 0.5 }),
    apron(W + 1.6, 1.8, D / 2 + 1.0),
  )
  // a sawtooth roof: a row of slanted skylights
  const saw = (z: number) => group(box(W - 0.6, 0.9, 0.08, flat('#6c7a86'), { y: 0.14, z }), box(W - 0.6, 0.5, 0.06, flat('#9cc3d9', { roughness: 0.2 }), { y: 0.34, z: z + 0.12, rx: -0.5 }))
  const roof = group(
    box(W + 0.3, 0.14, D + 0.3, flat('#7d858d')),
    saw(0.6), saw(-0.2),
    ...STACKS.map((c) => stack(c.x, c.h)),
    box(3.2, 1.1, 0.16, flat(accent), { x: -0.8, y: 0.14, z: D / 2 - 0.5 }),
    at(mast(1.5), 2.2, 0.14, 1.3),
    ...smoke,
  )
  return {
    base,
    baseHeight: 1.84,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#c8704f', trim: '#e8e2d0', floorHeight: FH, width: W, depth: D, brick: true, cell: CELL })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(2.2, 1.9, 1.3),
    door: v(0, 0, D / 2 + 1.7),
    doorDir: v(0, 0, 1),
    plaque: { position: v(W / 2 - 0.7, 0.55, D / 2 + 0.25), width: 1.5 },
    radius: 3.6,
    setActivity: (level) => { activity = level },
    animate: (time) => {
      const rate = 0.25 + 0.5 * activity
      smoke.forEach((p, i) => {
        const c = STACKS[i % 2]
        const life = (time * rate + i / smoke.length) % 1
        p.position.set(c.x + Math.sin(i * 2.1 + time * 0.4) * 0.15 * life, 0.14 + c.h + 0.3 + life * 3.0, -1.4)
        p.scale.setScalar((0.4 + life * 1.3) * (0.6 + 0.8 * activity))
        ;(p.material as THREE.MeshStandardMaterial).opacity = (0.35 + 0.55 * activity) * (1 - life)
      })
    },
  }
}

function warehouse(accent: string): BuildingModel {
  const W = 5 * CELL, D = 4 * CELL, FH = 1.95
  const sign = canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = accent; ctx.fillRect(0, 0, 512, 128)
    ctx.fillStyle = '#ffffff'; ctx.font = '800 72px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('WAREHOUSE', 256, 68)
  })
  const base = group(
    box(W + 0.2, 0.5, D + 0.2, flat('#5f7a94')),
    ...[-1.9, -0.6, 0.7].map((x) => rollerDoor(1.1, 1.1, x, D / 2 + 0.1, '#cfd5db')),
    box(0.9, 1.3, 0.14, flat('#2f3a46', { roughness: 0.4 }), { x: W / 2 - 1.0, y: 0.5, z: D / 2 + 0.1 }),
    box(1.5, 0.12, 0.8, flat(YELLOW), { x: W / 2 - 1.0, y: 1.9, z: D / 2 + 0.4 }),
    apron(W + 1.6, 1.8, D / 2 + 1.0),
  )
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }))
  board.position.set(0, 0.8, D / 2 - 0.41)
  const roof = group(
    box(W + 0.3, 0.14, D + 0.3, flat('#7d858d')),
    // a shallow corrugated roof ridge with a row of skylights
    box(W - 0.4, 0.5, D - 0.4, flat('#a7b0b8'), { y: 0.14 }),
    ...[-1.6, 0, 1.6].map((x) => box(0.9, 0.12, 1.4, flat('#9cc3d9', { roughness: 0.2 }), { x, y: 0.64 })),
    box(3.8, 1.1, 0.16, flat(accent), { y: 0.14, z: D / 2 - 0.5 }),
    board,
    at(mast(1.2), 2.2, 0.14, -0.8),
  )
  return {
    base,
    baseHeight: 0.58,
    floorHeight: FH,
    fixedFloors: 2,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#7f9bb4', trim: '#e8eef2', floorHeight: FH, width: W, depth: D, cell: CELL, win: [0.95, 1.6] })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(2.2, 1.34, -0.8),
    door: v(0, 0, D / 2 + 1.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-W / 2 + 0.9, 0.5, D / 2 + 0.25), width: 1.5 },
    radius: 3.7,
  }
}

function pressureTank(): BuildingModel {
  const FH = 1.05
  const leg = flat(P.cacheLegs, { metalness: 0.4 })
  const base = group(box(3.4, 0.18, 3.4, flat('#a9a699')))
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) base.add(cyl(0.1, 0.1, 3.1, leg, { x: x * 1.15, y: 0.1, z: z * 1.15 }, 6))
  base.add(box(2.3, 0.07, 0.07, leg, { y: 1.3, z: 1.1 }), box(2.3, 0.07, 0.07, leg, { y: 1.3, z: -1.1 }), box(0.07, 0.07, 2.3, leg, { y: 1.3, x: 1.1 }), box(0.07, 0.07, 2.3, leg, { y: 1.3, x: -1.1 }))
  // a ladder up the side and a pipe to the pump house
  for (let i = 0; i < 9; i++) base.add(box(0.5, 0.04, 0.04, flat(STEEL), { x: 1.45, y: 0.3 + i * 0.32, z: 0 }))
  base.add(box(0.05, 3.0, 0.05, flat(STEEL), { x: 1.22, y: 0.1 }), box(0.05, 3.0, 0.05, flat(STEEL), { x: 1.68, y: 0.1 }))
  const shed = group(box(1.2, 0.9, 1.0, flat('#d4cfc0')), box(1.3, 0.1, 1.1, flat('#6c7a86'), { y: 0.9 }), box(0.45, 0.62, 0.06, flat('#2f3a46'), { z: 0.52 }))
  shed.position.set(0, 0.18, 1.9)
  base.add(shed, hazardStrip(1.2, 0.2, 2.45))
  const roof = group(dome(1.45, flat('#cfa41f', { metalness: 0.3, roughness: 0.5 })), cyl(0.12, 0.12, 0.6, flat(STEEL), { y: 1.3 }, 8), at(mast(1.0), 0.5, 1.2, 0))
  return {
    base,
    baseHeight: 3.2,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cacheTank, trim: '#8a6a12', floorHeight: FH, radial: 10, win: [0.3, 0.36], roughness: 0.5 })
      const f = group(cyl(1.38, 1.38, FH, material, {}, 20), cyl(1.43, 1.43, 0.09, flat('#8a6a12'), {}, 20), cyl(1.43, 1.43, 0.09, flat('#8a6a12'), { y: FH - 0.09 }, 20))
      return { object: f, uniforms }
    },
    roof,
    beaconAt: v(0, 2.0, 0),
    door: v(0, 0, 2.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.0, 0.5, 2.42), width: 1.25 },
    radius: 2.6,
  }
}

function timerTower(): BuildingModel {
  const FH = 1.5
  const W = 2 * CELL
  const concrete = flat(P.cronStone)
  const base = group(
    box(3.0, 0.6, 3.0, flat('#9a9689')),
    box(W, 2.4, W, concrete, { y: 0.6 }),
    box(0.8, 1.1, 0.12, flat('#2f3a46', { roughness: 0.5 }), { y: 0.6, z: W / 2 + 0.05 }),
    hazardStrip(W, 0.62, W / 2 + 0.07),
    box(2.2, 0.08, 1.4, flat('#aaa79b'), { z: W / 2 + 0.9 }),
  )
  const faceTex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#f4f1e6'; ctx.beginPath(); ctx.arc(128, 128, 120, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = BLACK; ctx.lineWidth = 12; ctx.stroke()
    ctx.lineWidth = 8
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      ctx.beginPath(); ctx.moveTo(128 + Math.cos(a) * 90, 128 + Math.sin(a) * 90); ctx.lineTo(128 + Math.cos(a) * 108, 128 + Math.sin(a) * 108); ctx.stroke()
    }
  })
  const faceMat = new THREE.MeshBasicMaterial({ map: faceTex })
  const hourHand = box(0.07, 0.34, 0.03, flat(BLACK)), minuteHand = box(0.05, 0.5, 0.03, flat(BLACK))
  const hands = group(hourHand, minuteHand)
  const roof = group(box(2.8, 1.9, 2.8, concrete))
  for (const [x, z, ry] of [[0, 1.41, 0], [0, -1.41, Math.PI], [1.41, 0, Math.PI / 2], [-1.41, 0, -Math.PI / 2]] as const) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.78, 24), faceMat)
    face.position.set(x, 0.95, z)
    face.rotation.y = ry
    roof.add(face)
  }
  hands.position.set(0, 0.95, 1.44)
  // a works siren on the top instead of a steeple
  roof.add(hands, box(3.0, 0.2, 3.0, flat(STEEL), { y: 1.9 }), cyl(0.5, 0.5, 0.6, flat(YELLOW), { y: 2.1 }, 12), cone(0.5, 0.5, flat(BLACK), { y: 2.7 }, 12), at(mast(1.0), 0, 3.2, 0))
  return {
    base,
    baseHeight: 3.0,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cronStone, trim: '#f0ece0', floorHeight: FH, width: W, depth: W, cell: CELL, win: [0.5, 0.8] })
      return { object: box(W - 0.2, FH, W - 0.2, material), uniforms }
    },
    roof,
    beaconAt: v(0, 4.2, 0),
    door: v(0, 0, W / 2 + 1.5),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.0, 0.5, 1.51), width: 1.2 },
    radius: 2.2,
    animate: (time) => {
      minuteHand.rotation.z = -time * 0.5
      hourHand.rotation.z = -time * 0.04
    },
  }
}

function gatehouse(accent: string): BuildingModel {
  const FH = 1.6
  const girder = flat(YELLOW, { metalness: 0.2 })
  const concrete = flat(P.gatewayStone)
  const barrier = group(box(4.4, 0.16, 0.16, new THREE.MeshStandardMaterial({ map: hazard(), roughness: 0.8 })), cyl(0.2, 0.2, 0.9, flat(STEEL), { x: -2.3 }, 8))
  barrier.position.set(-0.1, 1.0, 1.9)
  const base = group(
    box(10.4, 0.5, 4.2, flat('#a39f92')),
    box(1.4, 3.0, 3.6, concrete, { x: -2.5, y: 0.5 }),
    box(1.4, 3.0, 3.6, concrete, { x: 2.5, y: 0.5 }),
    // the steel portal between the posts
    box(6.4, 0.5, 3.6, girder, { y: 3.0 }),
    box(6.6, 0.18, 3.8, flat(STEEL), { y: 3.5 }),
    ...[-2.5, 2.5].map((x) => box(1.5, 0.16, 3.7, flat(accent), { x, y: 3.5 })),
    barrier,
  )
  const sign = canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = BLACK; ctx.fillRect(0, 0, 512, 96)
    ctx.fillStyle = YELLOW; ctx.font = '700 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('API GATEWAY', 256, 50)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.8), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 2.9, 1.86)
  base.add(signMesh)
  const lightbar = group(box(2.8, 0.2, 3.9, flat(STEEL)), box(0.5, 0.5, 0.5, glow('#ffb830'), { x: -0.8, y: 0.2 }), box(0.5, 0.5, 0.5, glow('#ffb830'), { x: 0.8, y: 0.2 }))
  return {
    base,
    baseHeight: 0.5,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.gatewayStone, trim: '#f6f2e4', floorHeight: FH, width: 2 * CELL, depth: 3 * CELL, cell: CELL })
      return { object: group(box(2.4, FH, 3.6, material, { x: -4.0 }), box(2.4, FH, 3.6, material, { x: 4.0 })), uniforms }
    },
    roof: group(at(lightbar, -4.0, 0, 0), at(lightbar.clone(), 4.0, 0, 0), at(group(box(2.1, 0.2, 2.1, flat(STEEL)), at(mast(1.2), 0, 0.2, 0)), 0, -1.2, 0)),
    beaconAt: v(0, 0.2, 0),
    door: v(0, 0, 2.6),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-2.5, 0.65, 1.82), width: 1.2 },
    radius: 6,
  }
}

function freightDepot(name?: string): BuildingModel {
  const FH = 1.5
  const W = 6 * CELL, D = 4 * CELL
  const colours = ['#d9573f', '#3f7fc9', '#e3a72c', '#4f9f6a', '#d9573f', '#7d6bb9']
  const dock = group(box(6.6, 0.3, 12.5, flat('#a39f92'), { z: 8.5 }), ...[-3, 3].map((x) => box(0.3, 0.1, 12.5, flat(YELLOW), { x, y: 0.3, z: 8.5 })))
  for (let i = 0; i < 6; i++) dock.add(box(1.5, 1.0, 2.4, flat(colours[i], { metalness: 0.2 }), { x: i % 2 ? 1.9 : -1.9, y: 0.3, z: 5.2 + Math.floor(i / 2) * 2.8 }))
  // a gantry crane that travels along the dock
  const crane = group(
    ...[-2.2, 2.2].map((x) => box(0.4, 4.6, 0.4, flat(YELLOW), { x })),
    box(5.0, 0.4, 0.5, flat(YELLOW), { y: 4.4 }),
    box(0.12, 1.6, 0.12, flat(BLACK), { y: 2.8, x: 0.6 }),
    box(0.7, 0.5, 0.9, flat('#d9573f'), { y: 2.3, x: 0.6 }),
  )
  crane.position.set(0, 0.3, 9.5)
  dock.position.y = 0.4
  const base = group(
    box(W + 1.0, 0.4, D + 0.6, flat('#a39f92')),
    dock,
    box(1.5, 1.05, 0.14, flat('#1d2733', { roughness: 0.4 }), { y: 0.4, z: -(D / 2 + 0.3) }),
    hazardStrip(W, 0.45, D / 2 + 0.31),
  )
  const sign = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = BLACK; ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = YELLOW; ctx.font = '700 36px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(portSignText(name), 128, 34, 240)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 1.5, D / 2 + 0.35)
  base.add(signMesh, crane)
  const roof = group(box(W, 0.9, D, flat(P.brokerRoof), { y: 0 }), ...[-2, 0, 2].map((x) => box(1.2, 0.3, D - 0.4, flat('#9cc3d9', { roughness: 0.2 }), { x, y: 0.9 })), at(mast(1.1), 0, 0.9, 0))
  return {
    base,
    baseHeight: 0.4,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.brokerWall, trim: '#e8ecef', floorHeight: FH, width: W, depth: D, cell: CELL, win: [0.6, 0.7] })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(0, 1.4, 0),
    door: v(0, 0, -(D / 2 + 1.2)),
    doorDir: v(0, 0, -1),
    plaque: { position: v(-3.0, 0.55, -(D / 2 + 0.35)), width: 1.4, rotY: Math.PI },
    radius: 4.5,
    signText: portSignText(name),
    animate: (time) => { crane.position.x = Math.sin(time * 0.25) * 1.4 },
  }
}

function radioMast(accent: string): BuildingModel {
  const FH = 1.5
  const W = 2 * CELL
  const base = group(
    box(4.2, 0.9, 4.0, flat('#c4c0b2')),
    box(1.1, 0.75, 0.12, flat('#2b3340', { roughness: 0.4 }), { z: 2.01 }),
    box(1.7, 0.1, 0.8, flat(accent), { y: 0.95, z: 2.4 }),
    box(3.6, 0.08, 1.4, flat('#aaa79b'), { z: 2.7 }),
  )
  // a lattice mast: four legs braced with rungs, and a dish and red lamp at the top
  const lattice = new THREE.Group()
  const leg = flat(STEEL, { metalness: 0.3 })
  for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]] as const) lattice.add(cyl(0.05, 0.06, 3.2, leg, { x, z }, 5))
  for (let i = 0; i < 6; i++) {
    const y = 0.3 + i * 0.5
    lattice.add(box(0.95, 0.04, 0.04, leg, { y, z: 0.45 }), box(0.95, 0.04, 0.04, leg, { y, z: -0.45 }), box(0.04, 0.04, 0.95, leg, { y, x: 0.45 }), box(0.04, 0.04, 0.95, leg, { y, x: -0.45 }))
  }
  const dishPivot = new THREE.Group()
  const bowl = dome(0.8, flat(P.egressDish, { roughness: 0.4 }))
  bowl.rotation.x = Math.PI * 0.72
  dishPivot.add(bowl)
  dishPivot.position.set(0, 3.0, 0)
  const roof = group(box(W + 0.3, 0.2, W + 0.3, flat('#7d858d')), at(lattice, 0, 0.2, 0), at(dishPivot, 0, 0.2, 0), at(mast(0.9), 0.95, 0.2, -0.9))
  return {
    base,
    baseHeight: 0.9,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.egressBody, trim: '#f1f3f4', floorHeight: FH, width: W, depth: W, cell: CELL, win: [0.6, 0.8] })
      return { object: box(W, FH, W, material), uniforms }
    },
    roof,
    beaconAt: v(0.95, 1.3, -0.9),
    door: v(0, 0, 3.4),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.5, 0.45, 2.02), width: 1.3 },
    radius: 3,
    animate: (time) => { dishPivot.rotation.y = time * 0.25 },
  }
}
