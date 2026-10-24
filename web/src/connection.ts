import * as signalR from '@microsoft/signalr'
import type { Snapshot } from './types'

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline'

/**
 * Receives snapshots from the backend over SignalR. If the socket cannot be opened (a proxy in the way,
 * say) it falls back to polling the same snapshot over plain HTTP, so the town still moves.
 */
export class Connection {
  state: ConnectionState = 'connecting'
  private poll: number | undefined

  constructor(
    private readonly onSnapshot: (s: Snapshot) => void,
    private readonly onState: (s: ConnectionState) => void,
  ) {}

  start(): void {
    const hub = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/town')
      .withAutomaticReconnect([0, 1000, 3000, 5000, 10000])
      .configureLogging(signalR.LogLevel.Warning)
      .build()

    hub.on('snapshot', (s: Snapshot) => {
      this.set('live')
      this.onSnapshot(s)
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
        const r = await fetch('/api/snapshot/latest')
        if (r.ok) {
          this.set('live')
          this.onSnapshot((await r.json()) as Snapshot)
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
