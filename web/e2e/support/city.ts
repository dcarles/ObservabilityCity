import { expect, type APIRequestContext, type Page } from '@playwright/test'

// Helpers shared by the browser tests. The page exposes window.city (see web/src/main.ts); with ?test=1 nothing is drawn
// on its own and time only moves when a test calls city.step(seconds), so a test reads the scene's state, not pixels.

export const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 5290}`

export type BeaconLevel = 'green' | 'amber' | 'red' | 'grey' | 'off'

export interface Status {
  id: string
  kind: string
  state: 'Healthy' | 'Degraded' | 'Down' | 'Stale'
  beacon: BeaconLevel
  floors: number
  darkFloors: number
  litFloors: number
  closedSign: boolean
  barrierDown: boolean | null
  plaque: string
  bubble: { visible: boolean; honk: boolean; waiting: number } | null
}

export interface IslandStatus {
  id: string
  buildings: number
  configError: string | null
  crates: number
  brokenCrates: number
  alarm: boolean
}

export interface NodeView {
  id: string
  state: string
  errorRate: number
  throttled: number | null
  oldestMessageSeconds: number | null
  deadLetters: number | null
  queueDepth: number | null
  p99Ms: number
  slaP99Ms: number
}

export class Town {
  constructor(readonly page: Page, readonly request: APIRequestContext) {}

  /** Opens the page in test mode against a calm, clean town and waits for the first snapshot. */
  async open(query = ''): Promise<void> {
    await this.reset()
    await this.page.goto(`/?test=1&quality=low${query}`)
    await this.page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  }

  /** Back to a calm baseline: no effects, no backlog or dead letters left over, noise frozen. */
  async reset(): Promise<void> {
    expect((await this.request.post(`${API}/api/fake/reset`)).ok()).toBe(true)
    expect((await this.request.post(`${API}/api/fake/calm`, { data: { on: true } })).ok()).toBe(true)
  }

  async effect(target: string, kind: string, intensity = 1): Promise<string> {
    const r = await this.request.post(`${API}/api/fake/effects`, { data: { target, kind, intensity } })
    expect(r.ok(), await r.text()).toBe(true)
    return ((await r.json()) as { id: string }).id
  }

  /** Removes one effect or, with no id, all of them. The backlog and dead letters they caused stay until they drain or are reset. */
  async removeEffects(id?: string): Promise<void> {
    const r = await this.request.delete(`${API}/api/fake/effects${id ? `/${id}` : ''}`)
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

  async allBuildings(): Promise<Status[]> {
    return (await this.page.evaluate(() => {
      const c = (window as any).city
      return [...c.town.buildings.keys()].map((id: string) => c.inspect(id))
    })) as Status[]
  }
}
