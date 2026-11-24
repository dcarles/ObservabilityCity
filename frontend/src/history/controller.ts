// Time travel: what moment the page looks at, how fast that moment moves, and which recorded frame is on screen. It asks the server for frames, keeps a few ahead of
// the viewed time, and hands each one to the page as if the live feed had sent it. While it is looking at the past the page ignores the live feed; going back to live
// reads the newest snapshot once and lets the feed carry on. Starting is always live: nothing here is remembered between visits.

import { scopeParams, type Scope } from '../scope'
import { advance, frameFor, isSpeed, SPEEDS, type Frame, type HistoryFill, type HistoryPoint, type HistoryRange, type Speed, type Waiting } from './model'

export interface HistoryHost {
  scope: Scope
  /** The islands the page filters to (the live feed is filtered by the server; a recorded frame is the whole town). */
  islands: () => readonly string[]
  /** Hands a snapshot to the page as if the server had sent it. */
  feed: (raw: unknown) => void
  /** Called before the frame of a jump is asked for, so the page can get ready for it (see liveShape.ts). */
  prepare?: () => Promise<void>
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
  points: { at: number; unhealthy: number; down: number; rebuilt: boolean }[]
  /** How the filling of the gaps from the cloud stands; null until read, or where the server cannot fill. */
  fill: HistoryFill | null
  /** True while the viewed moment is a gap the server is rebuilding: the loading card shows and the clock waits. */
  filling: boolean
  /** While filling: how many hours come before this one and how long an hour takes; null otherwise. */
  waiting: Waiting | null
  /** True while the frame on screen was rebuilt from the cloud: an approximation. */
  rebuilt: boolean
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
  /** Set by a jump: where the travel came from and went to, for the animation. Changes with every jump. Quiet: a step to the next or previous frame, which plays no animation and takes no car or boat away. */
  travel: { from: number; to: number; id: number; quiet?: boolean } | null
}

const TICK_MS = 250
const AHEAD_FRAMES = 12
const MIN_AHEAD = 4
const RETRY_MS = 5000
const FILL_POLL_MS = 3000
const FILL_WAIT_TRIES = 100

export class HistoryController {
  private s: HistoryState = {
    enabled: false, days: 7, intervalMs: 300_000, oldest: null, newest: null, frames: 0, bytes: 0, points: [], fill: null, filling: false, waiting: null, rebuilt: false,
    active: false, viewed: 0, speed: 1, paused: false, loading: false, noData: false, travel: null,
  }
  private readonly listeners = new Set<() => void>()
  private frames: Frame[] = []
  private shown: number | null = null
  private seq = 0
  private travelId = 0
  private fetching = false
  /** The hour (as asked of the server) this page is waiting for and has not been given, so leaving takes the ask back. */
  private pendingAsk: string | null = null
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
        points: range.points.map((p: HistoryPoint) => ({ at: Date.parse(p.at), unhealthy: p.unhealthy, down: p.down, rebuilt: p.rebuilt === true })),
      })
      if (range.enabled) void this.loadFill()
      return range.enabled
    } catch {
      this.set({ enabled: false })
      return false
    }
  }

  /** Reads how the filling of the gaps stands. A server that cannot say leaves it unknown. With a moment, also how many hours come before its hour. */
  async loadFill(at?: number): Promise<HistoryFill | null> {
    try {
      const r = await fetch(`/api/history/fill${this.query(at === undefined ? {} : { at: new Date(at).toISOString() })}`)
      if (!r.ok) return null
      const fill = (await r.json()) as HistoryFill
      this.set(at === undefined ? { fill } : { fill, waiting: { ahead: fill.ahead ?? null, building: fill.building === true, secondsPerHour: fill.secondsPerHour ?? null } })
      return fill
    } catch { return null }
  }

  /** Takes back the ask for an hour that was not given: the person left it, so it is filled in the normal order instead of ahead of the recent hours. */
  private async withdraw(): Promise<void> {
    const asked = this.pendingAsk
    this.pendingAsk = null
    if (asked === null) return
    try { await fetch(`/api/history/fill/priority${this.query({ at: asked })}`, { method: 'DELETE' }) } catch { /* the hour is only filled a little earlier than needed */ }
  }

  /**
   * A moment with no frame, on a server that can rebuild it: asks for that hour to be done next and waits for it, asking again every few seconds, until the frame is there or the filling
   * has stopped with nothing for it. The page shows the loading card meanwhile and the clock does not run; leaving the moment (another jump, going live) ends the wait and takes the ask back.
   */
  private async waitForRebuild(at: number, mine: number): Promise<Frame | null> {
    const fill = await this.loadFill()
    if (!fill?.available || mine !== this.seq) return null
    this.set({ filling: true, waiting: null })
    let got = false
    try {
      const asked = new Date(at).toISOString()
      await fetch(`/api/history/fill/priority${this.query({ at: asked })}`, { method: 'POST' })
      this.pendingAsk = asked
      if (mine !== this.seq) { await this.withdraw(); return null } // the person left while the ask was on its way
      await this.loadFill(at)
      for (let i = 0; i < FILL_WAIT_TRIES; i++) {
        await new Promise((resolve) => setTimeout(resolve, FILL_POLL_MS))
        if (mine !== this.seq) return null
        const frame = await this.fetchFrame(at)
        if (frame) { got = true; return frame }
        const now = await this.loadFill(at)
        if (mine !== this.seq) return null
        if (now && !now.running && i > 0) return null // the filling has stopped and this moment is not in it: nothing could be rebuilt
      }
      return null
    } catch { return null } finally {
      if (got) this.pendingAsk = null // the hour was built: nothing is waiting any more
      if (mine === this.seq) {
        this.set({ filling: false, waiting: null })
        if (!got) await this.withdraw()
      }
    }
  }

  /** Goes to a moment in the past. Beyond the limit it is held at the limit; at (or within seconds of) now it is just going live. */
  async goTo(at: number, options: { paused?: boolean; quiet?: boolean } = {}): Promise<void> {
    if (!this.s.enabled) return
    if (this.pendingAsk !== null) await this.withdraw() // the hour that was waited for is no longer wanted first
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
    this.set({ active: true, viewed: at, paused: options.paused ?? false, loading: true, noData: false, travel: { from, to: at, id: this.travelId, quiet: options.quiet } })
    this.start()
    await this.host.prepare?.()
    if (mine !== this.seq) return
    let frame = await this.fetchFrame(at)
    if (mine !== this.seq) return
    if (frame) this.frames = [frame]
    this.set({ loading: false })
    this.show()
    if (!frame) {
      // a gap the server can fill: ask for it and show the loading card until it is there
      frame = await this.waitForRebuild(at, mine)
      if (mine !== this.seq) return
      if (frame) { this.frames = [frame]; this.show() }
      void this.loadRange()
    }
    void this.ensureAhead()
  }

  /** Back to live: reads the newest snapshot once, then the live feed carries on. */
  async goLive(): Promise<void> {
    const wasActive = this.s.active
    const from = this.s.viewed
    ++this.seq
    void this.withdraw()
    this.stop()
    this.frames = []
    this.shown = null
    this.set({ active: false, loading: false, noData: false, filling: false, waiting: null, rebuilt: false, paused: false, travel: wasActive ? { from, to: this.now(), id: ++this.travelId } : this.s.travel })
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
    void this.goTo(target, { paused: true, quiet: true })
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
    if (!this.s.active || this.s.loading || this.s.filling) return // the clock waits for an hour that is being rebuilt
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
    if (this.s.rebuilt !== (f.rebuilt === true)) this.set({ rebuilt: f.rebuilt === true })
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
      const body = (await r.json()) as { at: string; snapshot: unknown; rebuilt?: boolean }
      return { at: Date.parse(body.at), snapshot: body.snapshot, rebuilt: body.rebuilt === true }
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
      const body = (await r.json()) as { frames: { at: string; snapshot: unknown; rebuilt?: boolean }[] }
      const more = body.frames.map((f) => ({ at: Date.parse(f.at), snapshot: f.snapshot, rebuilt: f.rebuilt === true }))
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
