// Time travel: what moment the page looks at, how fast that moment moves, and which recorded frame is on screen. It asks the server for frames, keeps a few ahead of
// the viewed time, and hands each one to the page as if the live feed had sent it. While it is looking at the past the page ignores the live feed; going back to live
// reads the newest snapshot once and lets the feed carry on. Starting is always live: nothing here is remembered between visits.

import { scopeParams, type Scope } from '../scope'
import { advance, frameFor, isSpeed, SPEEDS, type Frame, type HistoryPoint, type HistoryRange, type Speed } from './model'

export interface HistoryHost {
  scope: Scope
  /** The islands the page filters to (the live feed is filtered by the server; a recorded frame is the whole town). */
  islands: () => readonly string[]
  /** Hands a snapshot to the page as if the server had sent it. */
  feed: (raw: unknown) => void
}

export interface HistoryState {
  /** Whether this environment keeps a history at all (false: no clock button). */
  enabled: boolean
  days: number
  intervalMs: number
  /** The first and last recorded frame (ms), and every frame's counts for the strip. */
  oldest: number | null
  newest: number | null
  frames: number
  bytes: number
  points: { at: number; unhealthy: number; down: number }[]
  /** True while the page looks at the past. */
  active: boolean
  /** The moment being looked at (ms since 1970); meaningful while active. */
  viewed: number
  speed: Speed
  paused: boolean
  /** True while a frame is being fetched for a jump. */
  loading: boolean
  /** True while the viewed moment has no recorded frame. */
  noData: boolean
  /** Set by a jump: where the travel came from and went to, for the animation. Changes with every jump. */
  travel: { from: number; to: number; id: number } | null
}

const TICK_MS = 250
const AHEAD_FRAMES = 12
const MIN_AHEAD = 4
const RETRY_MS = 5000

export class HistoryController {
  private s: HistoryState = {
    enabled: false, days: 7, intervalMs: 300_000, oldest: null, newest: null, frames: 0, bytes: 0, points: [],
    active: false, viewed: 0, speed: 1, paused: false, loading: false, noData: false, travel: null,
  }
  private readonly listeners = new Set<() => void>()
  private frames: Frame[] = []
  private shown: number | null = null
  private seq = 0
  private travelId = 0
  private fetching = false
  private retryAfter = 0
  private timer: number | undefined
  private lastTick = 0

  constructor(private readonly host: HistoryHost, private readonly now: () => number = () => Date.now()) {}

  get state(): HistoryState {
    return this.s
  }

  /** True while the page looks at the past: the live feed is then ignored. */
  get active(): boolean {
    return this.s.active
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<HistoryState>): void {
    this.s = { ...this.s, ...patch }
    for (const l of this.listeners) l()
  }

  private query(extra: Record<string, string> = {}): string {
    const q = new URLSearchParams(scopeParams(this.host.scope))
    for (const [k, v] of Object.entries(extra)) q.set(k, v)
    const text = q.toString()
    return text ? `?${text}` : ''
  }

  /** Reads what is recorded. Returns false when the server keeps no history here (an old server, a demo town, history off). */
  async loadRange(): Promise<boolean> {
    try {
      const r = await fetch(`/api/history/range${this.query()}`)
      if (!r.ok) { this.set({ enabled: false }); return false }
      const range = (await r.json()) as HistoryRange
      this.set({
        enabled: range.enabled,
        days: range.days,
        intervalMs: range.intervalSeconds * 1000,
        oldest: range.oldest ? Date.parse(range.oldest) : null,
        newest: range.newest ? Date.parse(range.newest) : null,
        frames: range.frames,
        bytes: range.bytes,
        points: range.points.map((p: HistoryPoint) => ({ at: Date.parse(p.at), unhealthy: p.unhealthy, down: p.down })),
      })
      return range.enabled
    } catch {
      this.set({ enabled: false })
      return false
    }
  }

  /** Goes to a moment in the past. Beyond the limit it is held at the limit; at (or within seconds of) now it is just going live. */
  async goTo(at: number, options: { paused?: boolean } = {}): Promise<void> {
    if (!this.s.enabled) return
    const now = this.now()
    const oldestAllowed = now - this.s.days * 86_400_000
    if (at >= now - 5_000) return this.goLive()
    at = Math.max(at, oldestAllowed)
    const mine = ++this.seq
    const from = this.s.active ? this.s.viewed : now
    this.frames = []
    this.shown = null
    this.retryAfter = 0
    this.travelId++
    this.set({ active: true, viewed: at, paused: options.paused ?? false, loading: true, noData: false, travel: { from, to: at, id: this.travelId } })
    this.start()
    const frame = await this.fetchFrame(at)
    if (mine !== this.seq) return
    if (frame) this.frames = [frame]
    this.set({ loading: false })
    this.show()
    void this.ensureAhead()
  }

  /** Back to live: reads the newest snapshot once, then the live feed carries on. */
  async goLive(): Promise<void> {
    const wasActive = this.s.active
    const from = this.s.viewed
    ++this.seq
    this.stop()
    this.frames = []
    this.shown = null
    this.set({ active: false, loading: false, noData: false, paused: false, travel: wasActive ? { from, to: this.now(), id: ++this.travelId } : this.s.travel })
    if (!wasActive) return
    try {
      const islands = this.host.islands()
      const q = new URLSearchParams(scopeParams(this.host.scope))
      if (islands.length > 0) q.set('islands', islands.join(','))
      const text = q.toString()
      const r = await fetch(`/api/snapshot/latest${text ? `?${text}` : ''}`)
      if (r.ok && !this.s.active) this.host.feed(await r.json())
    } catch { /* the live feed brings the next one */ }
  }

  setSpeed(speed: number): void {
    if (isSpeed(speed)) this.set({ speed })
  }

  setPaused(paused: boolean): void {
    if (this.s.active) this.set({ paused })
  }

  /** One frame on, or one back, while looking at the past: lands exactly on a recorded moment. */
  step(direction: 1 | -1): void {
    if (!this.s.active) return
    const gap = this.s.intervalMs
    const slot = Math.floor(this.s.viewed / gap) * gap
    const target = direction === 1 ? slot + gap : (this.s.viewed === slot ? slot - gap : slot)
    if (target >= this.now()) { void this.goLive(); return }
    void this.goTo(target, { paused: true })
  }

  /** Reads the range again (the popup does this when it opens, so the strip is as new as the recorder). */
  refresh(): Promise<boolean> {
    return this.loadRange()
  }

  dispose(): void {
    this.stop()
    this.listeners.clear()
  }

  // ---- playing

  private start(): void {
    if (this.timer !== undefined) return
    this.lastTick = performance.now()
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  private stop(): void {
    if (this.timer === undefined) return
    window.clearInterval(this.timer)
    this.timer = undefined
  }

  /** One step of the clock. Public so a test can drive time itself. */
  tick(realMs?: number): void {
    const t = performance.now()
    const dt = realMs ?? t - this.lastTick
    this.lastTick = t
    if (!this.s.active || this.s.loading) return
    const next = advance(this.s.viewed, dt, this.s.speed, this.s.paused, this.now())
    if (next.caughtUp) { void this.goLive(); return }
    if (next.viewed !== this.s.viewed) this.set({ viewed: next.viewed })
    this.show()
    void this.ensureAhead()
  }

  /** Puts the frame for the viewed moment on the page when it is not already there; says so when there is none. */
  private show(): void {
    const f = frameFor(this.frames, this.s.viewed, this.s.intervalMs)
    if (f === null) {
      if (!this.s.noData) this.set({ noData: true })
      return
    }
    if (this.s.noData) this.set({ noData: false })
    if (this.shown === f.at) return
    this.shown = f.at
    this.host.feed(f.snapshot)
    // what is behind the viewed time is not needed again
    this.frames = this.frames.filter((x) => x.at >= f.at)
  }

  private async fetchFrame(at: number): Promise<Frame | null> {
    try {
      const r = await fetch(`/api/history/frame${this.query({ at: new Date(at).toISOString() })}`)
      if (!r.ok) return null
      const body = (await r.json()) as { at: string; snapshot: unknown }
      return { at: Date.parse(body.at), snapshot: body.snapshot }
    } catch { return null }
  }

  /** Keeps frames ready ahead of the viewed time, so playing never waits for the network. */
  private async ensureAhead(): Promise<void> {
    if (this.fetching || !this.s.active || this.now() < this.retryAfter) return
    const last = this.frames[this.frames.length - 1]
    const ahead = last ? last.at - this.s.viewed : 0
    if (last && ahead >= MIN_AHEAD * this.s.intervalMs) return
    this.fetching = true
    const mine = this.seq
    try {
      const from = last ? last.at + 1 : this.s.viewed
      const r = await fetch(`/api/history/frames${this.query({ from: new Date(from).toISOString(), count: String(AHEAD_FRAMES) })}`)
      if (mine !== this.seq) return
      if (!r.ok) { this.retryAfter = this.now() + RETRY_MS; return }
      const body = (await r.json()) as { frames: { at: string; snapshot: unknown }[] }
      const more = body.frames.map((f) => ({ at: Date.parse(f.at), snapshot: f.snapshot }))
      if (more.length === 0) this.retryAfter = this.now() + RETRY_MS // nothing newer is recorded yet
      this.frames = [...this.frames, ...more.filter((f) => !this.frames.some((x) => x.at === f.at))]
      this.show()
    } catch {
      this.retryAfter = this.now() + RETRY_MS
    } finally {
      this.fetching = false
    }
  }
}

export { SPEEDS }
