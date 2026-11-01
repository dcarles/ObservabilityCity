import { describe, expect, it } from 'vitest'
import { isUnmonitored, SIGNALS } from '../../src/signals'
import { checkSnapshot } from '../../src/snapshotGuard'
import { dayTime, jobReasons, jobRows, overviewRows, reasons } from '../../src/inspectorModel'
import { regionFigures, regionLine, regionOptions, sharePercent, splitLine, validChoice, withRegion, worstRegion } from '../../src/regions'
import { notFoundText } from '../../src/inspectorModel'
import { beaconLevel, plaqueText } from '../../src/visuals'
import type { NodeSnapshot, Snapshot } from '../../src/types'
import { healthyTown } from './wall.testutil'
import { planIsland, placeHubClusters, clusterSize, rectsTouch, CLUSTER_PER_ROW, CURB, PAD_D, YARD_OFFSET } from '../../src/scene/plan'
import { makeOutline } from '../../src/scene/island'
import { hashString } from '../../src/scene/random'
import { assetWhere, summariseAsset } from '../../src/scene/assets'

// Phase 3, slices 3 and 3b: a function building (the old cron) knows whether its app runs and how each scheduled job is doing; a service in two regions
// shows its worst region and lets the viewer look at another.

const town = (): Snapshot => healthyTown()
const first = (s: Snapshot): NodeSnapshot => s.groups.flatMap((g) => g.nodes)[0]!
const fn = (patch: Partial<NodeSnapshot> = {}): NodeSnapshot => ({ ...first(town()), kind: 'Function', app: 'Running', absent: ['requests', 'errors', 'latency', 'instances', 'backlog', 'deadLetters', 'utilisation', 'throttled', 'cpu', 'memory'], ...patch })
const job = (name: string, status: 'Ok' | 'Failed' | 'Overdue', region: string | null = null) => ({ name, region, status, lastRun: '2026-01-01T10:00:00Z', next: '2026-01-01T11:00:00Z' })
const twoRegions = (patch: Partial<NodeSnapshot> = {}): NodeSnapshot => ({
  ...first(town()),
  instancesTotal: 1, instancesHealthy: 1, cpu: 0.64, memory: 0.6,
  regions: [{ region: 'northeurope', label: 'North', instances: 2, cpu: 0.4, memory: 0.58, share: null, skewed: false }, { region: 'westeurope', label: 'West', instances: 1, cpu: 0.64, memory: 0.6, share: null, skewed: false }],
  ...patch,
})

describe('a function building', () => {
  it('is monitored by its jobs alone, and unmonitored when nothing reads them', () => {
    const only = fn({ jobs: [job('daily', 'Ok')] })
    expect(isUnmonitored(only)).toBe(false) // every ordinary signal is absent, but the jobs are read
    expect(isUnmonitored({ ...only, kind: 'Function', absent: [...SIGNALS, 'jobs'] })).toBe(true)
    expect(isUnmonitored({ kind: 'Api', absent: [...SIGNALS] })).toBe(true)
  })

  it('lists each job in each region with its state, and says in words what is wrong', () => {
    const n = fn({ state: 'Down', jobs: [job('daily', 'Ok', 'North'), job('hourly', 'Overdue', 'West'), job('purge', 'Failed', 'West')] })

    expect(jobRows(n).map((r) => [r.label, r.tone])).toEqual([['daily (North)', ''], ['hourly (West)', 'warn'], ['purge (West)', 'bad']])
    expect(jobRows(n)[2]!.value).toMatch(/^failed · ran .+ · next .+$/)
    expect(jobReasons(n)).toHaveLength(2)
    expect(reasons(n)[0]).toMatch(/^Job hourly \(West\) should have run at .+ and has not\.$/)
    expect(reasons(n)[1]).toMatch(/^Job purge \(West\) failed its last run at /)
  })

  it('is red for a failed job and amber for a late one, whatever else is quiet', () => {
    expect(beaconLevel({ ...fn({ state: 'Down', jobs: [job('a', 'Failed')] }) })).toBe('red')
    expect(beaconLevel({ ...fn({ state: 'Degraded', jobs: [job('a', 'Overdue')] }) })).toBe('amber')
    expect(beaconLevel({ ...fn({ state: 'Healthy', jobs: [job('a', 'Ok')] }) })).toBe('green')
    expect(beaconLevel({ ...fn({ state: 'Healthy', jobs: null }) })).toBe('off') // nothing here is measured
  })

  it('stands as a half-built shell while its app is stopped, and says so', () => {
    const stopped = fn({ app: 'Stopped' })
    expect(plaqueText(stopped)).toBe('stopped')
    expect(overviewRows(stopped)[0]).toEqual({ label: 'App', value: 'stopped (under construction)', tone: 'warn' })
    expect(reasons(stopped).join(' ')).toContain('under construction')
  })

  it('is grey and says not found when the inventory does not have its app', () => {
    const missing = fn({ app: 'Missing', state: 'Stale' })
    expect(plaqueText(missing)).toBe('not found')
    expect(overviewRows(missing)).toEqual([{ label: 'App', value: 'not found in the inventory', tone: 'stale' }])
    expect(reasons(missing)[0]).toContain('not found in the inventory')
    // the environment names its cloud; the program does not know any
    expect(overviewRows(missing, undefined, 'Azure')[0]!.value).toBe('not found in Azure')
    expect(reasons(missing, 'Cumulus')[0]).toContain('not found in Cumulus')
    expect(notFoundText(null)).toBe('not found in the inventory')
  })

  it('never shows 0 of 0 instances: a building whose instances are absent says nothing of them', () => {
    expect(plaqueText({ ...fn({ app: 'Running' }), instancesTotal: 0, instancesHealthy: 0, absent: ['instances'] })).toBe('')
  })

  it('survives the snapshot check with its app, jobs and regions, and drops what is not usable', () => {
    const s = town()
    const n = first(s)
    const raw = { ...s, groups: s.groups.map((g, i) => (i === 0 ? { ...g, nodes: g.nodes.map((x, j) => (j === 0 ? { ...x, kind: 'Function', app: 'Running', absent: ['jobs'],
      jobs: [job('daily', 'Failed', 'West'), { name: '', status: 'Ok' }, { name: 'odd', status: 'Strange', lastRun: 7 }],
      regions: [{ region: 'a', label: '', instances: 2, cpu: 'x', memory: 0.1 }, { region: '' }] } : x)) } : g)) }

    const checked = checkSnapshot(raw).snapshot!.groups[0]!.nodes[0]!

    expect(checked.id).toBe(n.id)
    expect(checked.app).toBe('Running')
    expect(checked.absent).toEqual(['jobs'])
    expect(checked.jobs).toEqual([{ name: 'daily', region: 'West', status: 'Failed', lastRun: '2026-01-01T10:00:00Z', next: '2026-01-01T11:00:00Z' }, { name: 'odd', region: null, status: 'Ok', lastRun: null, next: null }])
    expect(checked.regions).toEqual([{ region: 'a', label: 'a', instances: 2, cpu: null, memory: 0.1, share: null, skewed: false }])
    expect(checkSnapshot({ ...raw, groups: raw.groups.map((g) => ({ ...g, nodes: g.nodes.map((x) => ({ ...x, app: 'Weird', jobs: 'no', regions: 3 })) })) }).snapshot!.groups[0]!.nodes[0]).toMatchObject({ app: null, jobs: null, regions: null })
  })
})

describe('the per-region view', () => {
  it('offers a choice only to a service in two or more regions', () => {
    expect(regionOptions(first(town()))).toEqual([])
    expect(regionOptions(twoRegions())).toEqual([{ id: 'worst', label: 'Worst' }, { id: 'northeurope', label: 'North' }, { id: 'westeurope', label: 'West' }])
    expect(regionOptions({ regions: [{ region: 'a', label: 'A', instances: 1, cpu: null, memory: null, share: null, skewed: false }] })).toEqual([])
  })

  it('shows the worst region by default, and says which region the numbers are', () => {
    const n = twoRegions()
    expect(withRegion(n, 'worst')).toBe(n)
    expect(worstRegion(n)).toBe('West')
    expect(regionLine(n, 'worst')).toBe('West (worst of 2)')
    expect(regionLine(first(town()), 'worst')).toBe('')
  })

  it('shows one region by itself', () => {
    const n = withRegion(twoRegions(), 'northeurope')
    expect([n.instancesTotal, n.instancesHealthy, n.cpu, n.memory]).toEqual([2, 2, 0.4, 0.58])
    expect(regionLine(twoRegions(), 'northeurope')).toBe('North')
  })

  it('keeps the instances it has when a region does not count its own, and the building\'s health is not recomputed', () => {
    const n = twoRegions({ state: 'Degraded', regions: [{ region: 'a', label: 'A', instances: null, cpu: 0.2, memory: null, share: null, skewed: false }, { region: 'b', label: 'B', instances: 2, cpu: 0.9, memory: null, share: null, skewed: false }] })
    expect(withRegion(n, 'a').instancesTotal).toBe(1)
    expect(withRegion(n, 'a').state).toBe('Degraded')
  })

  it('falls back to the worst region when the chosen one has left the snapshot', () => {
    expect(validChoice(twoRegions(), 'eastus')).toBe('worst')
    expect(validChoice(twoRegions(), 'northeurope')).toBe('northeurope')
    expect(validChoice(twoRegions(), 'all')).toBe('worst') // there is no combined view: it adds instances and mixes CPU and memory
    expect(validChoice(first(town()), 'northeurope')).toBe('worst')
  })
})

describe('how a service divides its requests between regions', () => {
  const split = (a: number | null, b: number | null, skewed = false) => twoRegions({
    regions: [{ region: 'northeurope', label: 'North', instances: 2, cpu: 0.4, memory: 0.58, share: a, skewed }, { region: 'westeurope', label: 'West', instances: 1, cpu: 0.64, memory: 0.6, share: b, skewed: false }],
  })

  it('writes each measured share on the sign, and warns when the backend flagged a region', () => {
    expect(splitLine(split(0.7, 0.3))).toEqual({ text: 'North 70% · West 30%', hot: false })
    expect(splitLine(split(0.95, 0.05, true))).toEqual({ text: 'North 95% · West 5%', hot: true })
    expect(splitLine(split(0.999, 0.001))!.text).toBe('North 100% · West <1%')
  })

  it('says nothing when nothing measures the split, and for a service in one region', () => {
    expect(splitLine(split(null, null))).toBeNull()
    expect(splitLine(first(town()))).toBeNull()
    expect(sharePercent(0.5)).toBe('50%')
  })

  it('leaves out instances a region does not count, and never writes "unknown"', () => {
    const none = { region: 'a', label: 'A', instances: null, cpu: 0.2, memory: null, share: 0.25, skewed: false }
    expect(regionFigures(none)).toBe('CPU 20% · 25% of requests')
    expect(regionFigures({ ...none, instances: 1, memory: 0.5, share: null })).toBe('1 instance · CPU 20% · memory 50%')
    expect(regionFigures({ ...none, instances: 2 })).not.toContain('unknown')
    expect(plaqueText({ ...first(town()), instancesTotal: 0, instancesHealthy: 0, absent: [] })).toBe('')
  })

  it('survives the snapshot check: a share outside 0 to 1 is dropped, a flag needs to be true', () => {
    const s = town()
    const raw = { ...s, cloud: ' Azure ', groups: s.groups.map((g, i) => (i === 0 ? { ...g, nodes: g.nodes.map((x, j) => (j === 0 ? { ...x, regions: [
      { region: 'a', label: 'A', instances: 1, cpu: 0.1, memory: 0.1, share: 0.8, skewed: true }, { region: 'b', label: 'B', instances: 1, cpu: 0.1, memory: 0.1, share: 3, skewed: 'yes' }] } : x)) } : g)) }

    const checked = checkSnapshot(raw).snapshot!

    expect(checked.groups[0]!.nodes[0]!.regions!.map((r) => [r.share, r.skewed])).toEqual([[0.8, true], [null, false]])
    expect(checked.cloud).toBe('Azure')
    expect(checkSnapshot({ ...raw, cloud: 4 }).snapshot!.cloud).toBeNull()
  })
})

describe('resource buildings', () => {
  const asset = (patch = {}) => ({ id: 'aa.kv-ord', name: 'kv-ord', label: 'Key vault', shape: 'vault', service: 'orders', region: 'northeurope', links: [{ name: 'Portal', url: 'https://portal.example.test/x' }], ...patch })
  const pillar = () => town().groups.find((x) => !x.isHub && x.nodes.some((n) => n.service))!
  const withAssets = (assets: unknown[]): Snapshot => {
    const s = town()
    return { ...s, groups: s.groups.map((g, i) => (i === 0 ? { ...g, assets } : g)) } as Snapshot
  }

  it('survive the snapshot check: one without an id or a name is dropped, an unknown shape is a box, an address must be http(s)', () => {
    const raw = withAssets([asset(), asset({ id: '' }), asset({ id: 'aa.two', name: '' }), asset({ id: 'aa.three', shape: 'castle', service: '', links: [{ name: 'Bad', url: 'javascript:alert(1)' }, { name: 'Ok', url: 'http://c.example.test/' }] }), asset()])

    const assets = checkSnapshot(raw).snapshot!.groups[0]!.assets!

    expect(assets.map((a) => [a.id, a.shape, a.service])).toEqual([['aa.kv-ord', 'vault', 'orders'], ['aa.three', 'box', null]])
    expect(assets[1]!.links).toEqual([{ name: 'Ok', url: 'http://c.example.test/' }])
  })

  it('stand behind the pad of their service, and in the back yard when they belong to the pillar or do not fit', () => {
    const g = pillar()
    const service = g.nodes.find((n) => n.service)!.service!
    const plan = planIsland({ ...g, assets: [asset({ id: 'a1', service }), asset({ id: 'a2', service: 'nowhere' }), asset({ id: 'a3', service: null })] } as never)

    const [a1, a2, a3] = ['a1', 'a2', 'a3'].map((id) => plan.assets.find((a) => a.asset.id === id)!)
    expect(a1.pad?.service).toBe(service)
    expect(a1.z).toBeLessThan(plan.rowRoadZ[a1.pad!.row]! - CURB - PAD_D) // behind the pad, away from the road
    expect(a2.pad).toBeNull()
    expect(a3.pad).toBeNull()
    expect(Math.abs(a3.x)).toBeGreaterThanOrEqual(YARD_OFFSET) // clear of a road that may continue along the spine
    expect(a3.z).toBeLessThan(a1.z)
  })

  it('never stand on the same spot, and the coast is made to hold them', () => {
    const g = pillar()
    const assets = Array.from({ length: 14 }, (_, i) => asset({ id: `p${String(i).padStart(2, '0')}`, service: null }))
    const bare = planIsland({ ...g, assets: [] } as never)
    const plan = planIsland({ ...g, assets } as never)
    const spots = new Set(plan.assets.map((a) => `${a.x.toFixed(1)}/${a.z.toFixed(1)}`))

    expect(spots.size).toBe(14)
    expect(plan.rx * plan.rz).toBeGreaterThanOrEqual(bare.rx * bare.rz)
    const outline = makeOutline(hashString(g.id), plan.rx, plan.rz, 0.06)
    for (const a of plan.assets) expect(outline.contains(a.x, a.z, 1)).toBe(true)
  })

  it('give the same plan for the same snapshot, whatever order the resources arrive in', () => {
    const g = pillar()
    const list = [asset({ id: 'z1', service: null }), asset({ id: 'a1', service: null }), asset({ id: 'm1', service: null })]
    const one = planIsland({ ...g, assets: list } as never).assets.map((a) => [a.asset.id, a.x, a.z])
    const two = planIsland({ ...g, assets: [...list].reverse() } as never).assets.map((a) => [a.asset.id, a.x, a.z])

    expect(two).toEqual(one)
  })

  it('open a card that says what it is and where it belongs, with no health and its addresses', () => {
    const s = withAssets([asset()])
    const sum = summariseAsset('aa.kv-ord', s.groups)!

    expect(sum).toMatchObject({ name: 'kv-ord', label: 'Key vault', service: 'orders', region: 'northeurope', group: s.groups[0]!.id })
    expect(assetWhere(sum)).toBe(`Resource of the orders service on ${s.groups[0]!.displayName}`)
    expect(assetWhere({ groupName: 'Alpha', service: null })).toBe('Resource of Alpha')
    expect(sum.links).toEqual([{ name: 'Portal', url: 'https://portal.example.test/x' }])
    expect(summariseAsset('gone', s.groups)).toBeNull()
  })
  describe('on the hub island', () => {
    const hubAsset = (id: string, group: string | null, patch: Record<string, unknown> = {}) => asset({ id, name: id, label: 'Log workspace', shape: 'observatory', service: null, group, ...patch })
    const land = () => (r: { x: number; z: number; w: number; d: number }) => Math.abs(r.x) + r.w / 2 < 40 && Math.abs(r.z) + r.d / 2 < 36

    it('keep their group and the new shape through the snapshot check', () => {
      const raw = withAssets([hubAsset('hub.law', 'Monitoring'), hubAsset('hub.odd', '', { shape: 'castle' })])

      const assets = checkSnapshot(raw).snapshot!.groups[0]!.assets!

      expect(assets.map((a) => [a.id, a.shape, a.group])).toEqual([['hub.law', 'observatory', 'Monitoring'], ['hub.odd', 'box', null]])
    })

    it('stand together by group, ordered by id, one cluster for each group', () => {
      const { clusters, left } = placeHubClusters([hubAsset('hub.b', 'Monitoring'), hubAsset('hub.a', 'Monitoring'), hubAsset('hub.z', 'Other')] as never, 30, 28, 2, land())

      expect(left).toEqual([])
      expect(clusters.map((c) => [c.name, c.assets.map((a) => a.asset.id)])).toEqual([['Monitoring', ['hub.a', 'hub.b']], ['Other', ['hub.z']]])
    })

    it('never overlap each other or a taken place, and stay inside the land', () => {
      const taken = { x: 0, z: 2, w: 20, d: 20 }
      const many = ['A', 'B', 'C'].flatMap((g) => Array.from({ length: 5 }, (_, i) => hubAsset(`hub.${g}${i}`, g)))
      const { clusters } = placeHubClusters(many as never, 30, 28, 2, (r) => land()(r) && !rectsTouch(r, taken))

      expect(clusters).toHaveLength(3)
      for (const c of clusters) {
        expect(rectsTouch(c, taken)).toBe(false)
        expect(land()(c)).toBe(true)
      }
      for (const [i, a] of clusters.entries()) for (const b of clusters.slice(i + 1)) expect(rectsTouch(a, b)).toBe(false)
    })

    it('wrap into rows and keep every building inside its cluster, spaced apart', () => {
      const six = Array.from({ length: 6 }, (_, i) => hubAsset(`hub.s${i}`, 'Monitoring'))
      const { clusters: [c] } = placeHubClusters(six as never, 30, 28, 2, land())

      const size = clusterSize(6)
      expect(c!.w).toBe(size.w)
      expect(new Set(c!.assets.map((a) => `${a.x.toFixed(1)}/${a.z.toFixed(1)}`)).size).toBe(6)
      expect(new Set(c!.assets.map((a) => a.z)).size).toBe(Math.ceil(6 / CLUSTER_PER_ROW))
      for (const a of c!.assets) expect(Math.abs(a.x - c!.x) <= c!.w / 2 && Math.abs(a.z - c!.z) <= c!.d / 2).toBe(true)
    })

    it('leave out, and name, a cluster that has nowhere to stand', () => {
      const { clusters, left } = placeHubClusters([hubAsset('hub.a', 'Monitoring')] as never, 30, 28, 2, () => false)

      expect(clusters).toEqual([])
      expect(left).toEqual(['Monitoring'])
    })

    it('give the same hub for the same snapshot, whatever order the resources arrive in', () => {
      const list = [hubAsset('hub.z', 'M'), hubAsset('hub.a', 'M'), hubAsset('hub.m', 'N')]
      const one = placeHubClusters(list as never, 30, 28, 2, land()).clusters.map((c) => [c.name, c.x, c.z])
      const two = placeHubClusters([...list].reverse() as never, 30, 28, 2, land()).clusters.map((c) => [c.name, c.x, c.z])

      expect(two).toEqual(one)
    })

    it('open a card that names the cluster and has only the addresses', () => {
      const s = withAssets([hubAsset('hub.law', 'Monitoring', { links: [{ name: 'Portal', url: 'https://portal.example.test/law' }] })])
      const sum = summariseAsset('hub.law', s.groups)!

      expect(sum.cluster).toBe('Monitoring')
      expect(assetWhere(sum)).toBe(`Monitoring resource on ${s.groups[0]!.displayName}`)
      expect(sum.links).toEqual([{ name: 'Portal', url: 'https://portal.example.test/law' }])
    })
  })
})

describe('times of jobs name the day when it is not today', () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 7).toISOString()
  const now = new Date(2026, 9, 31, 19, 54).getTime()

  it('shows only the time for today, without seconds', () => {
    expect(dayTime(at(2026, 10, 31, 19, 49), now)).toBe('19:49')
    expect(dayTime(at(2026, 10, 31, 0, 0), now)).toBe('00:00')
  })

  it('says yesterday and tomorrow for the days either side', () => {
    expect(dayTime(at(2026, 10, 31 - 1), now)).toBe('yesterday 00:00')
    expect(dayTime(at(2026, 11, 1), now)).toBe('tomorrow 00:00')
  })

  it('gives the date for any other day, across a month end', () => {
    expect(dayTime(at(2026, 10, 29, 6, 5), now)).toBe('29 Oct 06:05')
    expect(dayTime(at(2026, 11, 3, 12, 30), now)).toBe('3 Nov 12:30')
  })

  it('gives nothing for a time that is not one', () => {
    expect(dayTime('soon', now)).toBe('')
  })

  it('puts the day on the job rows and in the reasons', () => {
    const n = fn({ state: 'Down', jobs: [{ ...job('daily', 'Overdue', 'North'), lastRun: at(2026, 10, 30), next: at(2026, 10, 31) }] })

    expect(jobRows(n, now)[0]!.value).toBe('overdue · ran yesterday 00:00 · next 00:00')
    expect(jobReasons(n, now)[0]).toBe('Job daily (North) should have run at 00:00 and has not.')
  })

})
