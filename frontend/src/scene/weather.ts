import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { canvasTexture, roundRect } from '../buildings/mk'
import type { IncidentSnapshot } from '../types'
import { clamp } from '../visuals'
import { hashString, rng } from './random'

/** How an incident's severity looks: 4 a few light clouds, 3 overcast, 2 rain, 1 a storm with lightning. */
export interface Sky {
  clouds: number
  /** Cloud colour, light to dark. */
  tone: string
  /** Share of the island the cloud deck covers (0 to 1). */
  cover: number
  rain: number
  lightning: boolean
}

export const SKIES: Record<1 | 2 | 3 | 4, Sky> = {
  4: { clouds: 3, tone: '#f4f7fb', cover: 0.35, rain: 0, lightning: false },
  3: { clouds: 7, tone: '#b9c2cf', cover: 0.75, rain: 0, lightning: false },
  2: { clouds: 9, tone: '#7f8998', cover: 0.9, rain: 260, lightning: false },
  1: { clouds: 11, tone: '#4a5160', cover: 1, rain: 480, lightning: true },
}

/** The worst (lowest-numbered) severity among the open incidents, or null for a clear sky. */
export function worstSeverity(incidents: readonly Pick<IncidentSnapshot, 'severity'>[]): 1 | 2 | 3 | 4 | null {
  if (incidents.length === 0) return null
  return Math.min(4, Math.max(1, Math.min(...incidents.map((i) => i.severity)))) as 1 | 2 | 3 | 4
}

const DECK = 27 // height of the cloud deck above the ground: above the tallest building, below the camera's usual view

/** What a test or a tooltip can read about an island's sky. */
export interface SkyStatus {
  severity: 1 | 2 | 3 | 4 | null
  incidents: number
  clouds: number
  raining: boolean
  stormy: boolean
  /** True during the moment a bolt is on screen. */
  flashing: boolean
}

/**
 * Weather over one island for its open incidents: nothing for a clear sky, otherwise clouds, rain and lightning that follow the worst
 * severity, plus a small board saying how many incidents are open. Only the island it belongs to is affected; the rest of the town stays sunny.
 * Everything is built lazily, so a town with a clear sky pays for none of it.
 */
export class Weather {
  readonly object = new THREE.Group()
  private severity: 1 | 2 | 3 | 4 | null = null
  private count = 0
  private readonly cloudsGroup = new THREE.Group()
  private cloudMeshes: THREE.Mesh[] = []
  private rain: { lines: THREE.LineSegments; drops: Float32Array; speed: Float32Array } | null = null
  private bolt: THREE.Line | null = null
  private flash = 0
  private nextBolt = 2
  private board: { sprite: THREE.Sprite; key: string } | null = null
  private fade = 0
  private readonly material = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true, transparent: true, opacity: 0, depthWrite: false })
  private readonly rng: () => number

  /** `rx` and `rz` are the half sizes of the island's coast; the weather is centred on `centre` (island-local). */
  constructor(id: string, private readonly rx: number, private readonly rz: number, centre = new THREE.Vector3()) {
    this.rng = rng(hashString(`${id}-sky`))
    this.object.position.copy(centre)
    this.object.visible = false
    this.object.add(this.cloudsGroup)
  }

  /** Sets what is overhead. Called with every snapshot. */
  set(incidents: readonly IncidentSnapshot[]): void {
    const severity = worstSeverity(incidents)
    this.count = incidents.length
    if (severity !== this.severity) {
      this.severity = severity
      if (severity) this.shape(SKIES[severity])
    }
    this.updateBoard(incidents)
  }

  status(): SkyStatus {
    const sky = this.severity ? SKIES[this.severity] : null
    return {
      severity: this.severity,
      incidents: this.count,
      clouds: this.severity && this.fade > 0.05 ? this.cloudMeshes.length : 0,
      raining: !!sky && sky.rain > 0 && this.fade > 0.05,
      stormy: !!sky?.lightning,
      flashing: this.flash > 0,
    }
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    const target = this.severity ? 1 : 0
    this.fade = clamp(this.fade + Math.sign(target - this.fade) * Math.min(Math.abs(target - this.fade), dt / 2.5), 0, 1)
    this.object.visible = this.fade > 0.005
    if (!this.object.visible) return
    const sky = SKIES[this.severity ?? 4]

    this.material.opacity = this.fade * (this.severity === 4 ? 0.92 : 0.86)
    // the whole deck drifts slowly round, and each cloud bobs on its own
    this.cloudsGroup.rotation.y = time * 0.025
    this.cloudMeshes.forEach((c, i) => { c.position.y = DECK + Math.sin(time * 0.35 + i * 1.7) * 0.6 })

    if (this.rain) this.fall(dt, sky)
    this.lightning(dt, sky)
    this.fadeBoard(camera)
  }

  /** Builds the clouds and rain for a severity. Done once when the severity changes. */
  private shape(sky: Sky): void {
    for (const c of this.cloudMeshes) { this.cloudsGroup.remove(c); c.geometry.dispose() }
    this.cloudMeshes = []
    this.material.color.set(sky.tone)
    this.material.emissive.set('#000000')
    const reach = Math.max(this.rx, this.rz)
    for (let i = 0; i < sky.clouds; i++) {
      // spread over the island: a ring of clouds, thicker toward the middle for a heavy sky
      const a = this.rng() * Math.PI * 2
      const r = Math.sqrt(this.rng()) * reach * 0.95 * sky.cover
      const mesh = new THREE.Mesh(this.cloud(sky.cover > 0.7 ? 1.3 : 1), this.material)
      mesh.position.set(Math.sin(a) * r, DECK, Math.cos(a) * r * (this.rz / this.rx))
      mesh.rotation.y = this.rng() * Math.PI
      this.cloudsGroup.add(mesh)
      this.cloudMeshes.push(mesh)
    }

    if (this.rain) { this.object.remove(this.rain.lines); this.rain.lines.geometry.dispose(); this.rain = null }
    if (sky.rain > 0) {
      const drops = new Float32Array(sky.rain * 6)
      const speed = new Float32Array(sky.rain)
      for (let i = 0; i < sky.rain; i++) {
        const a = this.rng() * Math.PI * 2
        const r = Math.sqrt(this.rng()) * reach * 0.85
        const x = Math.sin(a) * r, z = Math.cos(a) * r * (this.rz / this.rx), y = this.rng() * DECK
        drops.set([x, y, z, x - 0.12, y - 1.5, z], i * 6)
        speed[i] = 22 + this.rng() * 10
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(drops, 3))
      const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#bcd3f2', transparent: true, opacity: 0.55, depthWrite: false }))
      lines.frustumCulled = false
      this.object.add(lines)
      this.rain = { lines, drops, speed }
    }
  }

  /** A cloud is a handful of flat-shaded blobs fused into one mesh. */
  private cloud(scale: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = []
    const blobs = 4 + Math.floor(this.rng() * 3)
    for (let i = 0; i < blobs; i++) {
      const g = new THREE.IcosahedronGeometry((2.4 + this.rng() * 2.2) * scale, 1)
      g.scale(1.25, 0.7, 1)
      g.translate((i - blobs / 2) * 2.6 * scale + this.rng(), this.rng() * 1.2, (this.rng() - 0.5) * 3.2 * scale)
      parts.push(g)
    }
    return mergeGeometries(parts)!
  }

  private fall(dt: number, sky: Sky): void {
    const { drops, speed, lines } = this.rain!
    for (let i = 0; i < sky.rain; i++) {
      const o = i * 6
      const dy = speed[i] * dt
      drops[o + 1] -= dy
      drops[o + 4] -= dy
      if (drops[o + 4] < 0) {
        const lift = DECK + 1.5
        drops[o + 1] += lift
        drops[o + 4] += lift
      }
    }
    lines.geometry.getAttribute('position').needsUpdate = true
    ;(lines.material as THREE.LineBasicMaterial).opacity = this.fade * 0.55
  }

  /** Every few seconds in a storm the clouds flash and a bolt strikes the island. */
  private lightning(dt: number, sky: Sky): void {
    if (!sky.lightning) {
      this.flash = 0
      this.material.emissive.set('#000000')
      if (this.bolt) this.bolt.visible = false
      return
    }
    this.nextBolt -= dt
    if (this.nextBolt <= 0) {
      this.nextBolt = 2.5 + this.rng() * 4
      this.flash = 0.22
      this.strike()
    }
    this.flash = Math.max(0, this.flash - dt)
    const on = this.flash > 0 ? 1 : 0
    this.material.emissive.set(on ? '#c9d8ff' : '#000000')
    this.material.emissiveIntensity = on * (0.4 + 2 * this.flash)
    if (this.bolt) this.bolt.visible = on > 0
  }

  private strike(): void {
    const reach = Math.max(this.rx, this.rz) * 0.6
    const x = (this.rng() - 0.5) * 2 * reach, z = (this.rng() - 0.5) * 2 * reach * (this.rz / this.rx)
    const points: THREE.Vector3[] = []
    for (let y = DECK - 1, k = 0; y > 0; y -= 3, k++) points.push(new THREE.Vector3(x + (this.rng() - 0.5) * 3 * (k ? 1 : 0), y, z + (this.rng() - 0.5) * 3 * (k ? 1 : 0)))
    points.push(new THREE.Vector3(x, 0.3, z))
    if (!this.bolt) {
      this.bolt = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#f4f8ff', toneMapped: false }))
      this.bolt.frustumCulled = false
      this.object.add(this.bolt)
    }
    this.bolt.geometry.setFromPoints(points)
  }

  // ── the incident board ───────────────────────────────────────────────────

  private updateBoard(incidents: readonly IncidentSnapshot[]): void {
    const sev = this.severity
    if (!sev) return
    if (!this.board) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(320, 96, () => {}), transparent: true, depthTest: false, toneMapped: false }))
      sprite.renderOrder = 11
      sprite.scale.set(7.2, 2.16, 1)
      sprite.position.set(0, DECK - 5, 0)
      this.object.add(sprite)
      this.board = { sprite, key: '' }
    }
    const title = incidents[0]?.title ?? ''
    const key = `${sev}|${incidents.length}|${title}`
    if (key === this.board.key) return
    this.board.key = key
    const tex = (this.board.sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    const colour = { 1: '#ff5a4d', 2: '#ffb830', 3: '#e8d27a', 4: '#9fb4cc' }[sev]
    ctx.clearRect(0, 0, 320, 96)
    ctx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(ctx, 4, 8, 312, 80, 24); ctx.fill()
    ctx.strokeStyle = colour; ctx.lineWidth = 6; ctx.stroke()
    ctx.fillStyle = colour; ctx.font = '800 34px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`SEV ${sev} · ${incidents.length} open`, 160, 50, 290)
    tex.needsUpdate = true
  }

  private fadeBoard(camera: THREE.Camera): void {
    if (!this.board) return
    const d = camera.position.distanceTo(this.board.sprite.getWorldPosition(new THREE.Vector3()))
    // keep it readable from far away without growing huge up close
    const scale = clamp(d / 55, 1, 3)
    this.board.sprite.scale.set(7.2 * scale, 2.16 * scale, 1)
    ;(this.board.sprite.material as THREE.SpriteMaterial).opacity = this.fade
  }

  dispose(): void {
    this.material.dispose()
    for (const c of this.cloudMeshes) c.geometry.dispose()
    this.rain?.lines.geometry.dispose()
    this.bolt?.geometry.dispose()
  }
}
