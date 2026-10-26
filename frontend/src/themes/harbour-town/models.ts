import * as THREE from 'three'
import type { NodeKind } from '../../types'
import type { BuildingModel } from '../../buildings/model'
import { at, box, canvasTexture, cone, cyl, dome, flat, group, sphere } from '../../buildings/mk'
import { makeWindowMaterial } from '../../buildings/windowMaterial'
import { kit } from '../../assets/kit'
import { palette } from '../active'
import { storageYard } from './yard'
import { portSignText } from '../../portSign'

const P = palette.building
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

// All widths are multiples of one window cell, so windows sit evenly on every face.
const CELL = 1.2

/** Builds the model for a building kind. The accent is the owning island's flag colour. */
export function harbourModel(kind: NodeKind, accent: string, opts: { tenanted?: boolean; name?: string } = {}): BuildingModel {
  // a data store with a database for each tenant stands as a yard of storage units
  if (kind === 'Database' && opts.tenanted) return storageYard(accent)
  switch (kind) {
    case 'Api': return townhouse(accent)
    case 'Worker': return factory(accent)
    case 'Database': return storage(accent)
    case 'Cache': return waterTower()
    case 'Cron': return clockTower()
    case 'Gateway': return gateway(accent)
    case 'Broker': return port(opts.name)
    case 'Egress': return egress(accent)
  }
}

// ── shared pieces ───────────────────────────────────────────────────────────

const stripeCache = new Map<string, THREE.MeshStandardMaterial>()

/** Striped shop awning in the island's colour. */
function awning(w: number, y: number, z: number, color: string): THREE.Mesh {
  let mat = stripeCache.get(color)
  if (!mat) {
    const tex = canvasTexture(128, 32, (ctx) => {
      for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? '#fbf6ea' : color; ctx.fillRect(i * 16, 0, 16, 32) }
    })
    tex.wrapS = THREE.RepeatWrapping
    mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, flatShading: true })
    stripeCache.set(color, mat)
  }
  const m = box(w, 0.08, 0.85, mat, { y, z, rx: 0.32 })
  m.scale.x = 1
  return m
}

function doorway(w: number, h: number, z: number, color = '#3a2f2a'): THREE.Group {
  return group(
    box(w, h, 0.14, flat(color, { roughness: 0.5 }), { z }),
    box(w + 0.3, 0.12, 0.2, flat('#f1ece0'), { y: h, z }),
    box(w + 0.5, 0.1, 0.5, flat('#cfc8b8'), { y: 0, z: z + 0.3 }),
  )
}

function shopWindow(w: number, x: number, z: number): THREE.Group {
  return group(
    box(w + 0.16, 1.0, 0.1, flat('#f1ece0'), { x, y: 0.5, z }),
    box(w, 0.86, 0.14, flat('#5b86a8', { roughness: 0.25 }), { x, y: 0.57, z: z + 0.01 }),
  )
}

/** Flat roof edge: a low parapet wall around the top. */
function parapet(w: number, d: number, color = '#c9c2b2'): THREE.Group {
  const t = 0.2, h = 0.42
  const m = flat(color)
  return group(
    box(w + 0.3, 0.14, d + 0.3, flat('#a39d90')),
    box(w + 0.3, h, t, m, { y: 0.14, z: d / 2 + 0.05 }),
    box(w + 0.3, h, t, m, { y: 0.14, z: -d / 2 - 0.05 }),
    box(t, h, d + 0.3, m, { y: 0.14, x: w / 2 + 0.05 }),
    box(t, h, d + 0.3, m, { y: 0.14, x: -w / 2 - 0.05 }),
  )
}

/** A four-sided hip roof over a rectangle. */
function hipRoof(w: number, d: number, h: number, color: string): THREE.Mesh {
  const g = new THREE.ConeGeometry(1, h, 4)
  g.rotateY(Math.PI / 4)
  g.scale((w / 2) * Math.SQRT2 * 1.06, 1, (d / 2) * Math.SQRT2 * 1.06)
  g.translate(0, h / 2, 0)
  const m = new THREE.Mesh(g, flat(color))
  m.castShadow = true
  return m
}

function mast(h: number): THREE.Mesh {
  return cyl(0.05, 0.07, h, flat('#9aa3ad', { metalness: 0.3 }), {}, 8)
}

function planter(x: number, z: number): THREE.Object3D {
  const b = kit('bush')
  b.scale.setScalar(2.2)
  b.position.set(x, 0.05, z)
  return b
}

// ── API: a brick-and-stone townhouse tower with a shopfront ─────────────────

function townhouse(accent: string): BuildingModel {
  const W = 4 * CELL, D = 4 * CELL, FH = 1.6
  const base = group(
    box(W + 0.2, 1.7, D + 0.2, flat('#7a5a47')),
    box(W + 0.34, 0.14, D + 0.34, flat('#f1ece0'), { y: 1.7 }),
    shopWindow(1.5, -1.45, D / 2 + 0.1),
    shopWindow(1.5, 1.45, D / 2 + 0.1),
    doorway(1.0, 1.3, D / 2 + 0.1),
    awning(W - 0.4, 1.38, D / 2 + 0.6, accent),
    planter(-2.3, D / 2 + 0.7), planter(2.3, D / 2 + 0.7),
    // pavement apron
    box(W + 1.6, 0.08, 1.6, flat('#cfc8b8'), { z: D / 2 + 0.9 }),
  )
  const tower = kit('watertower')
  tower.scale.setScalar(2.1)
  tower.position.set(-1.35, 0.14, -1.2)
  const roof = group(parapet(W, D), tower, at(mast(1.5), 0.8, 0.14, 0.5))
  return {
    base,
    baseHeight: 1.84,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#b9573f', trim: '#f4eee0', floorHeight: FH, width: W, depth: D, brick: true, cell: CELL })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(0.8, 1.7, 0.5),
    door: v(0, 0, D / 2 + 1.6),
    doorDir: v(0, 0, 1),
    plaque: { position: v(W / 2 - 0.6, 0.55, D / 2 + 0.25), width: 1.5 },
    radius: 3.2,
  }
}

// ── Worker: a brick factory with a loading bay, roof units and smoking chimneys ─────────────

function factory(accent: string): BuildingModel {
  const W = 5 * CELL, D = 4 * CELL, FH = 1.6
  const brick = flat('#c99a54'), trim = flat('#f4ecd8'), band = flat('#f1ece0'), chim = flat('#a2503b')
  let activity = 0.4
  const smoke: THREE.Mesh[] = []
  for (let i = 0; i < 8; i++) {
    smoke.push(new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), new THREE.MeshStandardMaterial({ color: '#f4f4f4', transparent: true, opacity: 0.8, roughness: 1, flatShading: true })))
  }
  const CHIMNEYS = [{ x: 1.9, h: 3.4 }, { x: 1.0, h: 2.6 }]
  const stack = (x: number, h: number) => group(
    cyl(0.34, 0.46, h, chim, { x, y: 0.14, z: -1.4 }, 10),
    cyl(0.4, 0.4, 0.14, trim, { x, y: 0.14 + h - 0.4, z: -1.4 }, 10),
    cyl(0.44, 0.44, 0.14, trim, { x, y: 0.14 + h, z: -1.4 }, 10),
  )
  const hazard = canvasTexture(256, 16, (ctx) => {
    for (let i = 0; i < 16; i++) { ctx.fillStyle = i % 2 ? '#1f2328' : '#f2c230'; ctx.beginPath(); ctx.moveTo(i * 16, 16); ctx.lineTo(i * 16 + 8, 0); ctx.lineTo(i * 16 + 24, 0); ctx.lineTo(i * 16 + 16, 16); ctx.fill() }
  })
  const roller = (x: number) => group(
    box(1.5, 1.4, 0.14, flat('#c7ced6', { roughness: 0.5 }), { x, z: D / 2 + 0.1 }),
    ...[0.25, 0.5, 0.75, 1.0, 1.25].map((y) => box(1.4, 0.03, 0.04, flat('#8f99a5'), { x, y, z: D / 2 + 0.2 })),
    box(1.7, 0.12, 0.2, band, { x, y: 1.4, z: D / 2 + 0.1 }),
  )
  const base = group(
    box(W + 0.2, 1.7, D + 0.2, brick),
    box(W + 0.34, 0.14, D + 0.34, band, { y: 1.7 }),
    box(W + 0.22, 0.2, 0.02, new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.9 }), { y: 0.05, z: D / 2 + 0.11 }),
    roller(-1.7), roller(-0.1),
    doorway(0.8, 1.25, D / 2 + 0.1, '#2f3a46'),
    awning(1.1, 1.3, D / 2 + 0.55, accent),
    box(W + 1.6, 0.08, 1.8, flat('#cfc8b8'), { z: D / 2 + 1.0 }),
  )
  // a unit on the roof: a light grey box with a fan on top
  const unit = (x: number, z: number) => group(
    box(1.3, 0.55, 1.0, flat('#d4d9de'), { x, y: 0.14, z }),
    cyl(0.36, 0.36, 0.06, flat('#8a949f'), { x, y: 0.72, z }, 14),
  )
  const sign = canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 512, 128)
    ctx.fillStyle = '#26364f'; ctx.font = '800 76px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('FACTORY', 256, 68)
  })
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }))
  board.position.set(-0.6, 0.74, D / 2 - 0.41)
  const roof = group(
    parapet(W, D),
    ...CHIMNEYS.map((c) => stack(c.x, c.h)),
    unit(-0.4, -0.2), unit(-1.8, 0.7),
    box(3.4, 1.2, 0.16, flat(accent), { x: -0.6, y: 0.14, z: D / 2 - 0.5 }),
    board,
    at(mast(1.5), 2.2, 0.14, 1.3),
    ...smoke,
  )
  return {
    base,
    baseHeight: 1.84,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#d6ad66', trim: '#f4ecd8', floorHeight: FH, width: W, depth: D, brick: true, cell: CELL })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(2.2, 1.7, 1.3),
    door: v(0, 0, D / 2 + 1.7),
    doorDir: v(0, 0, 1),
    plaque: { position: v(W / 2 - 0.7, 0.55, D / 2 + 0.25), width: 1.5 },
    radius: 3.6,
    // chimney smoke thickens with CPU
    setActivity: (level) => { activity = level },
    animate: (time) => {
      const rate = 0.25 + 0.5 * activity
      smoke.forEach((p, i) => {
        const c = CHIMNEYS[i % 2]
        const life = (time * rate + i / smoke.length) % 1
        p.position.set(c.x + Math.sin(i * 2.1 + time * 0.4) * 0.15 * life, 0.14 + c.h + 0.3 + life * 3.0, -1.4)
        p.scale.setScalar((0.4 + life * 1.3) * (0.6 + 0.8 * activity))
        ;(p.material as THREE.MeshStandardMaterial).opacity = (0.35 + 0.55 * activity) * (1 - life)
      })
    },
  }
}

// ── Database: storage units, each door a unit; lit doors are the share of capacity in use ─────

function storage(accent: string): BuildingModel {
  const W = 5 * CELL, D = 4 * CELL, FH = 1.95
  const trim = flat('#eef2f5')
  const sign = canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = accent; ctx.fillRect(0, 0, 512, 128)
    ctx.fillStyle = '#ffffff'; ctx.font = '800 76px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('STORAGE', 256, 68)
  })
  const base = group(
    box(W + 0.2, 0.5, D + 0.2, flat('#7d8a97')),
    box(W + 1.6, 0.08, 1.8, flat('#cfc8b8'), { z: D / 2 + 1.0 }),
    // office door and canopy at the right end
    box(0.9, 1.3, 0.14, flat('#2f3a46', { roughness: 0.4 }), { x: W / 2 - 1.0, y: 0.5, z: D / 2 + 0.1 }),
    box(1.5, 0.12, 0.8, flat(accent), { x: W / 2 - 1.0, y: 1.9, z: D / 2 + 0.4 }),
    box(0.1, 1.4, 0.1, trim, { x: W / 2 - 1.7, y: 0.5, z: D / 2 + 0.75 }),
    box(0.1, 1.4, 0.1, trim, { x: W / 2 - 0.3, y: 0.5, z: D / 2 + 0.75 }),
  )
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: sign, toneMapped: false }))
  board.position.set(0, 0.95, D / 2 - 0.05)
  const roof = group(
    parapet(W, D, '#cfd6dd'),
    box(3.8, 1.3, 0.16, flat(accent), { y: 0.14, z: D / 2 - 0.5 }),
    board,
    at(mast(1.2), 2.2, 0.14, -0.8),
  )
  board.position.set(0, 0.8, D / 2 - 0.41)
  return {
    base,
    baseHeight: 0.58,
    floorHeight: FH,
    fixedFloors: 2,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: '#b3bfca', trim: '#f3f6f8', floorHeight: FH, width: W, depth: D, cell: CELL, win: [0.95, 1.6] })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(2.2, 1.34, -0.8),
    door: v(0, 0, D / 2 + 1.9),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-W / 2 + 0.9, 0.5, D / 2 + 0.25), width: 1.5 },
    radius: 3.6,
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
    base.add(leg)
  }
  base.add(box(2.4, 0.07, 0.07, legMat, { y: 1.2, z: 0.95 }), box(2.4, 0.07, 0.07, legMat, { y: 1.2, z: -0.95 }))
  base.add(box(0.07, 0.07, 2.4, legMat, { y: 1.9, x: 0.95 }), box(0.07, 0.07, 2.4, legMat, { y: 1.9, x: -0.95 }))
  const shed = group(box(1.2, 0.9, 1.0, flat('#e8dfc9')), box(1.3, 0.1, 1.1, flat('#8a5a38'), { y: 0.9 }), box(0.45, 0.62, 0.06, flat('#3a2f2a'), { z: 0.52 }))
  shed.position.set(0, 0.18, 1.9)
  base.add(shed)
  const roof = group(cone(1.55, 1.0, flat('#d9892f'), {}, 12), sphere(0.12, flat('#d9892f'), { y: 1.05 }, 8), at(mast(1.1), 0, 0.9, 0))
  return {
    base,
    baseHeight: 3.2,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cacheTank, trim: '#a8761d', floorHeight: FH, radial: 10, win: [0.34, 0.4], roughness: 0.55 })
      const f = group(cyl(1.38, 1.38, FH, material, {}, 20), cyl(1.43, 1.43, 0.09, flat('#a8761d'), {}, 20), cyl(1.43, 1.43, 0.09, flat('#a8761d'), { y: FH - 0.09 }, 20))
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

// ── Cron: clock tower ───────────────────────────────────────────────────────

function clockTower(): BuildingModel {
  const FH = 1.5
  const W = 2 * CELL
  const stone = flat(P.cronStone)
  const base = group(
    box(3.0, 0.6, 3.0, flat('#b6ab94')),
    box(W, 2.4, W, stone, { y: 0.6 }),
    box(0.8, 1.1, 0.12, flat('#5a4636', { roughness: 0.5 }), { y: 0.6, z: W / 2 + 0.05 }),
    cone(0.42, 0.25, flat('#5a4636'), { y: 1.7, z: W / 2 + 0.05 }, 12),
    box(2.2, 0.08, 1.4, flat('#cfc8b8'), { z: W / 2 + 0.9 }),
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
  roof.add(hands, cone(2.05, 1.9, flat(P.cronRoof), { y: 1.9, ry: Math.PI / 4 }, 4), at(mast(1.0), 0, 3.6, 0))
  return {
    base,
    baseHeight: 3.0,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.cronStone, trim: '#f1ece0', floorHeight: FH, width: W, depth: W, cell: CELL, win: [0.5, 0.8] })
      return { object: box(W - 0.2, FH, W - 0.2, material), uniforms }
    },
    roof,
    beaconAt: v(0, 4.6, 0),
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

// ── Gateway: the hub's gate house ───────────────────────────────────────────

function gateway(accent: string): BuildingModel {
  const FH = 1.6
  const stone = flat(P.gatewayStone)
  const gold = flat(P.gatewayAccent, { metalness: 0.2, roughness: 0.5 })
  const flags = [-4.2, 4.2].map((x) => group(
    cyl(0.05, 0.05, 1.8, flat('#caa24a'), { x }, 6),
    box(0.9, 0.55, 0.04, flat(accent), { x: x + 0.47, y: 1.2 }),
  ))
  const base = group(
    box(10.4, 0.5, 4.2, flat('#c3b999')),
    // arch hall between the towers: piers, lintel with a gold band and a dark opening the road runs through
    box(1.4, 3.0, 3.6, stone, { x: -2.5, y: 0.5 }),
    box(1.4, 3.0, 3.6, stone, { x: 2.5, y: 0.5 }),
    box(6.4, 1.1, 3.6, stone, { y: 2.4 }),
    box(6.6, 0.22, 3.8, gold, { y: 3.5 }),
  )
  const sign = canvasTexture(512, 96, (ctx) => {
    ctx.fillStyle = '#26303c'; ctx.fillRect(0, 0, 512, 96)
    ctx.fillStyle = '#f5d98c'; ctx.font = '700 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('API GATEWAY', 256, 50)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.86), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 2.95, 1.96)
  base.add(signMesh, ...flags)
  const tower = () => group(box(2.8, 0.2, 3.9, gold), cone(1.9, 1.2, flat('#7a5c2e'), { y: 0.2, ry: Math.PI / 4 }))
  return {
    base,
    baseHeight: 0.5,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.gatewayStone, trim: '#fbf5e4', floorHeight: FH, width: 2 * CELL, depth: 3 * CELL, cell: CELL })
      return { object: group(box(2.4, FH, 3.6, material, { x: -4.0 }), box(2.4, FH, 3.6, material, { x: 4.0 })), uniforms }
    },
    roof: group(at(tower(), -4.0, 0, 0), at(tower(), 4.0, 0, 0), at(group(box(2.1, 0.2, 2.1, gold), box(1.5, 0.5, 1.5, stone, { y: 0.2 }), at(mast(1.2), 0, 0.7, 0)), 0, -1.2, 0)),
    beaconAt: v(0, 0.2, 0),
    door: v(0, 0, 2.6),
    doorDir: v(0, 0, 1),
    plaque: { position: v(-2.5, 0.65, 1.82), width: 1.2 },
    radius: 6,
  }
}

// ── Broker: the port, a warehouse on a jetty with a crane ───────────────────

function port(name?: string): BuildingModel {
  const FH = 1.5
  const W = 6 * CELL, D = 4 * CELL
  const boxColors = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a', '#e0573f', '#8e6bd9']
  const dock = group(
    box(6.6, 0.3, 12.5, flat(palette.wood), { z: 8.5 }),
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
  dock.position.y = 0.4
  const base = group(
    box(W + 1.0, 0.4, D + 0.6, flat('#b9b2a4')),
    dock,
    box(1.5, 1.05, 0.14, flat('#1d2733', { roughness: 0.4 }), { y: 0.4, z: -(D / 2 + 0.3) }),
  )
  const sign = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = '#f4efe2'; ctx.fillRect(0, 0, 256, 64)
    ctx.fillStyle = '#26364f'; ctx.font = '700 36px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(portSignText(name), 128, 34, 240)
  })
  const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshBasicMaterial({ map: sign }))
  signMesh.position.set(0, 1.5, D / 2 + 0.35)
  base.add(signMesh, crane)
  const roof = group(hipRoof(W, D, 1.5, P.brokerRoof), at(mast(1.1), 0, 1.2, 0))
  return {
    base,
    baseHeight: 0.4,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.brokerWall, trim: '#f1ece0', floorHeight: FH, width: W, depth: D, cell: CELL, win: [0.6, 0.7] })
      return { object: box(W, FH, D, material), uniforms }
    },
    roof,
    beaconAt: v(0, 1.8, 0),
    door: v(0, 0, -(D / 2 + 1.2)),
    doorDir: v(0, 0, -1),
    plaque: { position: v(-3.0, 0.55, -(D / 2 + 0.35)), width: 1.4, rotY: Math.PI },
    radius: 4.5,
    signText: portSignText(name),
    animate: (time) => { crane.rotation.y = Math.sin(time * 0.25) * 0.5 },
  }
}

// ── Egress: tower with a satellite dish ─────────────────────────────────────

function egress(accent: string): BuildingModel {
  const FH = 1.5
  const W = 2 * CELL
  const base = group(
    box(4.2, 0.9, 4.0, flat('#d8d1c1')),
    box(1.1, 0.75, 0.12, flat('#2b3340', { roughness: 0.4 }), { z: 2.01 }),
    awning(1.7, 0.95, 2.4, accent),
    box(3.6, 0.08, 1.4, flat('#cfc8b8'), { z: 2.7 }),
  )
  const dishPivot = new THREE.Group()
  const dishBowl = dome(1.0, flat(P.egressDish, { roughness: 0.4 }))
  dishBowl.rotation.x = Math.PI * 0.72
  dishBowl.position.set(0, 1.35, 0)
  dishPivot.add(cyl(0.12, 0.12, 0.9, flat('#9aa3ad'), {}, 8), dishBowl, at(cyl(0.04, 0.04, 0.9, flat('#9aa3ad'), {}, 6), 0, 1.4, 0))
  const roof = group(box(W + 0.3, 0.2, W + 0.3, flat('#8d98a6')), at(dishPivot, 0, 0.2, 0.2), at(mast(1.1), 0.95, 0.2, -0.9))
  return {
    base,
    baseHeight: 0.9,
    floorHeight: FH,
    makeFloor: () => {
      const { material, uniforms } = makeWindowMaterial({ color: P.egressBody, trim: '#f7f7f7', floorHeight: FH, width: W, depth: W, cell: CELL, win: [0.6, 0.8] })
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
