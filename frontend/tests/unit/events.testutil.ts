import { makeOutline } from '../../src/scene/island'
import { rng } from '../../src/scene/random'
import type { ArenaSource, Block } from '../../src/events/arena'

/** An island shaped like the town's own: pads in rows either side of a spine road, a few buildings on each pad, a wobbling coast around them. */
export function island(o: { id: string; seed: number; pads: number; rows: number; perPad: number; seaward: number; extra?: number }): ArenaSource {
  const R = rng(o.seed)
  const COL_X = 18.8
  const ROW = 29
  const PITCH = 25.6
  const SLOT = 7.6
  const blocks: Block[] = []
  const half = o.pads / 2
  for (let row = 0; row < o.rows; row++) {
    for (let col = 0; col < 2; col++) {
      for (let ring = 0; ring < half; ring++) {
        const px = (col ? 1 : -1) * (COL_X + ring * PITCH)
        const pz = (row - (o.rows - 1) / 2) * ROW
        for (let k = 0; k < o.perPad; k++) {
          const w = 3.4 + R() * 2.6
          const d = 3.4 + R() * 2.6
          const cx = px + (k - (o.perPad - 1) / 2) * SLOT
          blocks.push({ id: `${o.id}-b${blocks.length}`, x0: cx - w / 2, x1: cx + w / 2, z0: pz - d / 2, z1: pz + d / 2, h: 3 + R() * 9 })
        }
      }
    }
  }
  for (let i = 0; i < (o.extra ?? 0); i++) {
    const x = (R() - 0.5) * (o.pads * PITCH * 0.9)
    blocks.push({ id: `${o.id}-a${i}`, x0: x - 1.6, x1: x + 1.6, z0: o.rows * ROW * 0.5 - 2, z1: o.rows * ROW * 0.5 + 1.2, h: 2.8 })
  }
  const rx = (COL_X + (half - 1) * PITCH + (o.perPad * SLOT) / 2) + 14
  const rz = (o.rows * ROW) / 2 + 16
  const outline = makeOutline(o.seed, rx, rz).points.map((p) => ({ x: p.x, z: p.y }))
  return { id: o.id, name: o.id, outline, blocks, seaward: o.seaward, gate: { x: 0, z: rz - 0.7 } }
}

/** A handful of islands of different sizes and shapes, facing different ways, to try every event on. */
export const ISLANDS: ArenaSource[] = [
  island({ id: 'small', seed: 3, pads: 2, rows: 1, perPad: 2, seaward: 0 }),
  island({ id: 'medium', seed: 5, pads: 4, rows: 2, perPad: 3, seaward: 2.4, extra: 3 }),
  island({ id: 'wide', seed: 9, pads: 6, rows: 2, perPad: 3, seaward: -1.3, extra: 4 }),
  island({ id: 'deep', seed: 11, pads: 2, rows: 3, perPad: 3, seaward: 4.1 }),
  island({ id: 'tiny', seed: 4, pads: 2, rows: 1, perPad: 1, seaward: 1.0 }),
]
