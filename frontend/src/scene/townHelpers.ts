import * as THREE from 'three'
import type { Snapshot } from '../types'
import { palette } from '../themes/active'
import { bench } from './props'
import { GROUND, type Outline } from './island'
import { edgeKey } from '../edgeTraffic'

// Helpers of the town that use none of its state: text wrapping, the park on a spare pad, the key that says whether the layout changed, and lane and coast geometry.

/** Breaks text into lines of at most `width` characters at word boundaries; a word longer than a line is cut. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let word = raw
    while (word.length > width) {
      if (line) { lines.push(line); line = '' }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

/** A couple of trees, flower beds and benches for a spare pad. */
export function parkProps(x: number, z: number): THREE.Object3D[] {
  const out: THREE.Object3D[] = []
  const trunk = new THREE.MeshStandardMaterial({ color: palette.tree.trunk, flatShading: true })
  const leaf = new THREE.MeshStandardMaterial({ color: palette.tree.park, flatShading: true })
  for (const [dx, dz, s] of [[-6, -1.5, 1.35], [5.5, 1.2, 1.05], [-1, 2.2, 0.9], [8, -2, 1.2]] as const) {
    const t = new THREE.Group()
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.1, 5), trunk); tr.position.y = 0.55; tr.castShadow = true
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 0), leaf); l.position.y = 1.9; l.castShadow = true
    t.add(tr, l)
    t.scale.setScalar(s)
    t.position.set(x + dx, GROUND, z + dz)
    out.push(t)
  }
  out.push(bench(x - 2.5, z + 2.6, 0), bench(x + 2, z - 2.8, Math.PI))
  const colors = ['#ff7a8a', '#ffd84d', '#ffffff', '#b58cff']
  for (let i = 0; i < 14; i++) {
    const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 0), new THREE.MeshStandardMaterial({ color: colors[i % 4], flatShading: true }))
    f.position.set(x - 1.5 + (i % 7) * 0.5, GROUND + 0.18, z - 0.3 + Math.floor(i / 7) * 0.6)
    out.push(f)
  }
  return out
}

export function layoutKey(s: Snapshot): string {
  const groups = s.groups.map((g) => `${g.id}${g.configError ? '!' : ''}:${g.nodes.map((n) => `${n.id}/${n.kind}/${n.tenants != null ? 'T' : ''}/${n.service ?? ''}/${n.calls.join('+')}/${(n.gatewayCalls ?? []).join('+')}`).join(',')}|${g.hasBridge === false ? 'nb' : 'b'}${g.hasRingBridge ? 'r' : ''}|${(g.assets ?? []).map((a) => `${a.id}/${a.shape}/${a.service ?? ''}/${a.group ?? ''}`).join('+')}|${(g.messaging?.topics ?? []).map((t) => t.name).join('+')}|${(g.messaging?.subscriptions ?? []).map((x) => `${x.topic}>${x.consumer}${x.legacy ? '!' : ''}`).join('+')}`).join(';')
  const vendors = (s.vendors ?? []).map((v) => `${v.node.id}@${v.islandId ?? ''}<${v.calledBy.join('+')}>${(v.calls ?? []).join("+")}`).join(';')
  return `${s.townId}|${s.environment ?? ''}|${groups}|${vendors}|${edgeKey(s)}`
}

/** Where a straight line from the hub's centre leaves the hub's coast (inset a little). */
export function laneLength(p: THREE.Vector3[]): number {
  let l = 0
  for (let i = 1; i < p.length; i++) l += p[i].distanceTo(p[i - 1])
  return l
}

export function coastPoint(outline: Outline, dir: THREE.Vector3, inset: number): THREE.Vector3 {
  let lo = 0, hi = 140
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (outline.contains(dir.x * mid, dir.z * mid)) lo = mid
    else hi = mid
  }
  return new THREE.Vector3(dir.x * (lo - inset), GROUND, dir.z * (lo - inset))
}
