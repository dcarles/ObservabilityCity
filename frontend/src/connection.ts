import * as signalR from '@microsoft/signalr'

/** The environment asked for in the address (?env=), or null for the server's default. */
export function requestedEnv(search = window.location.search): string | null {
  return new URLSearchParams(search).get('env') || null
}

/** Sent when the server has no environment by the name asked for: the town stays empty rather than showing another one. */
export interface EnvironmentUnknown {
  requested: string | null
  environments: string[]
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'badData'

/**
 * Receives snapshots from the backend over SignalR. If the socket cannot be opened (a proxy in the way,
 * say) it falls back to polling the same snapshot over plain HTTP, so the town still moves.
 */
export class Connection {
  state: ConnectionState = 'connecting'
  private poll: number | undefined
  private unknown = false

  constructor(
    private readonly onSnapshot: (s: unknown) => void,
    private readonly onState: (s: ConnectionState) => void,
    private readonly env: string | null = null,
    private readonly onUnknown: (e: EnvironmentUnknown) => void = () => {},
    private islands: readonly string[] = [],
  ) {}

  private hub: signalR.HubConnection | undefined

  private query(): string {
    const q = new URLSearchParams()
    if (this.env) q.set('env', this.env)
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
    if (this.hub?.state === signalR.HubConnectionState.Connected) void this.hub.invoke('SetIslands', [...ids]).catch(() => {})
    else if (this.poll !== undefined) void this.pollOnce()
  }

  start(): void {
    const hub = new signalR.HubConnectionBuilder()
      .withUrl(`/hubs/town${this.query()}`)
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
      .configureLogging(signalR.LogLevel.Warning)
      .build()

    hub.on('snapshot', (s: unknown) => {
      this.set('live')
      this.onSnapshot(s)
    })
    hub.on('environmentUnknown', (e: EnvironmentUnknown) => {
      this.unknown = true
      this.set('live')
      this.onUnknown(e)
    })
    hub.onreconnecting(() => this.set('reconnecting'))
    hub.onreconnected(() => {
      this.set('live')
      // the server forgot the filter along with the old connection
      if (this.islands.length > 0) void hub.invoke('SetIslands', [...this.islands]).catch(() => {})
    })
    hub.onclose(() => {
      this.set('offline')
      this.startPolling()
    })

    this.hub = hub
    hub.start().catch(() => {
      this.set('offline')
      this.startPolling()
    })
  }

  private startPolling(): void {
    if (this.poll !== undefined) return
    void this.pollOnce()
    this.poll = window.setInterval(() => void this.pollOnce(), 2000)
  }

  private async pollOnce(): Promise<void> {
    try {
      const r = await fetch(`/api/snapshot/latest${this.query()}`)
      if (r.ok) {
        this.set('live')
        this.onSnapshot(await r.json())
      } else if (r.status === 404 && !this.unknown) {
        const body = (await r.json()) as { environments?: string[] }
        this.unknown = true
        this.onUnknown({ requested: this.env, environments: body.environments ?? [] })
      }
    } catch {
      this.set('offline')
    }
  }

  private set(s: ConnectionState): void {
    if (s === this.state) return
    this.state = s
    this.onState(s)
  }
}
