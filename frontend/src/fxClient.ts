import type { StoryState, StorySummary } from './story'
import { scopeParams, type Scope } from './scope'

export interface FxEffect { id: string; target: string; kind: string; intensity: number }

/** What the generator is doing: effects set by hand, the story that plays, the calm switch and the length of a day. */
export interface FxState {
  calm: boolean
  dayLengthSeconds: number
  effects: FxEffect[]
  story: StoryState
}

/** Talks to the fake generator's steering endpoints for the town and environment the page shows. Every call ends with the state as it is then. */
export class FxClient {
  private listeners: ((s: FxState) => void)[] = []
  private timer: number | undefined
  state: FxState | null = null

  constructor(private readonly scope: Scope, private readonly pollMs = 600) {}

  private url(path: string): string {
    const query = scopeParams(this.scope)
    return `/api/fake${path}${query ? `?${query}` : ''}`
  }

  onState(fn: (s: FxState) => void): void {
    this.listeners.push(fn)
    if (this.state) fn(this.state)
  }

  /** Reads the state now and tells the listeners. A server that is not up yet is not an error: the next poll tries again. */
  async refresh(): Promise<FxState | null> {
    try {
      const r = await fetch(this.url(''))
      if (!r.ok) return this.state
      this.state = (await r.json()) as FxState
      for (const fn of this.listeners) fn(this.state)
    } catch { /* backend not up yet */ }
    return this.state
  }

  start(): void {
    if (this.timer !== undefined) return
    void this.refresh()
    this.timer = window.setInterval(() => void this.refresh(), this.pollMs)
  }

  async stories(): Promise<StorySummary[]> {
    try {
      const r = await fetch(this.url('/stories'))
      return r.ok ? ((await r.json()) as StorySummary[]) : []
    } catch { return [] }
  }

  /** Sends a change, then reads the state so the page shows what the server now does. */
  async send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<void> {
    try {
      await fetch(this.url(path), { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch { /* backend not reachable: the next poll shows it */ }
    await this.refresh()
  }

  addEffect(target: string, kind: string, intensity: number): Promise<void> { return this.send('POST', '/effects', { target, kind, intensity }) }
  setIntensity(id: string, intensity: number): Promise<void> { return this.send('PUT', `/effects/${id}`, { intensity }) }
  removeEffect(id: string): Promise<void> { return this.send('DELETE', `/effects/${id}`) }
  reset(): Promise<void> { return this.send('POST', '/reset') }
  setCalm(on: boolean): Promise<void> { return this.send('POST', '/calm', { on }) }
  setDay(seconds: number): Promise<void> { return this.send('POST', '/day', { seconds }) }
  play(id: string, speed?: number): Promise<void> { return this.send('POST', '/story/play', { id, speed }) }
  pause(): Promise<void> { return this.send('POST', '/story/pause') }
  resume(): Promise<void> { return this.send('POST', '/story/resume') }
  stop(): Promise<void> { return this.send('POST', '/story/stop') }
  seek(seconds: number): Promise<void> { return this.send('POST', '/story/seek', { seconds }) }
  setSpeed(speed: number): Promise<void> { return this.send('POST', '/story/speed', { speed }) }
}
