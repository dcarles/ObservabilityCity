import * as THREE from 'three'
import { box, canvasTexture, cyl, flat, group, roundRect } from '../buildings/mk'
import { kit } from '../assets/kit'
import type { ExternalCallerSnapshot } from '../types'
import { clamp, formatRate } from '../visuals'
import { buildIslandBody, GROUND, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { coastScan } from './plan'
import { blockPad, lamp, street, ROAD_W } from './props'
import { hashString, rng } from './random'
import { mergeStatic } from './merge'

const RUNWAY_Z = -9 // island-local: the runway runs along x
const RUNWAY_HALF = 31
const TERMINAL_Z = 0.5 // centre of the terminal building
const APRON_Z = 8 // the road meets the terminal's front here
const MAX_PLANES = 4
/** Seconds a plane takes to land, roll out, taxi to the terminal and park. */
const APPROACH = 7, ROLLOUT = 4.5, TAXI = 3.5, PARK = 2.5, FADE = 1.2
const TAILS = ['#e4572e', '#2e86ab', '#f2b134', '#5cb85c', '#8e6bbf']

/** How many planes land per second for an arrival rate in requests per second: a sample, not a count, like every other mover in the town. */
export function planeRate(rps: number): number {
  return rps <= 0 ? 0 : clamp(0.005 * Math.sqrt(rps), 0.02, 0.4)
}

/** What a test can read about the airport. */
export interface AirportStatus {
  requestsPerSecond: number
  callers: number
  /** Planes on the ground or in the air right now. */
  planes: number
  /** Planes that have landed since the town was built. */
  landed: number
  board: string[]
}

interface Plane {
  mesh: THREE.Group
  t: number
  tail: number
}

/**
 * The airport for outside callers: an island of its own with a runway, a terminal, a tower and an arrivals board. Planes land at a rate that
 * follows the outside traffic coming in, and the taxis (yellow cars) that carry that traffic over the bridge set off from the terminal door.
 * Island-local +z points at the hub, where the bridge starts.
 */
export class Airport {
  readonly root = new THREE.Group()
  readonly outline: Outline
  readonly rx = 40
  readonly rz = 22
  readonly gateZ: number
  private readonly planes: Plane[] = []
  private readonly pool: THREE.Group[] = []
  private acc = 0.8
  private landed = 0
  private rps = 0
  private callers: ExternalCallerSnapshot[] = []
  private readonly board: { sprite: THREE.Sprite; key: string }
  private readonly rand = rng(hashString('airport'))
  private readonly sock: THREE.Mesh

  constructor() {
    this.outline = makeOutline(hashString('airport'), this.rx, this.rz, 0.045)
    this.gateZ = coastScan(this.outline, 'z') - 0.6
    this.root.add(buildIslandBody(this.outline))
    const decor = new THREE.Group()
    this.root.add(decor)
    const avoid: Rect[] = [
      { x: 0, z: RUNWAY_Z, w: 2 * RUNWAY_HALF + 14, d: 12 },
      { x: 0, z: (this.gateZ + TERMINAL_Z) / 2, w: 40, d: this.gateZ - TERMINAL_Z + 6 },
      { x: 0, z: TERMINAL_Z, w: 66, d: 14 },
    ]

    // runway with edge lines, centre dashes and the numbers at either end
    const dark = flat('#3b4250', { roughness: 0.95 }), white = flat('#f4f1e8', { roughness: 0.9 })
    decor.add(box(2 * RUNWAY_HALF + 8, 0.12, 5.4, dark, { y: GROUND - 0.02, z: RUNWAY_Z }))
    for (let i = -RUNWAY_HALF + 2; i <= RUNWAY_HALF - 2; i += 5.5) decor.add(box(2.6, 0.02, 0.28, white, { x: i, y: GROUND + 0.11, z: RUNWAY_Z }))
    for (const side of [-1, 1]) {
      decor.add(box(2 * RUNWAY_HALF + 6, 0.02, 0.14, white, { y: GROUND + 0.11, z: RUNWAY_Z + side * 2.4 }))
      for (let k = -2; k <= 2; k++) decor.add(box(0.5, 0.02, 3.2, white, { x: side * (RUNWAY_HALF + 1.6), y: GROUND + 0.11, z: RUNWAY_Z + k * 0.9 }))
    }
    // the taxiway and the apron in front of the terminal
    decor.add(blockPad(0, RUNWAY_Z + 3, TERMINAL_Z + 7.5, 46))
    decor.add(box(4.6, 0.12, 8, dark, { x: 24, y: GROUND - 0.02, z: RUNWAY_Z + 7.4 }))

    // terminal: a long low hall with a glass front, a tower and a hangar
    const wall = flat('#e9edf2'), roofM = flat('#5b6b82'), glass = flat('#6fb6e0', { emissive: '#2a6fa0', emissiveIntensity: 0.35 }), trim = flat('#ff7a45')
    const terminal = group(
      box(24, 4.4, 8, wall, { y: GROUND }),
      box(25.2, 0.5, 9.4, roofM, { y: GROUND + 4.4 }),
      box(22, 2.2, 0.2, glass, { y: GROUND + 1.2, z: 4.1 }),
      box(25.2, 0.28, 0.4, trim, { y: GROUND + 4.9, z: 4.6 }),
    )
    terminal.position.z = TERMINAL_Z
    decor.add(terminal)
    const tower = group(
      cyl(1.2, 1.5, 9, wall, { y: GROUND }),
      cyl(2.6, 2.1, 1.7, glass, { y: GROUND + 9 }),
      cyl(2.9, 2.9, 0.4, roofM, { y: GROUND + 10.7 }),
      cyl(0.06, 0.06, 2.2, roofM, { y: GROUND + 11.1 }),
    )
    tower.position.set(-17, 0, TERMINAL_Z - 1)
    decor.add(tower)
    const hangar = group(box(10, 4.2, 8, flat('#c7ced8'), { y: GROUND }), box(10.4, 1.4, 8.4, roofM, { y: GROUND + 4.2 }), box(6, 3.2, 0.2, flat('#8b95a3'), { y: GROUND, z: 4.1 }))
    hangar.position.set(21, 0, TERMINAL_Z - 0.5)
    decor.add(hangar)
    avoid.push({ x: -17, z: TERMINAL_Z - 1, w: 7, d: 7 }, { x: 21, z: TERMINAL_Z - 0.5, w: 13, d: 11 })

    // a windsock at the runway's end
    const pole = cyl(0.1, 0.12, 3.4, white, { y: GROUND })
    this.sock = new THREE.Mesh(new THREE.ConeGeometry(0.46, 1.8, 7, 1, true), new THREE.MeshStandardMaterial({ color: '#ff7a45', side: THREE.DoubleSide, flatShading: true }))
    this.sock.geometry.rotateZ(-Math.PI / 2)
    this.sock.position.set(0.9, GROUND + 3.2, 0)
    const sockGroup = group(pole, this.sock)
    sockGroup.position.set(RUNWAY_HALF + 6, 0, RUNWAY_Z - 4.5)
    decor.add(sockGroup)

    // the road from the gate to the terminal, with a small car park beside it
    decor.add(street(0, APRON_Z, this.gateZ + 0.2))
    decor.add(blockPad(14, APRON_Z - 1, APRON_Z + 6, 12))
    for (let i = 0; i < 5; i++) {
      const car = kit(i % 2 ? 'car_hatchback' : 'car_stationwagon')
      car.scale.setScalar(0.9)
      car.position.set(9.5 + i * 2.2, GROUND + 0.1, APRON_Z + 2.2)
      car.rotation.y = Math.PI / 2
      decor.add(car)
    }
    for (const side of [-1, 1]) decor.add(lamp(side * (ROAD_W / 2 + 1.6), APRON_Z + 3 + (side + 1) * 3, 0))
    avoid.push({ x: 14, z: APRON_Z + 2.5, w: 14, d: 9 })
    mergeStatic(decor)
    this.root.add(scatterNature(this.outline, avoid, hashString('airport-nature'), { trees: 40, rocks: 10 }))

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(448, 256, () => {}), transparent: true, depthTest: false, toneMapped: false }))
    sprite.renderOrder = 10
    sprite.scale.set(10.5, 6, 1)
    sprite.position.set(0, GROUND + 11.5, TERMINAL_Z)
    this.root.add(sprite)
    this.board = { sprite, key: '' }
    this.drawBoard()
  }

  /** Where the taxis set off from: the front of the terminal. World coordinates, once the island is placed. */
  doorWorld(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false)
    return this.root.localToWorld(new THREE.Vector3(0, GROUND, APRON_Z - 0.5))
  }

  /** The gate in world coordinates: where the bridge from the hub ends. */
  gate(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false)
    return this.root.localToWorld(new THREE.Vector3(0, GROUND, this.gateZ))
  }

  /** The outside traffic coming in: the total, and which callers bring it. */
  setCallers(callers: readonly ExternalCallerSnapshot[]): void {
    this.callers = [...callers].sort((a, b) => b.requestsPerSecond - a.requestsPerSecond)
    this.rps = this.callers.reduce((a, c) => a + c.requestsPerSecond, 0)
    this.drawBoard()
  }

  status(): AirportStatus {
    return { requestsPerSecond: this.rps, callers: this.callers.length, planes: this.planes.length, landed: this.landed, board: this.boardLines() }
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    // spawn arrivals at the rate the traffic asks for, never more than a few in the sky at once
    this.acc += planeRate(this.rps) * dt
    if (this.acc >= 1 && this.planes.length < MAX_PLANES) {
      this.acc -= 1
      this.spawn()
    } else if (this.acc > 2) this.acc = 2
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const p = this.planes[i]
      p.t += dt
      if (p.t >= APPROACH + ROLLOUT + TAXI + PARK + FADE) {
        p.mesh.visible = false
        this.pool.push(p.mesh)
        this.planes.splice(i, 1)
        this.landed++
        continue
      }
      this.pose(p)
    }
    this.sock.rotation.y = Math.sin(time * 0.6) * 0.25
    this.sock.rotation.z = Math.sin(time * 2.1) * 0.06
    this.fadeBoard(camera)
  }

  // ── planes ─────────────────────────────────────────────────────────────────

  private spawn(): void {
    const mesh = this.pool.pop() ?? this.makePlane()
    const tail = Math.floor(this.rand() * TAILS.length)
    mesh.traverse((o) => { if (o.userData.tail) ((o as THREE.Mesh).material as THREE.MeshLambertMaterial).color.set(TAILS[tail]) })
    mesh.visible = true
    mesh.scale.setScalar(1)
    this.root.add(mesh)
    this.planes.push({ mesh, t: 0, tail })
    this.pose(this.planes[this.planes.length - 1])
  }

  /** Where a plane is, a moment into its arrival. It comes in over the sea from the west, lands, rolls out, taxis to the terminal and parks. */
  private pose(p: Plane): void {
    const m = p.mesh
    const ease = (k: number) => 1 - (1 - k) * (1 - k)
    const TOUCH = -27, STOP = 15
    if (p.t < APPROACH) {
      const k = p.t / APPROACH
      m.position.set(-100 + (TOUCH + 100) * k, GROUND + 0.9 + 26 * (1 - k) ** 1.6, RUNWAY_Z)
      m.rotation.set(0, 0, 0)
      m.rotation.z = -0.12 * (1 - k) // nose slightly down on the glide
    } else if (p.t < APPROACH + ROLLOUT) {
      const k = ease((p.t - APPROACH) / ROLLOUT)
      m.position.set(TOUCH + (STOP - TOUCH) * k, GROUND + 0.9, RUNWAY_Z)
      m.rotation.set(0, 0, 0)
    } else if (p.t < APPROACH + ROLLOUT + TAXI) {
      // off the runway by the taxiway at its east end, then in toward the terminal
      const k = (p.t - APPROACH - ROLLOUT) / TAXI
      const x = STOP + 9 * k, z = RUNWAY_Z + (7.4 + 1) * ease(k)
      m.position.set(x, GROUND + 0.9, z)
      m.rotation.set(0, -Math.PI / 2 * clamp(k * 1.4, 0, 1), 0)
    } else {
      const k = clamp((p.t - APPROACH - ROLLOUT - TAXI - PARK) / FADE, 0, 1)
      m.position.set(STOP + 9, GROUND + 0.9, RUNWAY_Z + 8.4)
      m.rotation.set(0, -Math.PI / 2, 0)
      m.scale.setScalar(1 - k)
    }
  }

  private makePlane(): THREE.Group {
    const body = new THREE.MeshLambertMaterial({ color: '#f6f8fb', flatShading: true })
    const dark = new THREE.MeshLambertMaterial({ color: '#4d5663', flatShading: true })
    const tail = new THREE.MeshLambertMaterial({ color: TAILS[0], flatShading: true })
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 8, 10), body)
    fuselage.rotation.z = Math.PI / 2
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.8, 10), body)
    nose.rotation.z = -Math.PI / 2
    nose.position.x = 4.9
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.75, 2.4, 10), body)
    cone.rotation.z = Math.PI / 2
    cone.position.x = -5.1
    const wings = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 11), dark)
    wings.position.set(0.4, -0.15, 0)
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.1, 0.16), tail)
    fin.position.set(-4.3, 1.3, 0)
    fin.userData.tail = true
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 4), dark)
    stab.position.set(-4.5, 0.5, 0)
    const engines = [-2.6, 2.6].map((z) => {
      const e = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.6, 8), dark)
      e.rotation.z = Math.PI / 2
      e.position.set(0.9, -0.55, z)
      return e
    })
    const g = new THREE.Group()
    g.add(fuselage, nose, cone, wings, fin, stab, ...engines)
    g.scale.setScalar(1)
    g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true })
    return g
  }

  // ── the arrivals board ──────────────────────────────────────────────────────

  private boardLines(): string[] {
    const lines = [`ARRIVALS  ${formatRate(this.rps)} req/s`]
    for (const c of this.callers.slice(0, 4)) lines.push(`${c.name}  ${formatRate(c.requestsPerSecond)}/s`)
    return lines
  }

  private drawBoard(): void {
    const lines = this.boardLines()
    const key = lines.join('|')
    if (key === this.board.key) return
    this.board.key = key
    const tex = (this.board.sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, 448, 256)
    ctx.fillStyle = 'rgba(20,28,40,0.94)'; roundRect(ctx, 6, 6, 436, 244, 24); ctx.fill()
    ctx.strokeStyle = '#f0c24a'; ctx.lineWidth = 6; ctx.stroke()
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#f0c24a' : '#dbe6f3'
      ctx.font = i === 0 ? '800 34px system-ui, sans-serif' : '600 28px system-ui, sans-serif'
      ctx.fillText(l, 28, 44 + i * 46, 392)
    })
    tex.needsUpdate = true
  }

  private fadeBoard(camera: THREE.Camera): void {
    const d = camera.position.distanceTo(this.board.sprite.getWorldPosition(new THREE.Vector3()))
    const scale = clamp(d / 60, 1, 2.4)
    this.board.sprite.scale.set(10.5 * scale, 6 * scale, 1)
  }
}
