import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { cyl, flat } from '../buildings/mk'
import type { BuildingModel } from '../buildings/model'

export const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** One window cell, as in the harbour town: every width is a multiple of it, so windows sit evenly on every face. */
export const CELL = 1.2

/** Several shapes in several colours as one geometry (colour per vertex), so a car or a boat is a single instanced mesh. Each part is placed by a matrix. */
export function coloured(parts: { geometry: THREE.BufferGeometry; color: string; at?: [number, number, number]; scale?: [number, number, number]; rot?: [number, number, number] }[]): THREE.BufferGeometry {
  const prepared = parts.map((p) => {
    const g = p.geometry.clone()
    if (p.scale) g.scale(...p.scale)
    if (p.rot) { g.rotateX(p.rot[0]); g.rotateY(p.rot[1]); g.rotateZ(p.rot[2]) }
    if (p.at) g.translate(...p.at)
    const c = new THREE.Color(p.color)
    const n = g.getAttribute('position').count
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return g
  })
  return mergeGeometries(prepared)!
}

/** A box whose base sits on y = 0, as a bare geometry. */
export function slab(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(0, h / 2, 0)
  return g
}

export function column(rTop: number, rBottom: number, h: number, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg)
  g.translate(0, h / 2, 0)
  return g
}

/** The material for a geometry built with `coloured`. */
export const paintedMaterial = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, flatShading: true })

/** A light that does not depend on the sun: a bulb, a strip, a ring. */
const glowCache = new Map<string, THREE.MeshBasicMaterial>()
export function glow(color: string): THREE.MeshBasicMaterial {
  let m = glowCache.get(color)
  if (!m) { m = new THREE.MeshBasicMaterial({ color, toneMapped: false }); glowCache.set(color, m) }
  return m
}

/** A thin vertical mast, the same in every theme: the beacon sits on top of one. */
export function mast(h: number, color = '#9aa3ad'): THREE.Mesh {
  return cyl(0.05, 0.07, h, flat(color, { metalness: 0.3 }), {}, 8)
}

/** The shape of a model a theme must give for every kind of building, for tests: it is complete when it can be stood up and read. */
export function isComplete(m: BuildingModel): boolean {
  return m.floorHeight > 0 && m.radius > 0 && m.beaconAt instanceof THREE.Vector3 && m.door instanceof THREE.Vector3 && m.makeFloor(0).uniforms !== undefined
}

/** The ends of a bridge piece that carry a gate, as -1 (the -z end) and 1 (the +z end). */
export function endList(ends: boolean | -1 | 1): (-1 | 1)[] {
  return ends === true ? [-1, 1] : ends === false ? [] : [ends]
}
