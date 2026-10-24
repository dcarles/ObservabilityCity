import * as THREE from 'three'

const cache = new Map<string, THREE.MeshStandardMaterial>()

/** Shared flat-shaded material per colour, so the whole town uses a handful of materials. */
export function flat(color: string, opts: { roughness?: number; metalness?: number; emissive?: string; emissiveIntensity?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${opts.roughness ?? ''}|${opts.metalness ?? ''}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}`
  let m = cache.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.roughness ?? 0.85,
      metalness: opts.metalness ?? 0.02,
      flatShading: true,
      emissive: opts.emissive ?? '#000000',
      emissiveIntensity: opts.emissiveIntensity ?? 1,
    })
    cache.set(key, m)
  }
  return m
}

type Placement = { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number }

function place<T extends THREE.Object3D>(o: T, p: Placement): T {
  o.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0)
  o.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0)
  return o
}

function shadowed(m: THREE.Mesh): THREE.Mesh {
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** Box whose base sits on y (not its centre), which is how buildings are stacked. */
export function box(w: number, h: number, d: number, mat: THREE.Material, p: Placement = {}): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(0, h / 2, 0)
  return place(shadowed(new THREE.Mesh(g, mat)), p)
}

export function cyl(rTop: number, rBottom: number, h: number, mat: THREE.Material, p: Placement = {}, seg = 16): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg)
  g.translate(0, h / 2, 0)
  return place(shadowed(new THREE.Mesh(g, mat)), p)
}

export function cone(r: number, h: number, mat: THREE.Material, p: Placement = {}, seg = 4): THREE.Mesh {
  const g = new THREE.ConeGeometry(r, h, seg)
  g.translate(0, h / 2, 0)
  return place(shadowed(new THREE.Mesh(g, mat)), p)
}

export function sphere(r: number, mat: THREE.Material, p: Placement = {}, seg = 12): THREE.Mesh {
  return place(shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg / 2)), mat)), p)
}

export function dome(r: number, mat: THREE.Material, p: Placement = {}): THREE.Mesh {
  const g = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  return place(shadowed(new THREE.Mesh(g, mat)), p)
}

export function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group()
  g.add(...children)
  return g
}

export function at<T extends THREE.Object3D>(o: T, x = 0, y = 0, z = 0): T {
  o.position.set(x, y, z)
  return o
}

/** A small canvas drawn into a texture. Used for plaques, signs and clock faces. */
export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  draw(ctx)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
