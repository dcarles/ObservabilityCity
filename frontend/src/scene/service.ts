import * as THREE from 'three'
import { box, canvasTexture, flat, roundRect } from '../buildings/mk'
import { palette } from '../themes/active'
import type { HealthState, NodeSnapshot } from '../types'
import { worstState } from '../visuals'
import { GROUND } from './island'
import type { Pad } from './plan'

// A service on its island: the low sign in front of its pad and the hedge round it. Both show the service's worst state and both open the
// service inspector when clicked. The pure part (what a service is made of and how it is doing) is separate so it can be tested without a renderer.

export interface ServiceSystem {
  id: string
  name: string
  kind: NodeSnapshot['kind']
  state: HealthState
  requestsPerSecond: number
  errorRate: number
  p99Ms: number
  slaP99Ms: number
  /** Only a data store with a database for each tenant: how many tenants it has and how many are turning requests away. */
  tenants: { total: number; throttled: number } | null
}

export interface ServiceSummary {
  key: string
  name: string
  /** The island the service stands on. */
  group: string
  groupName: string
  /** The worst state of its systems. */
  state: HealthState
  systems: ServiceSystem[]
}

/** What a service is and how it is doing, from the snapshot's nodes. Systems the snapshot no longer has are left out. */
export function summariseService(pad: Pick<Pad, 'key' | 'name' | 'nodes'>, group: string, groupName: string, nodes: ReadonlyMap<string, NodeSnapshot>): ServiceSummary {
  const systems = pad.nodes.map((p) => nodes.get(p.id)).filter((n): n is NodeSnapshot => !!n).map<ServiceSystem>((n) => ({
    id: n.id, name: n.name, kind: n.kind, state: n.state, requestsPerSecond: n.requestsPerSecond, errorRate: n.errorRate, p99Ms: n.p99Ms, slaP99Ms: n.slaP99Ms,
    tenants: n.tenants ? { total: n.tenants.length, throttled: n.tenants.filter((u) => (u.throttled ?? 0) >= n.throttleAmber && (u.throttled ?? 0) > 0).length } : null,
  }))
  return { key: pad.key, name: pad.name, group, groupName, state: worstState(systems.map((s) => s.state)), systems }
}

const LEVEL: Record<HealthState, keyof typeof palette.beacon> = { Healthy: 'green', Degraded: 'amber', Down: 'red', Stale: 'grey' }
const WORD: Record<HealthState, string> = { Healthy: '', Degraded: 'degraded', Down: 'down', Stale: 'no data' }

const SIGN_W = 4.3
const SIGN_H = 0.9

/** The sign and hedge of one pad. Built once with the island; `set` repaints the sign when the service's worst state changes. */
export class ServiceSign {
  readonly object = new THREE.Group()
  /** Invisible boxes over the sign and the hedge: what a click on the service hits. They carry the pad's key. */
  readonly hits: THREE.Mesh[] = []
  state: HealthState | null = null
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: THREE.CanvasTexture

  /** `x` and `zFront` are the pad's centre and its front edge in island space. */
  constructor(readonly pad: Pad, x: number, zFront: number, depth: number, width: number) {
    this.tex = canvasTexture(512, 108, () => {})
    this.ctx = (this.tex.image as HTMLCanvasElement).getContext('2d')!
    const face = new THREE.Mesh(new THREE.PlaneGeometry(SIGN_W, SIGN_H), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false }))
    face.position.set(0, 0.62 + SIGN_H / 2, 0.075)
    const board = box(SIGN_W + 0.15, SIGN_H + 0.1, 0.12, flat('#f7f0df', { roughness: 0.9 }), { y: 0.57 })
    const legs = [-1, 1].map((s) => box(0.14, 0.62, 0.14, flat(palette.woodDark), { x: s * (SIGN_W / 2 - 0.5) }))
    const sign = new THREE.Group()
    sign.add(board, face, ...legs)
    sign.position.set(x, GROUND + 0.1, zFront - 0.55)
    this.object.add(sign)
    this.hits.push(this.hitBox(SIGN_W + 0.4, 1.8, 0.8, x, GROUND + 0.9, zFront - 0.55))
    // three sides of hedge, open at the front
    const hedge = flat(palette.hedge, { roughness: 1 })
    const t = 0.7, h = 0.85
    const back = box(width - 0.4, h, t, hedge, { x, y: GROUND + 0.08, z: zFront - depth + t })
    const left = box(t, h, depth - 2.4, hedge, { x: x - width / 2 + 0.55, y: GROUND + 0.08, z: zFront - depth / 2 - 1.1 })
    const right = box(t, h, depth - 2.4, hedge, { x: x + width / 2 - 0.55, y: GROUND + 0.08, z: zFront - depth / 2 - 1.1 })
    this.object.add(back, left, right)
    this.hits.push(
      this.hitBox(width - 0.4, 1.4, t + 0.4, x, GROUND + 0.7, zFront - depth + t),
      this.hitBox(t + 0.4, 1.4, depth - 2.4, x - width / 2 + 0.55, GROUND + 0.7, zFront - depth / 2 - 1.1),
      this.hitBox(t + 0.4, 1.4, depth - 2.4, x + width / 2 - 0.55, GROUND + 0.7, zFront - depth / 2 - 1.1),
    )
    this.set('Stale')
  }

  private hitBox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }))
    m.position.set(x, y, z)
    m.userData.serviceKey = this.pad.key
    this.object.add(m)
    return m
  }

  /** Paints the sign for a state. Nothing happens when it is already showing it. */
  set(state: HealthState): void {
    if (state === this.state) return
    this.state = state
    const color = palette.beacon[LEVEL[state]]
    const { ctx } = this
    ctx.clearRect(0, 0, 512, 108)
    ctx.fillStyle = '#f7f0df'; roundRect(ctx, 4, 4, 504, 100, 20); ctx.fill()
    ctx.strokeStyle = color; ctx.lineWidth = state === 'Healthy' ? 6 : 12; ctx.stroke()
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(52, 54, 22, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#26364f'; ctx.font = '800 46px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    const word = WORD[state]
    ctx.fillText(this.pad.name, 92, word ? 44 : 56, 392)
    if (word) { ctx.fillStyle = state === 'Stale' ? '#6c7480' : '#b3541e'; ctx.font = '800 30px system-ui, sans-serif'; ctx.fillText(word.toUpperCase(), 92, 82, 392) }
    this.tex.needsUpdate = true
  }
}
