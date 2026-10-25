import * as THREE from 'three'
import { box, canvasTexture, cyl, flat, roundRect } from '../buildings/mk'
import type { MessagingSnapshot, NodeSnapshot } from '../types'
import { palette } from '../themes/harbour-town/palette'
import { clamp, formatAge, formatRate } from '../visuals'
import { GROUND } from './island'

const CRATE_COLORS = ['#e0573f', '#3f8fd9', '#f2b632', '#4fb37a', '#8e6bd9']

/** What an island's message consumers add up to. Every field is null when no consumer reports it. */
export interface Messaging {
  perSecond: number
  waiting: number | null
  oldestSeconds: number | null
  deadLetters: number | null
  amber: number
  red: number
  /** Topics the island publishes and subscriptions its workers hold, for the board. */
  topics: number
  subscriptions: number
  /** True when a worker still reads the hub's egress topic, the old route. */
  legacy: boolean
}

/** The ids of the island's workers that consume a topic. Only these have a queue and a dead-letter queue. */
export function consumersOf(messaging: MessagingSnapshot | undefined): Set<string> {
  return new Set((messaging?.subscriptions ?? []).map((s) => s.consumer))
}

/** An island has a pier when it publishes a topic or has a worker that subscribes to one. */
export function hasMessaging(messaging: MessagingSnapshot | undefined): boolean {
  return !!messaging && (messaging.topics.length > 0 || messaging.subscriptions.length > 0)
}

/** Adds up the island's consumers: the rate, the queue behind them, the oldest message and the dead-letter queue. */
export function messagingOf(nodes: NodeSnapshot[], messaging?: MessagingSnapshot): Messaging {
  const consumers = consumersOf(messaging)
  const workers = nodes.filter((n) => n.kind === 'Worker' && n.state !== 'Stale' && consumers.has(n.id))
  const sum = (pick: (n: NodeSnapshot) => number | null | undefined) => {
    const v = workers.map(pick).filter((x): x is number => x != null)
    return v.length ? v.reduce((a, b) => a + b, 0) : null
  }
  const oldest = workers.map((n) => n.oldestMessageSeconds).filter((x): x is number => x != null)
  return {
    perSecond: workers.filter((n) => n.state !== 'Down').reduce((a, n) => a + n.requestsPerSecond, 0),
    waiting: sum((n) => n.queueDepth),
    oldestSeconds: oldest.length ? Math.max(...oldest) : null,
    deadLetters: sum((n) => n.deadLetters),
    amber: workers[0]?.backlogAmber ?? 60,
    red: workers[0]?.backlogRed ?? 300,
    topics: messaging?.topics.length ?? 0,
    subscriptions: messaging?.subscriptions.length ?? 0,
    legacy: messaging?.subscriptions.some((x) => x.legacy) ?? false,
  }
}

export const halo = (() => {
  let t: THREE.CanvasTexture | null = null
  return () => t ??= canvasTexture(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64)
  })
})()

/**
 * The messaging end of an island's pier: crates pile up on the quay as the queue grows, a fenced pen holds the
 * broken crates of the dead-letter queue (with a red light that sweeps while it is not empty), and a board reads out
 * the numbers. Everything here comes from the island's consumers; the boats are only a picture of traffic.
 */
export class HarbourStatus {
  readonly group = new THREE.Group()
  private readonly pile: THREE.Mesh[] = []
  private readonly broken: THREE.Mesh[] = []
  private readonly beam: THREE.Mesh
  private readonly bulb: THREE.Mesh
  private readonly glow: THREE.Sprite
  private readonly label: THREE.Sprite
  private readonly pennant: THREE.Group
  private legacy = false
  private labelKey = ''
  private lit = false
  private visibleCrates = 0
  private visibleBroken = 0
  private phase = Math.random() * 6

  constructor(coastX: number, z: number) {
    // crate pile on the quay, in a stack that grows layer by layer
    const base = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]
    const slots: [number, number, number][] = [
      ...base.map(([i, j]) => [i, j, 0] as [number, number, number]),
      [0.5, 0.5, 1], [1.5, 0.5, 1], [1.0, 0.0, 1], [2.0, 0.0, 1],
      [1.0, 0.5, 2], [0.5, 0.5, 2],
      [0.8, 0.5, 3],
    ]
    slots.forEach(([i, j, k], n) => {
      const c = box(0.92, 0.82, 0.92, flat(CRATE_COLORS[n % CRATE_COLORS.length]), { x: coastX - 5.1 + i * 1.0, y: GROUND + 0.1 + k * 0.84 + 0.41 - 0.41, z: z + 1.4 + j * 1.0 })
      c.position.y = GROUND + 0.1 + k * 0.84 + 0.41
      c.castShadow = true
      c.visible = false
      this.pile.push(c)
      this.group.add(c)
    })

    // dead-letter pen
    const px = coastX - 5.2, pz = z - 5.6
    const red = flat('#c8372d'), white = flat('#f4efe2')
    const floor = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.1, 3.6), new THREE.MeshStandardMaterial({ color: '#7d4a44', roughness: 1, flatShading: true }))
    floor.position.set(px, GROUND + 0.02, pz)
    floor.receiveShadow = true
    this.group.add(floor)
    for (const [dx, dz] of [[-2.1, -1.7], [2.1, -1.7], [-2.1, 1.7], [2.1, 1.7]] as const) this.group.add(box(0.18, 1.1, 0.18, red, { x: px + dx, y: GROUND + 0.1 + 0.55, z: pz + dz }))
    for (const y of [0.45, 0.85]) {
      for (const dz of [-1.7, 1.7]) this.group.add(box(4.2, 0.1, 0.07, y > 0.6 ? white : red, { x: px, y: GROUND + 0.1 + y, z: pz + dz }))
      for (const dx of [-2.1, 2.1]) this.group.add(box(0.07, 0.1, 3.4, y > 0.6 ? white : red, { x: px + dx, y: GROUND + 0.1 + y, z: pz }))
    }
    for (let n = 0; n < 8; n++) {
      const c = box(0.8, 0.7, 0.8, flat(n % 2 ? '#6b2c26' : '#8a3a30'), { x: px - 1.2 + (n % 4) * 0.8, y: GROUND + 0.35 + (n > 5 ? 0.55 : 0), z: pz - 0.7 + Math.floor(n / 4) * 1.1 })
      c.rotation.set((n % 3 - 1) * 0.28, n * 0.9, (n % 2 ? 0.22 : -0.18))
      c.castShadow = true
      c.visible = false
      this.broken.push(c)
      this.group.add(c)
    }

    // a red light on a mast that sweeps while the dead-letter queue is not empty
    const mx = px + 2.3, mz = pz + 1.9
    this.group.add(cyl(0.1, 0.14, 3.0, flat('#5a626d'), { x: mx, y: GROUND + 1.5, z: mz }, 8))
    this.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: palette.beacon.off, toneMapped: false }))
    this.bulb.position.set(mx, GROUND + 3.2, mz)
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo(), color: '#ff3d3d', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }))
    this.glow.position.copy(this.bulb.position)
    this.glow.scale.set(3.2, 3.2, 1)
    this.glow.visible = false
    const sweep = new THREE.Shape()
    sweep.moveTo(0, 0); sweep.lineTo(9, -1.7); sweep.lineTo(9, 1.7); sweep.closePath()
    const beamGeo = new THREE.ShapeGeometry(sweep)
    beamGeo.rotateX(-Math.PI / 2)
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: '#ff3d3d', transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }))
    this.beam.position.copy(this.bulb.position)
    this.beam.visible = false
    this.group.add(this.bulb, this.glow, this.beam)

    // an amber pennant on a pole at the pier head: a worker here still reads the hub's egress topic (the old route)
    this.pennant = new THREE.Group()
    const pole = cyl(0.07, 0.09, 4.2, flat('#5a626d'), { y: 2.1 }, 6)
    const cloth = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, -0.9), new THREE.Vector2(1.9, -0.45)])), new THREE.MeshBasicMaterial({ color: '#ffb830', side: THREE.DoubleSide, toneMapped: false }))
    cloth.position.set(0.05, 4.1, 0)
    this.pennant.add(pole, cloth)
    this.pennant.position.set(coastX - 1.4, GROUND, z + 2.4)
    this.pennant.visible = false
    this.group.add(this.pennant)

    // the board
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(448, 190, () => {}), transparent: true, depthTest: false, toneMapped: false }))
    this.label.renderOrder = 10
    this.label.scale.set(4.9, 2.08, 1)
    this.label.center.set(0.5, 0)
    this.label.position.set(coastX - 4.6, GROUND + 4.6, z - 1.2)
    this.group.add(this.label)
  }

  update(m: Messaging, time: number, camera: THREE.Camera): void {
    // crates: log scale so a queue of thousands still fits on the quay
    const crates = m.waiting == null ? 0 : m.waiting < 8 ? 0 : Math.min(this.pile.length, Math.round(Math.log2(m.waiting / 24 + 1) * 2))
    if (crates !== this.visibleCrates) {
      this.visibleCrates = crates
      this.pile.forEach((c, i) => { c.visible = i < crates })
    }
    const broken = m.deadLetters == null || m.deadLetters < 1 ? 0 : Math.min(this.broken.length, Math.ceil(Math.log2(1 + m.deadLetters)))
    if (broken !== this.visibleBroken) {
      this.visibleBroken = broken
      this.broken.forEach((c, i) => { c.visible = i < broken })
    }
    const alarm = (m.deadLetters ?? 0) > 0
    this.lit = alarm
    this.glow.visible = alarm
    this.beam.visible = alarm
    ;(this.bulb.material as THREE.MeshBasicMaterial).color.set(alarm ? '#ff3d3d' : palette.beacon.off)
    if (alarm) {
      this.beam.rotation.y = time * 1.8 + this.phase
      ;(this.glow.material as THREE.SpriteMaterial).opacity = 0.55 + 0.4 * Math.sin(time * 6 + this.phase)
    }
    this.legacy = m.legacy
    this.pennant.visible = m.legacy
    if (m.legacy) this.pennant.rotation.y = Math.sin(time * 1.6 + this.phase) * 0.25
    this.draw(m)
    const trouble = alarm || (m.oldestSeconds ?? 0) >= m.amber
    const d = camera.position.distanceTo(this.label.getWorldPosition(new THREE.Vector3()))
    const opacity = trouble ? 1 : 1 - clamp((d - 70) / 40, 0, 1)
    ;(this.label.material as THREE.SpriteMaterial).opacity = opacity
    this.label.visible = opacity > 0.02
  }

  private draw(m: Messaging): void {
    const key = `${m.topics}/${m.subscriptions}/${m.legacy ? 1 : 0}|${Math.round(m.perSecond)}|${m.waiting == null ? -1 : Math.round(m.waiting / 5)}|${m.oldestSeconds == null ? -1 : Math.round(m.oldestSeconds / 2)}|${m.deadLetters ?? -1}`
    if (key === this.labelKey) return
    this.labelKey = key
    const tex = (this.label.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, 448, 190)
    const late = m.oldestSeconds != null && m.oldestSeconds >= m.amber
    const veryLate = m.oldestSeconds != null && m.oldestSeconds >= m.red
    const dead = (m.deadLetters ?? 0) > 0
    const edge = veryLate || dead ? '#ff5a4d' : late ? '#ffb830' : '#9fb4cc'
    const rows = 2 + (m.waiting != null ? 1 : 0) + (m.deadLetters != null ? 1 : 0)
    const h = 18 + rows * 38
    const y0 = 190 - h - 6
    ctx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(ctx, 4, y0, 440, h, 22); ctx.fill()
    ctx.strokeStyle = edge; ctx.lineWidth = 6; ctx.stroke()
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
    let y = y0 + 32
    ctx.fillStyle = '#fff'; ctx.font = '800 30px system-ui, sans-serif'
    ctx.fillText('PIER', 24, y)
    ctx.fillStyle = '#b8c7da'; ctx.font = '700 26px system-ui, sans-serif'; ctx.textAlign = 'right'
    ctx.fillText(`${formatRate(m.perSecond)} msg/s`, 424, y)
    ctx.textAlign = 'left'
    y += 38
    ctx.fillStyle = m.legacy ? '#ffb830' : '#b8c7da'; ctx.font = '700 26px system-ui, sans-serif'
    ctx.fillText(`${m.topics} topic${m.topics === 1 ? '' : 's'} · reads ${m.subscriptions}${m.legacy ? ' · legacy' : ''}`, 24, y, 400)
    if (m.waiting != null) {
      y += 38
      ctx.fillStyle = veryLate ? '#ff5a4d' : late ? '#ffb830' : '#b8c7da'; ctx.font = '700 26px system-ui, sans-serif'
      ctx.fillText(`waiting ${formatRate(m.waiting)}${m.oldestSeconds != null ? ` · oldest ${formatAge(m.oldestSeconds)}` : ''}`, 24, y, 400)
    }
    if (m.deadLetters != null) {
      y += 38
      ctx.fillStyle = dead ? '#ff5a4d' : '#b8c7da'; ctx.font = '700 26px system-ui, sans-serif'
      ctx.fillText(`DLQ ${formatRate(m.deadLetters)}`, 24, y)
    }
    tex.needsUpdate = true
  }

  get alarming(): boolean {
    return this.lit
  }

  /** What the harbour shows, for tests: crates on the quay, broken crates in the pen, and whether the red light sweeps. */
  status(): { crates: number; brokenCrates: number; alarm: boolean; pennant: boolean } {
    return { crates: this.visibleCrates, brokenCrates: this.visibleBroken, alarm: this.lit, pennant: this.legacy }
  }
}
