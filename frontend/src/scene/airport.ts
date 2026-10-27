import * as THREE from 'three'
import { canvasTexture, roundRect } from '../buildings/mk'
import { activeKit } from '../themes/active'
import type { AirportKit } from '../themes/types'
import type { ExternalCallerSnapshot } from '../types'
import { clamp, formatRate } from '../visuals'
import { buildIslandBody, GROUND, makeOutline, scatterNature, type Outline, type Rect } from './island'
import { coastScan } from './plan'
import { hashString, rng } from './random'
import { mergeStatic } from './merge'

const RUNWAY_Z = -9 // island-local: the runway runs along x
const RUNWAY_HALF = 31
const TERMINAL_Z = 0.5 // centre of the terminal building
const APRON_Z = 8 // the road meets the terminal's front here
const MAX_PLANES = 4
/** Seconds a plane takes to land, roll out, taxi to the terminal and park. */
const APPROACH = 7, ROLLOUT = 4.5, TAXI = 3.5, PARK = 2.5, FADE = 1.2
const HOVER = 1.5 // how high a ship rides over its pad
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
  /** What arrives in this theme: a plane, a cargo plane, a flying saucer. */
  look: string
  /** Planes that have landed since the town was built. */
  landed: number
  board: string[]
}

interface Plane {
  mesh: THREE.Group
  t: number
  tail: number
  /** The pad a ship comes down on, where the theme lands ships. */
  pad: number
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
  private readonly kit: AirportKit
  private readonly tick?: (time: number) => void

  constructor() {
    this.outline = makeOutline(hashString('airport'), this.rx, this.rz, 0.045)
    this.gateZ = coastScan(this.outline, 'z') - 0.6
    this.root.add(buildIslandBody(this.outline))
    const decor = new THREE.Group()
    this.root.add(decor)
    this.kit = activeKit().airport
    const look = this.kit.dress(decor, { runwayZ: RUNWAY_Z, runwayHalf: RUNWAY_HALF, terminalZ: TERMINAL_Z, apronZ: APRON_Z, gateZ: this.gateZ })
    this.tick = look.tick
    const avoid: Rect[] = look.avoid
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
    return { requestsPerSecond: this.rps, callers: this.callers.length, planes: this.planes.length, look: this.kit.look, landed: this.landed, board: this.boardLines() }
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
    this.tick?.(time)
    this.fadeBoard(camera)
  }

  // ── planes ─────────────────────────────────────────────────────────────────

  private spawn(): void {
    const mesh = this.pool.pop() ?? this.kit.craft()
    mesh.traverse((o) => { if (o.userData.beam) o.visible = false })
    const tail = Math.floor(this.rand() * TAILS.length)
    mesh.traverse((o) => { if (o.userData.tail) ((o as THREE.Mesh).material as THREE.MeshLambertMaterial).color.set(TAILS[tail]) })
    mesh.visible = true
    mesh.scale.setScalar(1)
    this.root.add(mesh)
    this.planes.push({ mesh, t: 0, tail, pad: this.freePad() })
    this.pose(this.planes[this.planes.length - 1])
  }

  /** A pad no ship is using, for a theme that lands ships on pads. */
  private freePad(): number {
    const landing = this.kit.landing
    if (landing.kind !== 'pads') return 0
    const used = new Set(this.planes.map((p) => p.pad))
    for (let i = 0; i < landing.x.length; i++) if (!used.has(i)) return i
    return 0
  }

  /** Where an arrival is, a moment into its visit. */
  private pose(p: Plane): void {
    const landing = this.kit.landing
    if (landing.kind === 'pads') this.poseOnPad(p, landing.x[p.pad % landing.x.length])
    else this.poseOnRunway(p)
  }

  /** A ship comes in over the sea from the west, slows above its pad, hovers down onto it, waits, and lifts away as it fades. */
  private poseOnPad(p: Plane, padX: number): void {
    const m = p.mesh
    const ease = (k: number) => 1 - (1 - k) * (1 - k)
    const beam = m.children.find((c) => c.userData.beam)
    m.rotation.set(0, 0, 0)
    if (p.t < APPROACH) {
      const k = p.t / APPROACH
      m.position.set(padX - 80 * (1 - ease(k)) ** 2, GROUND + HOVER + 20 * (1 - k) ** 2 + 5 * (1 - ease(k)), RUNWAY_Z)
      m.rotation.z = -0.2 * (1 - k)
      if (beam) beam.visible = false
    } else if (p.t < APPROACH + ROLLOUT) {
      const k = ease((p.t - APPROACH) / ROLLOUT)
      m.position.set(padX, GROUND + HOVER + 5 * (1 - k), RUNWAY_Z)
      if (beam) beam.visible = true
    } else if (p.t < APPROACH + ROLLOUT + TAXI + PARK) {
      m.position.set(padX, GROUND + HOVER + 0.12 * Math.sin(p.t * 2 + p.pad), RUNWAY_Z)
      if (beam) beam.visible = false
    } else {
      const k = clamp((p.t - APPROACH - ROLLOUT - TAXI - PARK) / FADE, 0, 1)
      m.position.set(padX, GROUND + HOVER + 6 * k * k, RUNWAY_Z)
      m.scale.setScalar(1 - k)
    }
  }

  /** A plane comes in over the sea from the west, lands, rolls out, taxis to the terminal and parks. */
  private poseOnRunway(p: Plane): void {
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
