import { expect, type APIRequestContext, type Page } from '@playwright/test'

// Helpers shared by the browser tests. The page exposes window.city (see frontend/src/main.ts); with ?test=1 nothing is drawn
// on its own and time only moves when a test calls city.step(seconds), so a test reads the scene's state, not pixels.

export const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 5290}`

export type BeaconLevel = 'green' | 'amber' | 'red' | 'grey' | 'off'

export interface Status {
  id: string
  kind: string
  state: 'Healthy' | 'Degraded' | 'Down' | 'Stale'
  beacon: BeaconLevel
  beaconSteady: boolean
  floors: number
  darkFloors: number
  litFloors: number
  closedSign: boolean
  barrierDown: boolean | null
  plaque: string
  bubble: { visible: boolean; honk: boolean; waiting: number } | null
  /** Only a data store with a database for each tenant. */
  tenants: TenantYard | null
  /** The app is stopped: a half-built shell in scaffolding, unlit, with no beacon. */
  underConstruction: boolean
  /** Which region the building's numbers are, for a service in two or more; empty otherwise. */
  region: string
}

export interface TenantYard {
  units: { id: string; level: BeaconLevel; test: boolean; unknown: boolean; shown: boolean; dimmed: boolean; throttled: boolean; fill: number }[]
  sign: { text: string; note: string }
}

export interface IslandStatus {
  id: string
  buildings: number
  /** The kind of every building on the island (Api, Worker, Database, ...). */
  kinds: string[]
  configError: string | null
  /** A bridge to the hub, a pier, and a sea lane for boats from the Service Bus port. */
  bridge: boolean
  pier: boolean
  lane: boolean
  /** How many car routes cross the island's bridge. */
  crossings: number
  crates: number
  brokenCrates: number
  alarm: boolean
  /** The amber pennant: a worker here still reads the hub's egress topic. */
  pennant: boolean
}

export interface HubStatus {
  topics: number
  subscriptions: number
  piers: number
  legacy: number
  /** Islands with a sea lane. */
  boats: number
  /** `counts` is the last line of the broker's one billboard: null when nothing is configured or the Messaging layer is off. */
  sign: { board: string; model: string | null; counts: string | null }
}

export interface NodeView {
  id: string
  state: string
  errorRate: number
  requestsPerSecond: number
  throttled: number | null
  oldestMessageSeconds: number | null
  deadLetters: number | null
  queueDepth: number | null
  p99Ms: number
  slaP99Ms: number
}

export class Town {
  /** The environment the page and the fake-source calls are about; null is the server's default. A test that wants another sets it before `open`. */
  env: string | null = null

  constructor(readonly page: Page, readonly request: APIRequestContext) {}

  /** The town the page and the fake-source calls are about; null is the server's default. A test that wants another sets it before `open`. */
  townId: string | null = null

  /** The `town=` and `env=` parameters (no leading ? or &) that aim a request at the town and environment under test. */
  scope(env: string | null = this.env): string {
    const q = new URLSearchParams()
    if (this.townId) q.set('town', this.townId)
    if (env) q.set('env', env)
    return q.toString()
  }

  /** `?town=&env=` for the API calls of the environment under test. */
  private get envQuery(): string {
    const q = this.scope()
    return q ? `?${q}` : ''
  }

  /** Opens the page in test mode against a calm, clean town and waits for the first snapshot. */
  async open(query = ''): Promise<void> {
    await this.reset()
    const scope = this.scope()
    await this.page.goto(`/?test=1&quality=low${scope ? `&${scope}` : ''}${query}`)
    await this.page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    // The first snapshot can predate the reset (a node still stale or down from the last test). Start from one that is calm.
    await this.page.waitForFunction(
      () => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).every((n: any) => n.state === 'Healthy'),
      null,
      { timeout: 20_000, polling: 100 },
    )
  }

  /** Back to a calm baseline: no effects, no backlog or dead letters left over, noise frozen. */
  async reset(): Promise<void> {
    // calm first: a poll that lands between the two calls must not see the noisy baseline
    // every environment, not only the one under test: another test may have left one disturbed
    const town = this.townId ? `?town=${encodeURIComponent(this.townId)}` : ''
    const listed = await this.request.get(`${API}/api/environments${town}`)
    const ids = listed.ok() ? ((await listed.json()) as { id: string }[]).map((e) => `?${this.scope(e.id)}`) : [town]
    for (const q of ids) {
      expect((await this.request.post(`${API}/api/fake/calm${q}`, { data: { on: true } })).ok()).toBe(true)
      expect((await this.request.post(`${API}/api/fake/reset${q}`)).ok()).toBe(true)
    }
  }

  async effect(target: string, kind: string, intensity = 1): Promise<string> {
    const r = await this.request.post(`${API}/api/fake/effects${this.envQuery}`, { data: { target, kind, intensity } })
    expect(r.ok(), await r.text()).toBe(true)
    return ((await r.json()) as { id: string }).id
  }

  /** Removes one effect or, with no id, all of them. The backlog and dead letters they caused stay until they drain or are reset. */
  async removeEffects(id?: string): Promise<void> {
    const r = await this.request.delete(`${API}/api/fake/effects${id ? `/${id}` : ''}${this.envQuery}`)
    expect(r.ok()).toBe(true)
  }

  /** Runs the scene's clock forward. Eased values (lights, floors, beacons) settle, cars drive. */
  async step(seconds: number): Promise<void> {
    await this.page.evaluate((s) => (window as any).city.step(s), seconds)
  }

  async inspect(id: string): Promise<Status> {
    const s = await this.page.evaluate((i) => (window as any).city.inspect(i), id)
    expect(s, `no building ${id}`).not.toBeNull()
    return s as Status
  }

  async island(id: string): Promise<IslandStatus> {
    const s = await this.page.evaluate((i) => (window as any).city.inspectIsland(i), id)
    expect(s, `no island ${id}`).not.toBeNull()
    return s as IslandStatus
  }

  /** What the Service Bus port shows. */
  async hub(): Promise<HubStatus> {
    return (await this.page.evaluate(() => (window as any).city.town.inspectHub())) as HubStatus
  }

  /** The greatest number of boats at sea at any moment while the clock runs the given seconds. */
  async mostBoats(seconds: number): Promise<number> {
    return await this.page.evaluate((total) => {
      const c = (window as any).city
      let most = 0
      for (let t = 0; t < total; t += 2) { c.step(2); most = Math.max(most, c.town.boats.count) }
      return most
    }, seconds)
  }

  /** The newest snapshot the page accepted, or the part of it a test asks for. */
  async node(id: string): Promise<NodeView> {
    return (await this.page.evaluate(
      (i) => (window as any).city.seen.last.groups.flatMap((g: any) => g.nodes).find((n: any) => n.id === i),
      id,
    )) as NodeView
  }

  /** Waits until a condition on the newest snapshot holds. The check must be a self-contained function of the node. */
  async until(id: string, check: (n: NodeView) => boolean, timeout = 40_000): Promise<void> {
    await this.page.waitForFunction(
      ([i, src]) => {
        const n = (window as any).city.seen.last?.groups.flatMap((g: any) => g.nodes).find((x: any) => x.id === i)
        // eslint-disable-next-line no-new-func
        return !!n && new Function('n', `return (${src})(n)`)(n)
      },
      [id, check.toString()] as const,
      { timeout, polling: 250 },
    )
  }

  /** Waits for the next snapshot, so a change made through the API has certainly been seen. */
  async nextSnapshot(): Promise<void> {
    const before = await this.page.evaluate(() => (window as any).city.seen.snapshots as number)
    await this.page.waitForFunction((n) => (window as any).city.seen.snapshots > n + 1, before, { timeout: 15_000 })
  }

  /** The tenant yard of a data store: its units and the sign. */
  async yard(id: string): Promise<TenantYard> {
    const s = await this.inspect(id)
    expect(s.tenants, `${id} has no tenant yard`).not.toBeNull()
    return s.tenants as TenantYard
  }

  /** The services on an island: the sign each shows and the systems on its pad. */
  async services(islandId: string): Promise<{ key: string; name: string; state: string | null; systems: string[] }[]> {
    return await this.page.evaluate((i) => (window as any).city.inspectServices(i), islandId)
  }

  async allBuildings(): Promise<Status[]> {
    return (await this.page.evaluate(() => {
      const c = (window as any).city
      return [...c.town.buildings.keys()].map((id: string) => c.inspect(id))
    })) as Status[]
  }
}
