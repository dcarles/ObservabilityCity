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
  ) {}

  private query(): string {
    return this.env ? `?env=${encodeURIComponent(this.env)}` : ''
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
    hub.onreconnected(() => this.set('live'))
    hub.onclose(() => {
      this.set('offline')
      this.startPolling()
    })

    hub.start().catch(() => {
      this.set('offline')
      this.startPolling()
    })
  }

  private startPolling(): void {
    if (this.poll !== undefined) return
    const tick = async () => {
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
    void tick()
    this.poll = window.setInterval(tick, 2000)
  }

  private set(s: ConnectionState): void {
    if (s === this.state) return
    this.state = s
    this.onState(s)
  }
}
