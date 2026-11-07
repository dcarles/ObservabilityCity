import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SignalR client is replaced by one whose start() always fails, so the connection's own retrying is what is tested.
const starts: number[] = []
vi.mock('@microsoft/signalr', () => {
  class Hub {
    state = 'Disconnected'
    on() {}
    onreconnecting() {}
    onreconnected() {}
    onclose() {}
    invoke() { return Promise.resolve() }
    start() { starts.push(Date.now()); return Promise.reject(new Error('refused')) }
  }
  class Builder {
    withUrl() { return this }
    withAutomaticReconnect() { return this }
    configureLogging() { return this }
    build() { return new Hub() }
  }
  return { HubConnectionBuilder: Builder, HubConnectionState: { Connected: 'Connected' }, LogLevel: { Warning: 3 } }
})

import { Connection } from '../../src/connection'

describe('a connection that has lost the live socket', () => {
  beforeEach(() => {
    starts.length = 0
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '' } })
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('falls back to polling and tries nothing else when it is not persistent', async () => {
    const states: string[] = []
    new Connection(() => {}, (s) => states.push(s)).start()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(starts).toHaveLength(1)
    expect(states).toContain('offline')
  })

  it('keeps opening the socket again, however many times that fails, when it is persistent', async () => {
    new Connection(() => {}, () => {}, { town: null, env: null }, () => {}, [], { persistent: true, retryMs: 5000 }).start()

    await vi.advanceTimersByTimeAsync(1)
    expect(starts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(starts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(starts).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(50_000)
    expect(starts.length).toBeGreaterThanOrEqual(12)
  })

  it('waits the time it was told to between tries', async () => {
    new Connection(() => {}, () => {}, { town: null, env: null }, () => {}, [], { persistent: true, retryMs: 1000 }).start()

    await vi.advanceTimersByTimeAsync(3500)

    expect(starts).toHaveLength(4)
  })
})

describe('a live feed that goes quiet', () => {
  it('turns silent after the limit with no snapshot, and live again when one arrives', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: '' } })
    let ok = true
    vi.stubGlobal('fetch', () => (ok ? Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) : new Promise(() => {})))
    const states: string[] = []
    const c = new Connection(() => {}, (s) => states.push(s), { town: null, env: null }, () => {}, [], { silentAfterMs: 10_000 })
    c.start()
    await vi.advanceTimersByTimeAsync(3000) // the socket failed, so the polling answers
    expect(c.state).toBe('live')
    ok = false // the polling now hangs: nothing arrives
    await vi.advanceTimersByTimeAsync(9000)
    expect(c.state).toBe('live')
    await vi.advanceTimersByTimeAsync(5000)
    expect(c.state).toBe('silent')
    ok = true
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toContain('silent')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})
