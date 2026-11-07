import * as signalR from '@microsoft/signalr'
import { scopeParams, type Scope } from './scope'

export { requestedEnv } from './scope'

/** Sent when the server has no town or environment by the name asked for: the page stays empty rather than showing another one. */
export interface EnvironmentUnknown {
  requested: string | null
  requestedTown?: string | null
  environments: string[]
  towns?: string[]
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'badData' | 'silent'

/** The server sends a snapshot at least every 15 s (Snapshot:KeepAliveSeconds), so this long without one means the feed is stuck, whatever the socket says. */
export const SILENT_AFTER_MS = 45_000

/** The words for a feed that has gone quiet. */
export const SILENT_WORDS = `No update for over ${SILENT_AFTER_MS / 1000} s`

/** Greys the whole page while the feed is silent, so old numbers are never read as current. */
export function markFeed(state: ConnectionState): void {
  if (typeof document !== 'undefined') document.body.classList.toggle('feed-silent', state === 'silent')
}

export interface ConnectionOptions {
  /** Never give up on the live socket: after it was lost for good, keep trying to open it again. For a screen nobody is there to refresh. */
  persistent?: boolean
  /** Milliseconds between two tries of a persistent connection. */
  retryMs?: number
  /** Milliseconds without any snapshot before the state turns to 'silent'. Default {@link SILENT_AFTER_MS}. */
  silentAfterMs?: number
}

/**
 * Receives snapshots from the backend over SignalR. If the socket cannot be opened (a proxy in the way,
 * say) it falls back to polling the same snapshot over plain HTTP, so the town still moves. A persistent connection
 * also keeps trying to open the socket again, and stops polling once it has.
 */
export class Connection {
  state: ConnectionState = 'connecting'
  /** How many times the socket was opened, the first time included. For tests. */
  opened = 0
  private poll: number | undefined
  private retry: number | undefined
  private unknown = false
  private lastSeen = Date.now()
  private muted = false
  private watchdog: number | undefined
  private hub: signalR.HubConnection | undefined

  constructor(
    private readonly onSnapshot: (s: unknown) => void,
    private readonly onState: (s: ConnectionState) => void,
    private readonly scope: Scope = { town: null, env: null },
    private readonly onUnknown: (e: EnvironmentUnknown) => void = () => {},
    private islands: readonly string[] = [],
    private readonly options: ConnectionOptions = {},
  ) {}

  private query(): string {
    const q = new URLSearchParams(scopeParams(this.scope))
    if (this.islands.length > 0) q.set('islands', this.islands.join(','))
    const text = q.toString()
    return text ? `?${text}` : ''
  }

  /**
   * Looks at other islands, without reconnecting. The server answers with the town as the new filter shows it; while the socket is down,
   * the polling asks for the same.
   */
  setIslands(ids: readonly string[]): void {
    this.islands = ids
    if (this.hub?.state === signalR.HubConnectionState.Connected) void this.hub.invoke('SetIslands', [...ids]).catch((e) => console.warn('Could not change the islands:', e))
    else if (this.poll !== undefined) void this.pollOnce()
  }

  start(): void {
    const hub = new signalR.HubConnectionBuilder()
      .withUrl(`/hubs/town${this.query()}`)
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
      .configureLogging(signalR.LogLevel.Warning)
      .build()

    this.watch()
    hub.on('snapshot', (s: unknown) => {
      if (this.muted) return
      this.heard()
      this.set('live')
      this.onSnapshot(s)
    })
    hub.on('environmentUnknown', (e: EnvironmentUnknown) => {
      this.heard()
      this.unknown = true
      this.set('live')
      this.onUnknown(e)
    })
    hub.onreconnecting(() => this.set('reconnecting'))
    hub.onreconnected(() => {
      this.set('live')
      // the server forgot the filter along with the old connection
      if (this.islands.length > 0) void hub.invoke('SetIslands', [...this.islands]).catch((e) => console.warn('Could not restore the islands:', e))
    })
    hub.onclose(() => {
      if (this.hub !== hub) return
      this.set('offline')
      this.startPolling()
      this.tryAgainLater()
    })

    this.hub = hub
    const askedWith = this.islands.join(',')
    hub.start().then(() => {
      this.opened++
      this.stopPolling()
      // a first snapshot can already have moved the choice (islands the town does not have are let go) before the socket reported itself open
      if (this.islands.join(',') !== askedWith) void hub.invoke('SetIslands', [...this.islands]).catch((e) => console.warn('Could not change the islands:', e))
    }).catch(() => {
      if (this.hub !== hub) return
      this.set('offline')
      this.startPolling()
      this.tryAgainLater()
    })
  }

  /** For tests: while muted, snapshots are thrown away before anything else sees them, which is what a feed that carries nothing looks like. */
  mute(muted: boolean, silentAfterMs?: number): void {
    this.muted = muted
    if (silentAfterMs !== undefined) (this.options as { silentAfterMs?: number }).silentAfterMs = silentAfterMs
  }

  /** For tests: closes the socket the way a lost connection would, so the fallback and the retrying can be watched. */
  async drop(): Promise<void> {
    await this.hub?.stop()
  }

  /** A persistent connection opens the socket again after a pause, however many times that fails. */
  private tryAgainLater(): void {
    if (!this.options.persistent || this.retry !== undefined) return
    this.retry = window.setTimeout(() => {
      this.retry = undefined
      this.start()
    }, this.options.retryMs ?? 5000)
  }

  private startPolling(): void {
    if (this.poll !== undefined) return
    void this.pollOnce()
    this.poll = window.setInterval(() => void this.pollOnce(), 2000)
  }

  private stopPolling(): void {
    if (this.poll === undefined) return
    window.clearInterval(this.poll)
    this.poll = undefined
  }

  private async pollOnce(): Promise<void> {
    try {
      const r = await fetch(`/api/snapshot/latest${this.query()}`)
      if (r.ok && !this.muted) {
        this.heard()
        this.set('live')
        this.onSnapshot(await r.json())
      } else if (r.status === 404 && !this.unknown) {
        const body = (await r.json()) as { environments?: string[]; towns?: string[] }
        this.unknown = true
        this.onUnknown({ requested: this.scope.env, requestedTown: this.scope.town, environments: body.environments ?? [], towns: body.towns })
      }
    } catch {
      this.set('offline')
    }
  }

  private heard(): void {
    this.lastSeen = Date.now()
  }

  /** Once a second: a live feed that has said nothing for too long is 'silent'. A snapshot, from the socket or the polling, brings it back. */
  private watch(): void {
    if (this.watchdog !== undefined) return
    this.lastSeen = Date.now()
    this.watchdog = window.setInterval(() => {
      if (this.state === 'live' && Date.now() - this.lastSeen > (this.options.silentAfterMs ?? SILENT_AFTER_MS)) this.set('silent')
    }, 1000)
  }

  private set(s: ConnectionState): void {
    if (s === this.state) return
    this.state = s
    this.onState(s)
  }
}
