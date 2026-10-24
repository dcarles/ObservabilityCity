import * as THREE from 'three'
import { palette } from '../themes/harbour-town/palette'
import { circleNoise, rng } from './random'

export interface Outline {
  /** Coast points in the island's local x/z plane, counter-clockwise seen from above. */
  points: THREE.Vector2[]
  contains(x: number, z: number, inset?: number): boolean
}

/** An organic coastline: an ellipse wobbled by seeded noise, so the same id always gives the same shape. */
export function makeOutline(seed: number, rx: number, rz: number, wobble = 0.07, n = 112): Outline {
  const noise = circleNoise(seed)
  const points: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const k = 1 + wobble * noise(a)
    points.push(new THREE.Vector2(Math.cos(a) * rx * k, Math.sin(a) * rz * k))
  }
  return { points, contains: (x, z, inset = 0) => inPolygon(inset === 0 ? points : offsetPolygon(points, -inset), x, z) }
}

function inPolygon(poly: THREE.Vector2[], x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Moves every vertex along its normal. Positive grows the polygon, negative shrinks it. */
export function offsetPolygon(points: THREE.Vector2[], d: number): THREE.Vector2[] {
  const n = points.length
  return points.map((p, i) => {
    const prev = points[(i + n - 1) % n]
    const next = points[(i + 1) % n]
    const t = next.clone().sub(prev).normalize()
    // For a counter-clockwise polygon the outward normal is the tangent rotated by -90 degrees.
    return new THREE.Vector2(p.x + t.y * d, p.y - t.x * d)
  })
}

function shapeOf(points: THREE.Vector2[]): THREE.Shape {
  // The shape is built in x/y and then laid flat, which maps y to -z.
  return new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, -p.y)))
}

function flatLayer(points: THREE.Vector2[], color: string, opacity: number, y: number, order: number): THREE.Mesh {
  const g = new THREE.ShapeGeometry(shapeOf(points))
  g.rotateX(-Math.PI / 2)
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -order, polygonOffsetUnits: -order,
  }))
  m.position.y = y
  m.renderOrder = order
  return m
}

function slab(points: THREE.Vector2[], top: number, bottom: number, capColor: string, sideColor: string): THREE.Mesh {
  const depth = top - bottom
  const g = new THREE.ExtrudeGeometry(shapeOf(points), { depth, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 1, curveSegments: 1 })
  g.rotateX(-Math.PI / 2)
  g.translate(0, bottom, 0)
  const m = new THREE.Mesh(g, [
    new THREE.MeshStandardMaterial({ color: capColor, roughness: 0.95, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.95, flatShading: true }),
  ])
  m.castShadow = true
  m.receiveShadow = true
  return m
}

export const GROUND = 0.55

/** The island body: shallow water rings, foam, beach, cliff and grass. */
export function buildIslandBody(outline: Outline): THREE.Group {
  const c = palette.island
  const g = new THREE.Group()
  g.add(
    flatLayer(offsetPolygon(outline.points, 6.5), palette.sea.shallow, 0.22, 0.01, 1),
    flatLayer(offsetPolygon(outline.points, 3.6), '#8fe3ea', 0.34, 0.02, 2),
    flatLayer(offsetPolygon(outline.points, 1.7), palette.sea.foam, 0.8, 0.03, 3),
    slab(offsetPolygon(outline.points, 1.15), 0.34, -1.2, c.sand, c.sand),
    slab(outline.points, GROUND, -1.6, c.grass, c.cliff),
  )
  return g
}

export interface Rect {
  x: number
  z: number
  w: number
  d: number
}

/** Scatters instanced trees, bushes and rocks, keeping clear of the rectangles (roads, plots, bridge ends). */
export function scatterNature(outline: Outline, avoid: Rect[], seed: number, opts: { trees: number; rocks: number; center?: THREE.Vector2 }): THREE.Group {
  const r = rng(seed)
  const g = new THREE.Group()
  const inner = offsetPolygon(outline.points, -2.4)
  const xs = inner.map((p) => p.x), zs = inner.map((p) => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs)
  const free = (x: number, z: number, margin: number) =>
    inPolygon(inner, x, z) && !avoid.some((a) => Math.abs(x - a.x) < a.w / 2 + margin && Math.abs(z - a.z) < a.d / 2 + margin)

  const pick = (margin: number): THREE.Vector3 | null => {
    for (let i = 0; i < 40; i++) {
      const x = minX + r() * (maxX - minX), z = minZ + r() * (maxZ - minZ)
      if (free(x, z, margin)) return new THREE.Vector3(x, GROUND, z)
    }
    return null
  }

  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.17, 0.9, 5)
  trunkGeo.translate(0, 0.45, 0)
  const blobGeo = new THREE.IcosahedronGeometry(0.85, 0)
  blobGeo.translate(0, 1.55, 0)
  const pineGeo = new THREE.ConeGeometry(0.85, 2.1, 6)
  pineGeo.translate(0, 1.9, 0)
  const pine2Geo = new THREE.ConeGeometry(0.62, 1.4, 6)
  pine2Geo.translate(0, 2.7, 0)

  const spots: { p: THREE.Vector3; pine: boolean; s: number; rot: number; color: THREE.Color }[] = []
  for (let i = 0; i < opts.trees; i++) {
    const p = pick(1.6)
    if (!p) continue
    const pine = r() < 0.4
    const palettePick = pine ? palette.tree.pine : palette.tree.leaves
    spots.push({ p, pine, s: 0.8 + r() * 0.7, rot: r() * Math.PI * 2, color: new THREE.Color(palettePick[Math.floor(r() * palettePick.length)]) })
  }
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: palette.tree.trunk, flatShading: true }), spots.length)
  const blobs = new THREE.InstancedMesh(blobGeo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }), spots.length)
  const pines = new THREE.InstancedMesh(pineGeo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }), spots.length)
  const pines2 = new THREE.InstancedMesh(pine2Geo, new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }), spots.length)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), hidden = new THREE.Matrix4().makeScale(0, 0, 0)
  spots.forEach((s, i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rot)
    m.compose(s.p, q, new THREE.Vector3(s.s, s.s, s.s))
    trunks.setMatrixAt(i, m)
    blobs.setMatrixAt(i, s.pine ? hidden : m)
    pines.setMatrixAt(i, s.pine ? m : hidden)
    pines2.setMatrixAt(i, s.pine ? m : hidden)
    blobs.setColorAt(i, s.color); pines.setColorAt(i, s.color); pines2.setColorAt(i, s.color)
  })
  for (const im of [trunks, blobs, pines, pines2]) { im.castShadow = true; im.receiveShadow = true; g.add(im) }

  const rockGeo = new THREE.DodecahedronGeometry(0.7, 0)
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: palette.island.rock, flatShading: true, roughness: 1 }), opts.rocks)
  let placed = 0
  for (let i = 0; i < opts.rocks; i++) {
    // rocks hug the coast
    const a = r() * Math.PI * 2
    const base = outline.points[Math.floor((a / (Math.PI * 2)) * outline.points.length) % outline.points.length]
    const p = new THREE.Vector3(base.x * 0.97, GROUND + 0.1, base.y * 0.97)
    if (avoid.some((av) => Math.abs(p.x - av.x) < av.w / 2 + 1 && Math.abs(p.z - av.z) < av.d / 2 + 1)) continue
    const s = 0.5 + r() * 0.9
    q.setFromEuler(new THREE.Euler(r() * 3, r() * 3, r() * 3))
    m.compose(p, q, new THREE.Vector3(s * 1.3, s * 0.8, s))
    rocks.setMatrixAt(placed++, m)
  }
  rocks.count = placed
  rocks.castShadow = true
  g.add(rocks)
  return g
}

/** A grassy mound with a few trees on it, to break up the flat island. */
export function hill(x: number, z: number, r: number, h: number): THREE.Mesh {
  const g = new THREE.SphereGeometry(r, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  g.scale(1, h / r, 1)
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: palette.island.hill, flatShading: true, roughness: 0.95 }))
  m.position.set(x, GROUND - 0.05, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}
