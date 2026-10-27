import * as THREE from 'three'
import type { NodeSnapshot } from '../types'
import { isAbsent, isUnmonitored } from '../signals'
import { beaconLevel, clamp, darkFloorsFor, floorsFor, formatAge, formatMs, formatRate, lerp, MAX_FLOORS, plaqueText, type BeaconLevel } from '../visuals'
import { buildModel, palette } from '../themes/active'
import type { BuildingModel, FloorModule, TenantYardStatus } from './model'
import { ALL_TENANTS, type TenantView } from '../tenants'
import { canvasTexture, roundRect } from './mk'

/** What a building shows, for tests. See Building.status. */
export interface BuildingStatus {
  id: string
  kind: NodeSnapshot['kind']
  state: NodeSnapshot['state']
  beacon: BeaconLevel
  /** True while the beacon shows a steady light instead of pulsing: a system that is down. */
  beaconSteady: boolean
  floors: number
  darkFloors: number
  litFloors: number
  closedSign: boolean
  /** Only data stores have a barrier: down while they turn requests away. */
  barrierDown: boolean | null
  plaque: string
  /** Too few calls to judge errors and latency: the building stays as it is and says so. */
  quiet: boolean
  /** Only a data store with a database for each tenant: its units and sign. Null for every other building. */
  tenants: TenantYardStatus | null
}

interface FloorState {
  module: FloorModule
  /** 0 = not built, 1 = full height. Eased, so floors rise and sink instead of popping. */
  height: number
  dark: number
}

const haloTexture = (() => {
  let t: THREE.CanvasTexture | null = null
  return () => (t ??= canvasTexture(128, 128, (ctx) => {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
  }))
})()

/**
 * One system or hub resource as a building. It owns the floors, the lit windows, the rooftop beacon, the
 * instance plaque and the "closed" sign, and eases all of them toward the latest snapshot.
 */
export class Building {
  readonly root = new THREE.Group()
  readonly pivot = new THREE.Group()
  readonly model: BuildingModel
  node: NodeSnapshot | null = null

  /** Smoothed numbers, so a new snapshot glides in instead of snapping. */
  private lit = 0.3
  private stale = 0
  private errorRate = 0
  private floorsWanted = 1
  private darkWanted = 0
  private readonly floors: FloorState[] = []
  private readonly roof: THREE.Object3D
  private readonly bulb: THREE.Mesh
  private readonly halo: THREE.Sprite
  private readonly beaconAnchor = new THREE.Group()
  private level: BeaconLevel = 'green'
  private pulsePhase = Math.random() * 6
  private readonly plaque: THREE.Mesh
  private plaqueCanvas: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null = null
  private plaqueKey = ''
  private readonly closedSign: THREE.Group
  private label: THREE.Sprite | null = null
  private labelKey = ''
  private extra: { text: string; hot: boolean } | null = null
  readonly hit: THREE.Mesh
  /** True while the building is selected: its name board stays readable from any distance. */
  pinned = false
  private gate: { arm: THREE.Group } | null = null
  private gateAngle = Math.PI / 2

  /** What the viewer chose to see of the tenants. Only a tenant yard looks at it. */
  private tenantView: TenantView = ALL_TENANTS

  /** `name` is the system's own name; a broker's port sign reads it. */
  constructor(readonly id: string, readonly kind: NodeSnapshot['kind'], accent: string, tenanted = false, name?: string) {
    this.model = buildModel(kind, accent, { tenanted, name })
    const m = this.model
    this.pivot.add(m.base)
    for (let i = 0; i < MAX_FLOORS; i++) {
      const module = m.makeFloor(i)
      module.object.visible = false
      this.floors.push({ module, height: 0, dark: 0 })
      this.pivot.add(module.object)
    }
    this.roof = m.roof
    this.pivot.add(this.roof)

    // Beacon: a bulb on a mast, plus a halo that stays readable from far away.
    this.bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 14, 10),
      new THREE.MeshBasicMaterial({ color: palette.beacon.green, toneMapped: false }),
    )
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTexture(), color: palette.beacon.green, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }))
    this.beaconAnchor.add(this.bulb, this.halo)
    this.roof.add(this.beaconAnchor)
    this.beaconAnchor.position.copy(m.beaconAt)

    this.plaque = this.makePlaque()
    this.pivot.add(this.plaque)

    this.closedSign = this.makeClosedSign()
    this.closedSign.visible = false
    this.pivot.add(this.closedSign)

    if (kind === 'Database') this.gate = this.makeGate()

    this.hit = new THREE.Mesh(new THREE.CylinderGeometry(m.radius, m.radius, 1, 8), new THREE.MeshBasicMaterial({ visible: false }))
    this.hit.userData.building = this
    this.pivot.add(this.hit)

    this.root.add(this.pivot)
  }

  /** World position of the door. Valid once the building has been added to the scene and placed. */
  doorWorld(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false)
    return this.pivot.localToWorld(this.model.door.clone())
  }

  doorDirWorld(): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false)
    const q = new THREE.Quaternion()
    this.pivot.getWorldQuaternion(q)
    return this.model.doorDir.clone().applyQuaternion(q)
  }

  /** True for a data store that has a unit for each tenant. */
  get tenanted(): boolean {
    return this.model.setTenants !== undefined
  }

  setTenantView(view: TenantView): void {
    this.tenantView = view
    if (this.node) this.model.setTenants?.(this.node.tenants ?? [], this.node.throttleAmber, view)
  }

  setNode(n: NodeSnapshot): void {
    const first = this.node === null
    this.node = n
    this.model.setTenants?.(n.tenants ?? [], n.throttleAmber, this.tenantView)
    this.floorsWanted = this.model.fixedFloors ?? floorsFor(n.instancesTotal || 1)
    this.darkWanted = n.state === 'Down' ? this.floorsWanted : darkFloorsFor(n.instancesTotal, n.instancesHealthy, this.floorsWanted)
    if (first) {
      // Appear fully formed on the first snapshot.
      this.lit = n.state === 'Healthy' || n.state === 'Degraded' ? this.litTarget(n) : 0
      this.errorRate = n.errorRate
      this.stale = isGrey(n) ? 1 : 0
      this.floors.forEach((f, i) => {
        f.height = i < this.floorsWanted ? 1 : 0
        f.dark = i >= this.floorsWanted - this.darkWanted && i < this.floorsWanted ? 1 : 0
      })
    }
    this.updatePlaque()
    this.updateLabel()
    this.closedSign.visible = n.state === 'Down'
    this.model.setRunning?.(n.state !== 'Down')
  }

  /** Called every frame. */
  update(dt: number, time: number, camera: THREE.Camera): void {
    const n = this.node
    if (!n) return
    const ease = (rate: number) => 1 - Math.exp(-rate * dt)

    const live = n.state === 'Healthy' || n.state === 'Degraded'
    this.lit = lerp(this.lit, live ? this.litTarget(n) : 0, ease(1.5))
    this.model.setActivity?.(n.cpu ?? clamp(n.load * 0.6, 0, 1))
    this.updateGate(n, dt)
    this.stale = lerp(this.stale, isGrey(n) ? 1 : 0, ease(3))
    this.errorRate = lerp(this.errorRate, n.errorRate, ease(2))

    // Floors: rise and sink toward the wanted count; the top ones go dark for unhealthy instances.
    let y = this.model.baseHeight
    const fh = this.model.floorHeight
    this.floors.forEach((f, i) => {
      const built = i < this.floorsWanted
      f.height = lerp(f.height, built ? 1 : 0, ease(2.5))
      if (Math.abs(f.height - (built ? 1 : 0)) < 0.004) f.height = built ? 1 : 0
      const isDark = built && i >= this.floorsWanted - this.darkWanted
      f.dark = lerp(f.dark, isDark ? 1 : 0, ease(3))
      const obj = f.module.object
      obj.visible = f.height > 0.01
      // Scale the floor's height; the floor module's origin is at its bottom.
      obj.scale.y = Math.max(0.001, f.height)
      obj.position.y = y
      y += fh * f.height
      const u = f.module.uniforms
      // lights come on one floor at a time from the bottom, as the busy share climbs
      u.uLit.value = clamp(this.lit * Math.max(1, this.floorsWanted) - i, 0, 1)
      u.uDark.value = f.dark
      u.uStale.value = this.stale
    })
    this.roof.position.y = y

    this.updateBeacon(n, time, camera)
    this.model.animate?.(time, dt)
    this.hit.scale.y = y + 2
    this.hit.position.y = (y + 2) / 2
    if (this.label) this.label.position.set(0, y + 3.4, 0)
    this.fadeLabel(camera)
    this.closedSign.visible = n.state === 'Down'
  }

  /**
   * What the building shows right now, as plain values: the beacon colour, how many floors are dark, whether the closed
   * sign is up and the barrier is down. Automated tests read this instead of pixels.
   */
  status(): BuildingStatus | null {
    const n = this.node
    if (!n) return null
    return {
      id: this.id,
      kind: this.kind,
      state: n.state,
      beacon: this.level,
      beaconSteady: n.state === 'Down',
      floors: this.floorsWanted,
      darkFloors: this.darkWanted,
      litFloors: Math.round(this.lit * this.floorsWanted * 100) / 100,
      closedSign: this.closedSign.visible,
      barrierDown: this.gate ? this.gateAngle < 0.4 : null,
      plaque: plaqueText(n),
      quiet: n.quiet === true,
      tenants: this.model.tenantStatus?.() ?? null,
    }
  }

  /** How busy the building is, 0 to 1: CPU for apps, utilisation for data stores, load for the rest. Lights switch on floor by floor to match. */
  private litTarget(n: NodeSnapshot): number {
    return clamp(n.cpu ?? n.utilisation ?? n.load * 0.6, 0.06, 1)
  }

  /** A barrier across a data store's drive that comes down while it is turning requests away. */
  private updateGate(n: NodeSnapshot, dt: number): void {
    if (!this.gate) return
    const closed = n.state !== 'Down' && (n.throttled ?? 0) >= n.throttleAmber
    this.gateAngle = lerp(this.gateAngle, closed ? 0 : Math.PI / 2, 1 - Math.exp(-4 * dt))
    this.gate.arm.rotation.z = this.gateAngle
  }

  private updateBeacon(n: NodeSnapshot, time: number, camera: THREE.Camera): void {
    this.level = beaconLevel({ ...n, errorRate: this.errorRate })
    const color = new THREE.Color(palette.beacon[this.level])
    this.halo.visible = this.level !== 'off'
    let pulse = 1
    if (n.state === 'Down') pulse = 1 // down is a steady red: it is not an alarm that flickers, the building is shut
    else if (this.level === 'red') pulse = 0.65 + 0.35 * Math.sin(time * 7 + this.pulsePhase)
    else if (this.level === 'amber') pulse = 0.8 + 0.2 * Math.sin(time * 2.5 + this.pulsePhase)
    else if (this.level === 'green') pulse = 0.9

    ;(this.bulb.material as THREE.MeshBasicMaterial).color.copy(color).multiplyScalar(0.55 + 0.9 * pulse)
    const haloMat = this.halo.material as THREE.SpriteMaterial
    haloMat.color.copy(color)
    haloMat.opacity = this.level === 'grey' || this.level === 'off' ? 0 : 0.35 + 0.5 * pulse

    // Keep the halo readable from far away: a minimum size on screen, bigger for the alarming colours.
    const world = this.beaconAnchor.getWorldPosition(new THREE.Vector3())
    const dist = camera.position.distanceTo(world)
    const bigger = this.level === 'red' ? 1.5 : this.level === 'amber' ? 1.2 : 1
    const size = Math.max(1.6, dist * 0.022) * bigger
    this.halo.scale.setScalar(size * (0.85 + 0.25 * pulse))
    // keep the bulb itself visible from afar too
    this.bulb.scale.setScalar(clamp(dist / 55, 1, 2.6))
  }

  // ── plaque, label, closed sign ────────────────────────────────────────────

  private makePlaque(): THREE.Mesh {
    const { position, width, rotY } = this.model.plaque
    const tex = canvasTexture(256, 96, () => {})
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width * 1.35, width * 1.35 * (96 / 256)),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
    )
    mesh.position.copy(position)
    mesh.rotation.y = rotY ?? 0
    this.plaqueCanvas = { ctx: (tex.image as HTMLCanvasElement).getContext('2d')!, tex }
    return mesh
  }

  private updatePlaque(): void {
    const n = this.node
    if (!n || !this.plaqueCanvas) return
    const text = plaqueText(n)
    const warn = isGrey(n) ? 'stale' : n.instancesHealthy < n.instancesTotal || n.state === 'Down' ? 'warn' : 'ok'
    const key = `${text}|${warn}`
    if (key === this.plaqueKey) return
    this.plaqueKey = key
    const { ctx, tex } = this.plaqueCanvas
    ctx.clearRect(0, 0, 256, 96)
    ctx.fillStyle = warn === 'warn' ? '#3a2a14' : warn === 'stale' ? '#3a3f46' : '#1f2b3a'
    roundRect(ctx, 4, 4, 248, 88, 16); ctx.fill()
    ctx.strokeStyle = warn === 'warn' ? '#ffb830' : warn === 'stale' ? '#8d949e' : '#cfd9e6'
    ctx.lineWidth = 5; ctx.stroke()
    ctx.fillStyle = warn === 'warn' ? '#ffd27a' : '#f4f7fb'
    ctx.font = '700 40px system-ui, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(text, 128, 50)
    tex.needsUpdate = true
  }

  /** Striped barrier arm hinged on a post beside the drive. Up when requests flow, down when they are throttled. */
  private makeGate(): { arm: THREE.Group } {
    const g = new THREE.Group()
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 1.1, 0.24), new THREE.MeshStandardMaterial({ color: '#f2c230', flatShading: true }))
    post.position.y = 0.55
    post.castShadow = true
    const arm = new THREE.Group()
    arm.position.y = 0.95
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.12), new THREE.MeshStandardMaterial({ color: i % 2 ? '#f5f5f5' : '#d63a2f', flatShading: true }))
      seg.position.x = 0.3 + i * 0.5
      seg.castShadow = true
      arm.add(seg)
    }
    g.add(post, arm)
    const d = this.model.door
    g.position.set(d.x - 1.6, 0.08, d.z - 0.4)
    this.pivot.add(g)
    return { arm }
  }

  private makeClosedSign(): THREE.Group {
    const g = new THREE.Group()
    const tex = canvasTexture(256, 128, (ctx) => {
      ctx.fillStyle = '#fff4d6'; roundRect(ctx, 4, 4, 248, 120, 14); ctx.fill()
      ctx.strokeStyle = '#d63a2f'; ctx.lineWidth = 8; ctx.stroke()
      ctx.fillStyle = '#d63a2f'; ctx.font = '800 40px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('CLOSED FOR', 128, 46); ctx.fillText('REPAIRS', 128, 90)
    })
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }))
    sign.position.set(0, 1.9, 0)
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6), new THREE.MeshStandardMaterial({ color: '#555' }))
    post.position.y = 0.75
    const stripe = (x: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.12), new THREE.MeshStandardMaterial({ color: '#f5f5f5' }))
      b.position.set(x, 0.55, 0.0)
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.19, 0.13), new THREE.MeshStandardMaterial({ color: '#d63a2f' }))
      r.position.set(x - 0.5, 0.55, 0)
      const r2 = r.clone(); r2.position.x = x + 0.5
      return [b, r, r2]
    }
    g.add(sign, post, ...stripe(-1.0), ...stripe(1.0))
    const d = this.model.door
    const dir = this.model.doorDir
    g.position.set(d.x + dir.x * 1.6, 0.4, d.z + dir.z * 1.6)
    g.rotation.y = Math.atan2(dir.x, dir.z)
    return g
  }

  /**
   * Every building carries a billboard with its name and instance count, plus the meters that matter for its kind:
   * CPU and memory for services, utilisation and throttling for data stores. It fades out when the camera is
   * far away, except for troubled buildings.
   */
  /** One more line at the foot of the billboard (the broker's counts), or none. */
  setExtra(line: { text: string; hot: boolean } | null): void {
    if (this.extra?.text === line?.text && this.extra?.hot === line?.hot) return
    this.extra = line
    this.updateLabel()
  }

  /** The extra line as drawn, for tests. */
  extraLine(): string | null {
    return this.extra?.text ?? null
  }

  private updateLabel(): void {
    const n = this.node
    if (!n) return
    const text = plaqueText(n)
    const pct = (v: number | null | undefined) => (v == null ? -1 : Math.round(v * 100))
    const unmonitored = isUnmonitored(n)
    const warn = n.state === 'Down' ? 'down' : isGrey(n) ? 'stale' : !unmonitored && (n.state !== 'Healthy' || n.instancesHealthy < n.instancesTotal) ? 'warn' : 'ok'
    const live = n.state !== 'Stale' && n.state !== 'Down'
    // the error bar and the p99 note are drawn only for what a source supplies
    const hasHealth = live && (!isAbsent(n, 'errors') || !isAbsent(n, 'latency'))
    const key = [n.name, text, warn, pct(n.cpu), pct(n.memory), pct(n.utilisation), Math.round((n.throttled ?? 0) * 1000),
      Math.round(n.errorRate * 1000), Math.round(n.p99Ms / 10), Math.round((n.queueDepth ?? -1) / 5), Math.round((n.oldestMessageSeconds ?? -1) / 2), n.deadLetters ?? -1, this.extra?.text ?? '', this.extra?.hot ?? ''].join('|')
    const hasMeters = live && (n.cpu != null || n.utilisation != null)
    const hasQueue = live && n.queueDepth != null
    if (!this.label) {
      const tex = canvasTexture(512, 256, () => {})
      this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }))
      this.label.renderOrder = 10
      this.label.scale.set(4.8, 2.4, 1)
      this.label.center.set(0.5, 0)
      this.root.add(this.label)
    }
    if (key === this.labelKey) return
    this.labelKey = key
    const tex = (this.label.material as THREE.SpriteMaterial).map as THREE.CanvasTexture
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!
    ctx.clearRect(0, 0, 512, 256)
    const color = { down: '#d63a2f', stale: '#8d949e', warn: '#e8a21a', ok: '#9fb4cc' }[warn]
    const rows = (hasMeters ? 1 : 0) + (hasHealth ? 1 : 0) + (hasQueue ? 1 : 0) + (this.extra ? 1 : 0)
    const h = 116 + rows * 38
    const y0 = 256 - h - 6
    ctx.fillStyle = 'rgba(20,28,40,0.9)'; roundRect(ctx, 4, y0, 504, h, 24); ctx.fill()
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.stroke()
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillStyle = '#fff'; ctx.font = '700 46px system-ui, sans-serif'
    ctx.fillText(n.name, 256, y0 + 42, 470)
    ctx.fillStyle = warn === 'ok' ? '#b8c7da' : color; ctx.font = '600 32px system-ui, sans-serif'
    ctx.fillText(text, 256, y0 + 84, 470)
    let top = y0 + 110
    const bar = (x: number, w: number, label: string, v: number, shown: string, amber: number, red: number | null) => {
      ctx.fillStyle = 'rgba(255,255,255,0.14)'; roundRect(ctx, x, top, w, 28, 10); ctx.fill()
      const fill = clamp(v, 0, 1)
      ctx.fillStyle = red !== null && v >= red ? '#ff5a4d' : v >= amber ? '#ffb830' : '#47e07a'
      if (fill > 0.01) { roundRect(ctx, x, top, Math.max(14, w * fill), 28, 10); ctx.fill() }
      ctx.fillStyle = '#fff'; ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(`${label} ${shown}`, x + 12, top + 15, w - 16)
    }
    const note = (x: number, text2: string, hot: boolean) => {
      ctx.fillStyle = hot ? '#ff5a4d' : '#b8c7da'; ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'left'
      ctx.fillText(text2, x, top + 15, 190)
    }
    if (hasMeters) {
      if (n.utilisation != null) {
        const t = n.throttled ?? 0
        bar(24, 270, n.kind === 'Database' ? 'USED' : 'UTIL', n.utilisation, `${Math.round(n.utilisation * 100)}%`, n.resourceAmber, n.resourceRed)
        note(312, t >= n.throttleAmber ? `THROTTLED ${(t * 100).toFixed(1)}%` : 'no throttling', t >= n.throttleAmber)
      } else {
        bar(24, 224, 'CPU', n.cpu ?? 0, `${Math.round((n.cpu ?? 0) * 100)}%`, n.resourceAmber, n.resourceRed)
        if (n.memory != null) bar(264, 224, 'MEM', n.memory, `${Math.round(n.memory * 100)}%`, n.resourceAmber, n.resourceRed)
      }
      top += 38
    }
    if (hasHealth) {
      // errors (5xx, timeouts) as a share of requests, and how the slowest requests compare with the target
      if (!isAbsent(n, 'errors')) bar(24, 224, 'ERR', n.errorRate / Math.max(n.errorRed * 1.5, 0.001), `${(n.errorRate * 100).toFixed(n.errorRate < 0.1 ? 1 : 0)}%`, n.errorAmber / Math.max(n.errorRed * 1.5, 0.001), n.errorRed / Math.max(n.errorRed * 1.5, 0.001))
      if (!isAbsent(n, 'latency')) note(isAbsent(n, 'errors') ? 24 : 264, `p99 ${formatMs(n.p99Ms)} / ${formatMs(n.slaP99Ms)}`, n.p99Ms > n.slaP99Ms)
      top += 38
    }
    if (hasQueue) {
      const late = (n.oldestMessageSeconds ?? 0) >= n.backlogAmber
      note(24, `QUEUE ${formatRate(n.queueDepth ?? 0)}${n.oldestMessageSeconds ? ` · oldest ${formatAge(n.oldestMessageSeconds)}` : ''}`, late)
      note(300, `DLQ ${formatRate(n.deadLetters ?? 0)}`, (n.deadLetters ?? 0) > 0)
      top += 38
    }
    if (this.extra) {
      ctx.fillStyle = this.extra.hot ? '#ffb830' : '#b8c7da'; ctx.font = '700 22px system-ui, sans-serif'; ctx.textAlign = 'center'
      ctx.fillText(this.extra.text, 256, top + 15, 470)
    }
    tex.needsUpdate = true
  }

  private fadeLabel(camera: THREE.Camera): void {
    if (!this.label || !this.node) return
    const troubled = !isUnmonitored(this.node) && (this.node.state !== 'Healthy' || this.node.instancesHealthy < this.node.instancesTotal)
    const d = camera.position.distanceTo(this.label.getWorldPosition(new THREE.Vector3()))
    const far = clamp((d - 75) / 40, 0, 1)
    const opacity = troubled || this.pinned ? 1 : 1 - far
    ;(this.label.material as THREE.SpriteMaterial).opacity = opacity
    this.label.visible = opacity > 0.02
  }
}

/** Grey means a source is configured and has nothing fresh to say. A system no source is configured for is not grey: it simply has no readings. */
function isGrey(n: NodeSnapshot): boolean {
  return n.state === 'Stale' && !isUnmonitored(n)
}
