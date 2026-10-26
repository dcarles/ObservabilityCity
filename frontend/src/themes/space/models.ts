import * as THREE from 'three'
import type { NodeKind } from '../../types'
import type { BuildingModel } from '../../buildings/model'
import { at, box, canvasTexture, cone, cyl, dome, flat, group, sphere } from '../../buildings/mk'
import { makeWindowMaterial } from '../../buildings/windowMaterial'
import { palette } from '../active'
import { storageYard } from '../harbour-town/yard'
import { portSignText } from '../../portSign'
import { CELL, glow, mast, v } from '../common'

const P = palette.building
const HULL = '#e6eaf8'
const PLATE = '#9aa4cc'
const DARK = '#262b4a'
const CYAN = '#6fe7ff'

/** Builds the model for a building kind. The accent is the owning island's flag colour. */
export function spaceModel(kind: NodeKind, accent: string, opts: { tenanted?: boolean; name?: string } = {}): BuildingModel {
  if (kind === 'Database' && opts.tenanted) return storageYard(accent)
  switch (kind) {
    case 'Api': return habitat(accent)
    case 'Worker': return fabricator(accent)
    case 'Database': return vault(accent)
    case 'Cache': return fusionSphere()
    case 'Cron': return chronoSpire()
    case 'Gateway': return dockingGate(accent)
    case 'Broker': return spaceport(opts.name)
    case 'Egress': return relayStation(accent)
  }
}

/** A platform the building stands on, with a glowing edge. */
const pad = (r: number, y = 0) => group(cyl(r, r + 0.15, 0.26, flat(DARK, { metalness: 0.3 }), { y }, 24), cyl(r + 0.02, r + 0.02, 0.05, glow(CYAN), { y: y + 0.26 }, 24))

/** An airlock door: a dark opening in a glowing frame. */
const airlock = (w: number, h: number, z: number, color = CYAN) => group(
  box(w + 0.3, h + 0.15, 0.12, glow(color), { z }),
  box(w, h, 0.18, flat('#10132a', { roughness: 0.4 }), { z: z + 0.02 }),
)

function habitat(accent: string): BuildingModel {
  const W = 4 * CELL, D = 4 * CELL, FH = 1.6
  const base = group(
    pad(3.9),
    box(W + 0.2, 1.7, D + 0.2, flat(HULL, { metalness: 0.2 }), { y: 0.26 }),
    box(W + 0.34, 0.14, D + 0.34, flat(accent), { y: 1.96 }),
    airlock(1.0, 1.3, D / 2 + 0.12),
    box(1.8, 0.1, 0.9, flat(accent), { y: 1.55, z: D / 2 + 0.55 }),
    box(W + 1.6, 0.06, 1.6, flat(PLATE), { y: 0.26, z: D / 2 + 0.9 }),
  )
  const roof = group(
    cyl(W / 2 + 0.1, W / 2 + 0.1, 0.14, flat(PLATE), {}, 20),
    dome(1.7, flat('#bfe9ff', { roughness: 0.15, metalness: 0.4 }), { y: 0.14 }),
    at(mast(1.5), 0.8, 0.14, 0.5),
  )
  return {
    base,
    baseHeight: 2.1,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#cfd6f2', trim: '#f4f6ff', floorHeight: FH, width: W, depth: D, cell: CELL })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(0.8, 1.7, 0.5),
    door: v(0, 0, D / 2 + 1.7),
    doorDir: v(0, 0, 1),
    plaque: { position: v(W / 2 - 0.6, 0.6, D / 2 + 0.25), width: 1.5 },
    radius: 3.4,
  }
}

function fabricator(accent: string): BuildingModel {
  const W = 5 * CELL, D = 4 * CELL, FH = 1.6
  let activity = 0.4
  const plasma: THREE.Mesh[] = []
  for (let i = 0; i < 8; i++) {
    plasma.push(new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: '#7be3ff', transparent: true, opacity: 0.7, toneMapped: false, depthWrite: false })))
  }
  const STACKS = [{ x: 1.9, h: 3.0 }, { x: 1.0, h: 2.3 }]
  const stack = (x: number, h: number) => group(
    cyl(0.4, 0.5, h, flat('#4a5388', { metalness: 0.3 }), { x, y: 0.14, z: -1.4 }, 12),
    cyl(0.52, 0.52, 0.12, glow(CYAN), { x, y: 0.14 + h * 0.55, z: -1.4 }, 12),
    cyl(0.5, 0.5, 0.14, flat(PLATE), { x, y: 0.14 + h, z: -1.4 }, 12),
  )
  const shutter = (x: number) => group(
    box(1.5, 1.4, 0.14, flat('#3a4170', { roughness: 0.5, metalness: 0.4 }), { x, z: D / 2 + 0.1 }),
    ...[0.3, 0.6, 0.9, 1.2].map((y) => box(1.4, 0.03, 0.04, glow(accent), { x, y, z: D / 2 + 0.2 })),
  )
  const base = group(
    pad(4.4),
    box(W + 0.2, 1.7, D + 0.2, flat('#4d5798', { metalness: 0.25 }), { y: 0.26 }),
    box(W + 0.34, 0.14, D + 0.34, flat(PLATE), { y: 1.96 }),
    shutter(-1.7), shutter(-0.1),
    airlock(0.8, 1.25, D / 2 + 0.12, '#ffb830'),
    box(W + 1.6, 0.06, 1.8, flat(PLATE), { y: 0.26, z: D / 2 + 1.0 }),
  )
  const roof = group(
    box(W + 0.2, 0.14, D + 0.2, flat(P.workerRoof)),
    ...STACKS.map((c) => stack(c.x, c.h)),
    box(3.4, 0.9, 0.16, flat(accent), { x: -0.6, y: 0.14, z: D / 2 - 0.5 }),
    cyl(0.5, 0.5, 0.5, flat(PLATE), { x: -1.2, y: 0.14, z: -0.2 }, 14),
    at(mast(1.5), 2.2, 0.14, 1.3),
    ...plasma,
  )
  return {
    base,
    baseHeight: 2.1,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#7684d8', trim: '#d6dcff', floorHeight: FH, width: W, depth: D, cell: CELL })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(2.2, 1.7, 1.3),
    door: v(0, 0, D / 2 + 1.7),
    doorDir: v(0, 0, 1),
    plaque: { position: v(W / 2 - 0.7, 0.6, D / 2 + 0.25), width: 1.5 },
    radius: 3.8,
    // the plasma plume thickens with CPU, as the chimney smoke does in the harbour town
    setActivity: (level) => { activity = level },
    animate: (time) => {
      const rate = 0.25 + 0.5 * activity
      plasma.forEach((p, i) => {
        const c = STACKS[i % 2]
        const life = (time * rate + i / plasma.length) % 1
        p.position.set(c.x + Math.sin(i * 2.1 + time * 0.4) * 0.15 * life, 0.14 + c.h + 0.3 + life * 3.0, -1.4)
        p.scale.setScalar((0.35 + life * 1.1) * (0.6 + 0.8 * activity))
        ;(p.material as THREE.MeshBasicMaterial).opacity = (0.3 + 0.5 * activity) * (1 - life)
      })
    },
  }
}

function vault(accent: string): BuildingModel {
  const W = 5 * CELL, D = 4 * CELL, FH = 1.95
  const sign = canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = accent; ctx.fillRect(0, 0, 512, 128)
    ctx.fillStyle = '#ffffff'; ctx.font = '800 72px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('DATA VAULT', 256, 68)
  })
  const base = group(
    pad(4.3),
    box(W + 0.2, 0.5, D + 0.2, flat('#4a5385', { metalness: 0.3 }), { y: 0.26 }),
    airlock(1.0, 1.3, D / 2 + 0.12),
    box(W + 1.6, 0.06, 1.8, flat(PLATE), { y: 0.26, z: D / 2 + 1.0 }),
  )
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }))
  board.position.set(0, 0.8, D / 2 - 0.41)
  const roof = group(
    box(W + 0.2, 0.14, D + 0.2, flat('#cfd6ee')),
    // a row of cooling drums, each with a ring of light
    ...[-1.6, -0.5, 0.6, 1.7].map((x) => group(cyl(0.38, 0.38, 0.9, flat('#e8ecfa', { metalness: 0.2 }), { x, y: 0.14, z: -0.4 }, 14), cyl(0.4, 0.4, 0.07, glow(CYAN), { x, y: 0.7, z: -0.4 }, 14))),
    box(3.8, 1.1, 0.16, flat(accent), { y: 0.14, z: D / 2 - 0.5 }),
    board,
    at(mast(1.2), 2.2, 0.14, -0.8),
  )
  return {
    base,
    baseHeight: 0.78,
    floorHeight: FH,
    fixedFloors: 2,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#a9b8e6', trim: '#eef2ff', floorHeight: FH, width: W, depth: D, cell: CELL, win: [0.95, 1.6] })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(2.2, 1.34, -0.8),
    door: v(0, 0, D / 2 + 1.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-W / 2 + 0.9, 0.55, D / 2 + 0.25), width: 1.5 },
    radius: 3.7,
  }
}

function fusionSphere(): BuildingModel {
  const FH = 1.05
  const legMat = flat(P.cacheLegs, { metalness: 0.4, roughness: 0.5 })
  const base = group(pad(2.6))
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const leg = cyl(0.09, 0.09, 3.1, legMat, { x: x * 1.2, z: z * 1.2, rx: z * -0.2, rz: x * 0.2 }, 6)
    leg.position.y = 0.26
    base.add(leg)
  }
  base.add(cyl(1.3, 1.3, 0.08, glow(CYAN), { y: 1.5 }, 20))
  const shed = group(box(1.2, 0.9, 1.0, flat(HULL)), box(1.3, 0.1, 1.1, flat(PLATE), { y: 0.9 }), box(0.45, 0.62, 0.06, flat('#10132a'), { z: 0.52 }))
  shed.position.set(0, 0.26, 1.9)
  base.add(shed)
  const roof = group(dome(1.5, flat('#ffcf7a', { roughness: 0.3, metalness: 0.3 })), sphere(0.12, glow('#ffcf7a'), { y: 1.5 }, 8), at(mast(1.1), 0, 1.5, 0))
  return {
    base,
    baseHeight: 3.4,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cacheTank, trim: '#b5762a', floorHeight: FH, radial: 10, win: [0.34, 0.4], roughness: 0.45 })
      const f = group(cyl(1.38, 1.38, FH, material, {}, 20), cyl(1.43, 1.43, 0.09, flat('#b5762a'), {}, 20), cyl(1.43, 1.43, 0.09, flat('#b5762a'), { y: FH - 0.09 }, 20))
      return { object: f, uniforms }
    },
    roof,
    beaconAt: v(0, 2.2, 0),
    door: v(0, 0, 2.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.0, 0.55, 2.42), width: 1.25 },
    radius: 2.6,
  }
}

function chronoSpire(): BuildingModel {
  const FH = 1.5
  const W = 2 * CELL
  const rings = [0, 1].map((i) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15 - i * 0.3, 0.06, 6, 28), glow(i ? '#a98bff' : CYAN))
    ring.rotation.x = Math.PI / 2
    return ring
  })
  const ringGroup = group(...rings)
  ringGroup.position.set(0, 1.0, 0)
  const base = group(
    pad(1.9),
    box(W + 0.4, 0.6, W + 0.4, flat(PLATE), { y: 0.26 }),
    box(W, 2.0, W, flat(P.cronStone, { metalness: 0.2 }), { y: 0.86 }),
    airlock(0.8, 1.1, W / 2 + 0.12),
    box(2.2, 0.06, 1.4, flat(PLATE), { y: 0.26, z: W / 2 + 0.9 }),
  )
  const roof = group(
    box(2.0, 1.6, 2.0, flat(P.cronStone, { metalness: 0.2 })),
    cone(1.5, 2.2, flat(P.cronRoof, { metalness: 0.3 }), { y: 1.6, ry: Math.PI / 4 }, 4),
    ringGroup,
    at(mast(1.0), 0, 3.8, 0),
  )
  return {
    base,
    baseHeight: 3.1,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cronStone, trim: '#f1f3ff', floorHeight: FH, width: W, depth: W, cell: CELL, win: [0.5, 0.8] })
      return { object: box(W - 0.2, FH, W - 0.2, material), uniforms }
    },
    roof,
    beaconAt: v(0, 4.8, 0),
    door: v(0, 0, W / 2 + 1.5),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.0, 0.55, 1.51), width: 1.2 },
    radius: 2.3,
    animate: (time) => {
      rings[0].rotation.z = time * 0.8
      rings[1].rotation.z = -time * 1.3
      ringGroup.position.y = 1.0 + Math.sin(time * 0.9) * 0.12
    },
  }
}

function dockingGate(accent: string): BuildingModel {
  const FH = 1.6
  const hull = flat(P.gatewayStone, { metalness: 0.2 })
  const base = group(
    box(10.4, 0.4, 4.2, flat(PLATE, { metalness: 0.3 })),
    box(1.4, 3.0, 3.6, hull, { x: -2.5, y: 0.4 }),
    box(1.4, 3.0, 3.6, hull, { x: 2.5, y: 0.4 }),
    box(6.4, 1.0, 3.6, hull, { y: 2.4 }),
    box(6.6, 0.18, 3.8, glow(P.gatewayAccent), { y: 3.4 }),
    // the energy field across the opening, which the road runs through
    box(3.6, 1.9, 0.04, new THREE.MeshBasicMaterial({ color: '#6fe7ff', transparent: true, opacity: 0.18, toneMapped: false, depthWrite: false }), { y: 0.4, z: 0 }),
  )
  const sign = canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = '#10132a'; ctx.fillRect(0, 0, 512, 96)
    ctx.fillStyle = '#9af0ff'; ctx.font = '700 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('API GATEWAY', 256, 50)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.86), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 2.9, 1.86)
  const flags = [-4.2, 4.2].map((x) => group(cyl(0.05, 0.05, 1.8, flat(PLATE), { x }, 6), box(0.9, 0.55, 0.04, glow(accent), { x: x + 0.47, y: 1.2 })))
  base.add(signMesh, ...flags)
  const tower = () => group(box(2.8, 0.2, 3.9, flat(PLATE)), cone(1.9, 1.3, flat('#59618f', { metalness: 0.3 }), { y: 0.2, ry: Math.PI / 4 }))
  const dish = group(cyl(0.12, 0.12, 0.7, flat(PLATE), {}, 8), dome(0.8, flat(HULL, { roughness: 0.4 }), { y: 0.7 }))
  return {
    base,
    baseHeight: 0.4,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.gatewayStone, trim: '#f4f6ff', floorHeight: FH, width: 2 * CELL, depth: 3 * CELL, cell: CELL })
      return { object: group(box(2.4, FH, 3.6, material, { x: -4.0 }), box(2.4, FH, 3.6, material, { x: 4.0 })), uniforms }
    },
    roof: group(at(tower(), -4.0, 0, 0), at(tower(), 4.0, 0, 0), at(dish, 0, -1.2, 0)),
    beaconAt: v(0, 0.2, 0),
    door: v(0, 0, 2.6),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-2.5, 0.65, 1.82), width: 1.2 },
    radius: 6,
  }
}

function spaceport(name?: string): BuildingModel {
  const FH = 1.5
  const W = 6 * CELL, D = 4 * CELL
  const pods = ['#ff7a59', '#59b0ff', '#ffd45e', '#59e3a0', '#ff7a59', '#b08cff']
  const dock = group(
    box(6.6, 0.3, 12.5, flat(PLATE, { metalness: 0.3 }), { z: 8.5 }),
    ...[-3, 3].map((x) => box(0.16, 0.12, 12.5, glow(CYAN), { x, y: 0.3, z: 8.5 })),
  )
  for (let i = 0; i < 6; i++) dock.add(box(1.5, 1.0, 2.4, flat(pods[i], { metalness: 0.2 }), { x: i % 2 ? 1.9 : -1.9, y: 0.3, z: 5.2 + Math.floor(i / 2) * 2.8 }))
  // a loading arm that swings out over the pad
  const arm = group(
    box(0.5, 4.4, 0.5, flat('#e0733f', { metalness: 0.3 })),
    box(0.4, 0.4, 4.6, flat('#e0733f', { metalness: 0.3 }), { y: 4.2, z: 1.6 }),
    box(0.1, 1.6, 0.1, flat('#d6dcff'), { y: 2.6, z: 3.5 }),
    sphere(0.4, glow('#ffd45e'), { y: 2.2, z: 3.5 }, 10),
  )
  arm.position.set(0, 0.3, 9.5)
  dock.position.y = 0.4
  const base = group(
    box(W + 1.0, 0.4, D + 0.6, flat(PLATE, { metalness: 0.3 })),
    dock,
    box(1.5, 1.05, 0.14, flat('#10132a', { roughness: 0.4 }), { y: 0.4, z: -(D / 2 + 0.3) }),
  )
  const sign = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = '#10132a'; ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = '#9af0ff'; ctx.font = '700 36px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(portSignText(name), 128, 34, 240)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 1.5, D / 2 + 0.35)
  base.add(signMesh, arm)
  const roof = group(
    cone(Math.max(W, D) * 0.62, 1.1, flat(P.brokerRoof, { metalness: 0.3 }), { ry: Math.PI / 4 }, 4),
    at(mast(1.1), 0, 1.0, 0),
  )
  return {
    base,
    baseHeight: 0.4,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.brokerWall, trim: '#c9d2ff', floorHeight: FH, width: W, depth: D, cell: CELL, win: [0.6, 0.7] })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(0, 1.6, 0),
    door: v(0, 0, -(D / 2 + 1.2)),
    doorDir: v(0, 0, -1),
    plaque: { position: v(-3.0, 0.55, -(D / 2 + 0.35)), width: 1.4, rotY: Math.PI },
    radius: 4.5,
    signText: portSignText(name),
    animate: (time) => { arm.rotation.y = Math.sin(time * 0.25) * 0.5 },
  }
}

function relayStation(accent: string): BuildingModel {
  const FH = 1.5
  const W = 2 * CELL
  const base = group(
    pad(2.9),
    box(4.2, 0.9, 4.0, flat('#c3caea', { metalness: 0.2 }), { y: 0.26 }),
    airlock(1.1, 0.75, 2.12),
    box(1.7, 0.1, 0.8, flat(accent), { y: 1.0, z: 2.5 }),
    box(3.6, 0.06, 1.4, flat(PLATE), { y: 0.26, z: 2.7 }),
  )
  const dishPivot = new THREE.Group()
  const bowl = dome(1.1, flat(P.egressDish, { roughness: 0.35, metalness: 0.3 }))
  bowl.rotation.x = Math.PI * 0.72
  bowl.position.set(0, 1.35, 0)
  dishPivot.add(cyl(0.12, 0.12, 0.9, flat(PLATE), {}, 8), bowl, at(cyl(0.04, 0.04, 0.9, flat(PLATE), {}, 6), 0, 1.4, 0), sphere(0.1, glow('#ff5e7a'), { y: 2.3 }, 8))
  const roof = group(box(W + 0.3, 0.2, W + 0.3, flat(PLATE)), at(dishPivot, 0, 0.2, 0.2), at(mast(1.1), 0.95, 0.2, -0.9))
  return {
    base,
    baseHeight: 1.16,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.egressBody, trim: '#f7f8ff', floorHeight: FH, width: W, depth: W, cell: CELL, win: [0.6, 0.8] })
      return { object: box(W, FH, W, material), uniforms }
    },
    roof,
    beaconAt: v(0.95, 1.3, -0.9),
    door: v(0, 0, 3.4),
    doorDir: v(0, 0, 1),
    plaque: { position: v(1.5, 0.7, 2.02), width: 1.3 },
    radius: 3,
    animate: (time) => { dishPivot.rotation.y = time * 0.25 },
  }
}
