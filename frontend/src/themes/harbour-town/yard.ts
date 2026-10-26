import * as THREE from 'three'
import type { BuildingModel, TenantYardStatus } from '../../buildings/model'
import type { TenantUnitSnapshot } from '../../types'
import { at, box, canvasTexture, cyl, flat, group, roundRect } from '../../buildings/mk'
import { isShown, isThrottled, fillOf, tenantLevel, yardLayout, yardSummary, type TenantLevel, type TenantView } from '../../tenants'

const W = 7.0
const D = 6.4
/** The yard's floor, where the units stand. */
const FLOOR = 0.34
/** Tallest a unit gets, at full use of its capacity, and the shortest one a quiet database stands. */
const TALL = 2.9
const SHORT = 0.55
/** Where the units may stand: inside the fence, clear of the gate at the front. */
const AREA_W = W - 1.2
const AREA_D = D - 2.4

const COLOURS: Record<TenantLevel, string> = { green: '#6fb7de', amber: '#ffb830', red: '#e5484d', grey: '#aeb6bf' }
/** A test tenant's pale cousin of each colour. */
const PALE: Record<TenantLevel, string> = { green: '#cfe6f3', amber: '#ffe3a8', red: '#f6b9bb', grey: '#dde1e5' }
const UNKNOWN = '#b49cf0'

const stripes = (() => {
  const cache = new Map<string, THREE.CanvasTexture>()
  return (color: string) => {
    let t = cache.get(color)
    if (!t) {
      t = canvasTexture(64, 64, (ctx) => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64)
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 9
        for (let i = -64; i < 128; i += 22) { ctx.beginPath(); ctx.moveTo(i, 64); ctx.lineTo(i + 64, 0); ctx.stroke() }
      })
      t.wrapS = t.wrapT = THREE.RepeatWrapping
      cache.set(color, t)
    }
    return t
  }
})()

const questionMark = (() => {
  let t: THREE.CanvasTexture | null = null
  return () => (t ??= canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = UNKNOWN; ctx.fillRect(0, 0, 64, 64)
    ctx.fillStyle = '#ffffff'; ctx.font = '800 54px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('?', 32, 36)
  }))
})()

interface Unit {
  id: string
  object: THREE.Group
  body: THREE.Mesh
  frame: THREE.LineSegments
  material: THREE.MeshStandardMaterial
  data: TenantUnitSnapshot
  level: TenantLevel
  throttled: boolean
  shown: boolean
  dimmed: boolean
  fill: number
  /** Eased height as a share of TALL, so a unit grows and sinks instead of jumping. */
  height: number
  size: number
}

/**
 * A data store that keeps one database per tenant, as a fenced yard of storage units, one for each tenant. A unit's height is how much of
 * its capacity its database uses; its colour is its state (blue, amber, red, grey for no data). A test tenant's unit is paler and striped,
 * a tenant the environment does not list carries a question mark. A sign on a post says how many tenants there are and how many throttle.
 */
export function storageYard(accent: string): BuildingModel {
  const slab = flat('#8b95a0'), gravel = flat('#b3bac2'), rail = flat('#d9dee3'), post = flat('#6b7682')
  const base = group(
    box(W, FLOOR - 0.04, D, slab),
    box(W - 0.5, 0.05, D - 0.5, gravel, { y: FLOOR - 0.05 }),
    // office at the front right, like a storage building's: a door and a canopy in the island's colour
    box(1.7, 1.5, 1.1, flat('#eef2f5'), { x: W / 2 - 1.25, y: FLOOR, z: D / 2 - 0.55 }),
    box(0.9, 1.2, 0.12, flat('#2f3a46', { roughness: 0.4 }), { x: W / 2 - 1.25, y: FLOOR, z: D / 2 + 0.03 }),
    box(1.9, 0.12, 1.3, flat(accent), { x: W / 2 - 1.25, y: FLOOR + 1.5, z: D / 2 - 0.45 }),
    box(W + 1.2, 0.08, 1.8, flat('#cfc8b8'), { z: D / 2 + 1.0 }),
  )
  // the fence: posts and a rail along the back and both sides, open at the front
  const fence = group()
  const stand = (x: number, z: number) => fence.add(cyl(0.07, 0.07, 1.15, post, { x, y: FLOOR, z }, 6))
  for (let x = -W / 2 + 0.2; x <= W / 2 - 0.2 + 1e-6; x += (W - 0.4) / 4) stand(x, -D / 2 + 0.2)
  for (let z = -D / 2 + 0.2; z <= D / 2 - 1.4; z += (D - 1.6) / 3) { stand(-W / 2 + 0.2, z); stand(W / 2 - 0.2, z) }
  fence.add(
    box(W - 0.4, 0.07, 0.07, rail, { x: 0, y: FLOOR + 0.95, z: -D / 2 + 0.2 }),
    box(W - 0.4, 0.07, 0.07, rail, { x: 0, y: FLOOR + 0.5, z: -D / 2 + 0.2 }),
    box(0.07, 0.07, D - 1.6, rail, { x: -W / 2 + 0.2, y: FLOOR + 0.95, z: -0.4 }),
    box(0.07, 0.07, D - 1.6, rail, { x: W / 2 - 0.2, y: FLOOR + 0.95, z: -0.4 }),
  )
  base.add(fence)

  const yard = group()
  yard.position.y = FLOOR
  yard.position.z = -0.7
  base.add(yard)

  // the sign: a board on a post at the front left, facing the road
  const signTex = canvasTexture(512, 160, () => {})
  const signCtx = (signTex.image as HTMLCanvasElement).getContext('2d')!
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.125), new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false, side: THREE.DoubleSide }))
  board.position.set(0, 2.55, 0)
  const signPost = cyl(0.07, 0.07, 2.2, post, { y: 0 }, 6)
  const sign = group(signPost, board)
  sign.position.set(-W / 2 + 1.3, FLOOR, D / 2 - 0.2)
  base.add(sign)
  let signKey = ''
  const paintSign = (text: string, note: string, hot: boolean) => {
    const key = `${text}|${note}|${hot}`
    if (key === signKey) return
    signKey = key
    signCtx.clearRect(0, 0, 512, 160)
    signCtx.fillStyle = 'rgba(20,28,40,0.92)'; roundRect(signCtx, 4, 4, 504, 152, 24); signCtx.fill()
    signCtx.strokeStyle = hot ? '#ffb830' : '#9fb4cc'; signCtx.lineWidth = 7; signCtx.stroke()
    signCtx.textAlign = 'center'; signCtx.textBaseline = 'middle'
    signCtx.fillStyle = hot ? '#ffd27a' : '#fff'; signCtx.font = '800 50px system-ui, sans-serif'
    signCtx.fillText(text, 256, note ? 62 : 80, 480)
    if (note) { signCtx.fillStyle = '#b8c7da'; signCtx.font = '700 34px system-ui, sans-serif'; signCtx.fillText(note, 256, 116, 480) }
    signTex.needsUpdate = true
  }
  paintSign('no tenants', '', false)

  const roof = group(at(cyl(0.07, 0.09, 3.4, flat('#8a949e'), {}, 6), W / 2 - 0.4, 0, -D / 2 + 0.5))
  const units = new Map<string, Unit>()
  let status: TenantYardStatus = { units: [], sign: { text: 'no tenants', note: '' } }
  let view: TenantView = { hideTest: false, tenant: null }
  let pulse = 0

  const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, TALL, 1))
  frameGeo.translate(0, TALL / 2, 0)
  const frameMat = new THREE.LineBasicMaterial({ color: '#7d8a97', transparent: true, opacity: 0.55 })

  function materialFor(u: TenantUnitSnapshot, level: TenantLevel): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.7, emissive: '#000000' })
    paint(m, u, level)
    return m
  }

  function paint(m: THREE.MeshStandardMaterial, u: TenantUnitSnapshot, level: TenantLevel): void {
    if (u.kind === 'Test') { m.map = stripes(PALE[level]); m.color.set('#ffffff') }
    else if (u.kind === 'Unknown') { m.map = questionMark(); m.color.set(level === 'green' ? '#ffffff' : COLOURS[level]) }
    else { m.map = null; m.color.set(COLOURS[level]) }
    m.needsUpdate = true
  }

  function build(u: TenantUnitSnapshot): Unit {
    const level = tenantLevel(u)
    const material = materialFor(u, level)
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material)
    body.castShadow = true
    body.receiveShadow = true
    // the frame shows how tall the unit could get; the body inside it, how tall it is
    const frame = new THREE.LineSegments(frameGeo, frameMat)
    const object = group(body, frame)
    yard.add(object)
    return { id: u.id, object, body, frame, material, data: u, level, throttled: false, shown: true, dimmed: false, fill: 0, height: fillOf(u), size: 1 }
  }

  function apply(list: readonly TenantUnitSnapshot[], throttleAmber: number): void {
    // units come and go with the tenants the data shows
    const wanted = new Set(list.map((u) => u.id))
    for (const [id, unit] of units) {
      if (wanted.has(id)) continue
      yard.remove(unit.object)
      unit.material.dispose()
      units.delete(id)
    }
    const shown = list.filter((u) => isShown(u, view))
    const slots = yardLayout(shown.length, AREA_W, AREA_D)
    const slotOf = new Map(shown.map((u, i) => [u.id, slots[i]]))
    for (const u of list) {
      const unit = units.get(u.id) ?? build(u)
      units.set(u.id, unit)
      const level = tenantLevel(u)
      if (level !== unit.level || u.kind !== unit.data.kind) paint(unit.material, u, level)
      unit.data = u
      unit.level = level
      unit.throttled = isThrottled(u, throttleAmber)
      unit.fill = fillOf(u)
      const slot = slotOf.get(u.id)
      unit.shown = slot !== undefined && isShown(u, view)
      unit.object.visible = unit.shown
      unit.dimmed = view.tenant !== null && view.tenant !== u.id
      if (slot) {
        unit.object.position.set(slot.x, 0, slot.z)
        unit.size = slot.size
      }
      unit.material.transparent = unit.dimmed
      unit.material.opacity = unit.dimmed ? 0.35 : 1
    }
    const summary = yardSummary(list, view, throttleAmber)
    status = {
      units: list.map((u) => {
        const unit = units.get(u.id)!
        return { id: u.id, level: unit.level, test: u.kind === 'Test', unknown: u.kind === 'Unknown', shown: unit.shown, dimmed: unit.dimmed, throttled: unit.throttled, fill: unit.fill }
      }),
      sign: { text: summary.text, note: summary.note },
    }
    paintSign(summary.text, summary.note, summary.throttled > 0)
  }

  return {
    base,
    baseHeight: FLOOR,
    floorHeight: 1,
    fixedFloors: 0,
    makeFloor: () => ({ object: new THREE.Group(), uniforms: { uLit: { value: 0 }, uDark: { value: 0 }, uStale: { value: 0 }, uSeed: { value: 0 } } }),
    roof,
    beaconAt: new THREE.Vector3(W / 2 - 0.4, 3.45, -D / 2 + 0.5),
    door: new THREE.Vector3(0, 0, D / 2 + 1.9),
    doorDir: new THREE.Vector3(0, 0, 1),
    plaque: { position: new THREE.Vector3(W / 2 - 1.25, 0.9, D / 2 + 0.2), width: 1.5 },
    radius: 4.2,
    setTenants(list, throttleAmber, v) {
      view = v
      apply(list, throttleAmber)
    },
    tenantStatus: () => status,
    animate(time, dt) {
      const ease = 1 - Math.exp(-3 * dt)
      pulse = 0.5 + 0.5 * Math.sin(time * 5)
      for (const unit of units.values()) {
        unit.height += (unit.fill - unit.height) * ease
        const h = SHORT + (TALL - SHORT) * unit.height
        unit.body.scale.set(unit.size, h, unit.size)
        unit.frame.scale.set(unit.size, 1, unit.size)
        // a unit in trouble breathes: faster and brighter the redder it is
        const hot = unit.level === 'amber' || unit.level === 'red'
        unit.material.emissive.set(unit.level === 'red' ? '#ff2020' : '#ff9a10')
        unit.material.emissiveIntensity = hot ? (unit.throttled ? 0.25 + 0.35 * pulse : 0.18) : 0
        if (view.tenant !== null && view.tenant === unit.id) {
          unit.material.emissive.set('#ffffff')
          unit.material.emissiveIntensity = 0.25
        }
      }
    },
  }
}
