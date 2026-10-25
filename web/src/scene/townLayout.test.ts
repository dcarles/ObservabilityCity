import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { planIsland } from './plan'
import { layoutTown } from './layout'
import type { Snapshot } from '../types'

const snapshotPath = resolve(__dirname, '../../../tests/fixtures/snapshots/calm.json')
const goldenPath = resolve(__dirname, '../../../tests/fixtures/layout/galactic-credit.json')
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
const pillars = snapshot.groups.filter((g) => !g.isHub)
const plans = pillars.map((g) => planIsland(g))
const layout = layoutTown(plans.map((p) => ({ rx: p.rx, rz: p.rz })))

const r = (v: number) => Math.round(v * 10) / 10

describe('the sample town', () => {
  it('has fourteen pillars and Lost & found, which stands last', () => {
    expect(pillars).toHaveLength(15)
    expect(pillars.filter((g) => g.isLostFound)).toHaveLength(1)
    expect(pillars[pillars.length - 1].isLostFound).toBe(true)
  })

  it('stands twelve islands on the first ring and the rest on a second ring', () => {
    expect(layout.islands.filter((i) => i.ring === 1)).toHaveLength(12)
    expect(layout.islands.filter((i) => i.ring === 2)).toHaveLength(3)
  })

  it('puts every system on its island grid exactly once', () => {
    pillars.forEach((g, i) => {
      expect(plans[i].placed.map((p) => p.node.id).sort()).toEqual(g.nodes.map((n) => n.id).sort())
    })
  })

  it('matches the golden layout', () => {
    const actual = {
      hub: { scale: r(layout.hub.scale), rx: r(layout.hub.rx), rz: r(layout.hub.rz) },
      islands: pillars.map((g, i) => ({
        id: g.id,
        ring: layout.islands[i].ring,
        angleDeg: r((layout.islands[i].angle * 180) / Math.PI),
        radius: r(layout.islands[i].radius),
        portDeg: r((layout.islands[i].portAngle * 180) / Math.PI),
        rows: plans[i].rows,
        rx: r(plans[i].rx),
        rz: r(plans[i].rz),
        buildings: plans[i].placed.length,
      })),
    }
    const text = JSON.stringify(actual, null, 2) + '\n'
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(goldenPath)) {
      mkdirSync(dirname(goldenPath), { recursive: true })
      writeFileSync(goldenPath, text)
    }
    expect(text).toBe(readFileSync(goldenPath, 'utf8').replace(/\r\n/g, '\n'))
  })
})
