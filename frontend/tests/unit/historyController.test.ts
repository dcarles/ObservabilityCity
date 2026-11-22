import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryController } from '../../src/history/controller'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 21, 14, 30)

/** A server that has no frame for the hour asked about until it has been asked to fill it, and then has a rebuilt one. */
function server(): { calls: string[]; fetch: typeof fetch; ready: () => void } {
  const calls: string[] = []
  let filled = false
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  return {
    calls,
    ready: () => { filled = true },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith('/api/history/range')) return json({ enabled: true, days: 7, intervalSeconds: 300, oldest: null, newest: null, frames: 0, bytes: 0, points: [] })
      if (url.startsWith('/api/history/fill/priority')) { filled = true; return new Response(null, { status: 202 }) }
      if (url.startsWith('/api/history/fill')) return json({ available: true, running: !filled, done: 0, total: 3, hour: null, problem: null })
      if (url.startsWith('/api/history/frame?') || url.startsWith('/api/history/frame')) {
        if (!url.includes('/frames') && filled) return json({ at: new Date(NOW - 3 * 3_600_000 - 5 * MIN).toISOString(), rebuilt: true, snapshot: { totals: {} } })
        return json({ error: 'no' }, 404)
      }
      if (url.startsWith('/api/history/frames')) return json({ frames: [] })
      return json({}, 404)
    }) as typeof fetch,
  }
}

describe('going to a time nothing was recorded at', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setInterval, clearInterval })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('asks the server to rebuild it, shows the loading card meanwhile, and shows the rebuilt frame when it is there', async () => {
    const s = server()
    vi.stubGlobal('fetch', s.fetch)
    const fed: unknown[] = []
    const c = new HistoryController({ scope: { town: null, env: null } as never, islands: () => [], feed: (raw) => fed.push(raw) }, () => NOW)
    await c.loadRange()

    const going = c.goTo(NOW - 3 * 3_600_000 - MIN)
    await vi.advanceTimersByTimeAsync(10)
    expect(c.state.filling).toBe(true)
    expect(c.state.noData).toBe(true)
    expect(s.calls.some((x) => x.startsWith('POST /api/history/fill/priority'))).toBe(true)

    await vi.advanceTimersByTimeAsync(3_100)
    await going
    expect(c.state.filling).toBe(false)
    expect(c.state.noData).toBe(false)
    expect(c.state.rebuilt).toBe(true)
    expect(fed).toHaveLength(1)
    c.dispose()
  })

  it('does not run the clock while the hour is being rebuilt, and runs it again when the town is there', async () => {
    const s = server()
    vi.stubGlobal('fetch', s.fetch)
    const c = new HistoryController({ scope: { town: null, env: null } as never, islands: () => [], feed: () => undefined }, () => NOW)
    await c.loadRange()

    const going = c.goTo(NOW - 3 * 3_600_000 - MIN)
    await vi.advanceTimersByTimeAsync(10)
    const waitingAt = c.state.viewed
    expect(c.state.filling).toBe(true)
    c.tick(60_000)
    c.tick(60_000)
    expect(c.state.viewed).toBe(waitingAt) // the clock waits; showing the past at a moving time while the picture is not that time would be a lie

    await vi.advanceTimersByTimeAsync(3_100)
    await going
    c.tick(60_000)
    expect(c.state.viewed).toBeGreaterThan(waitingAt)
    c.dispose()
  })

  it('keeps what the server says about the hours ahead for the loading card', async () => {
    const s = server()
    const ahead: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/history/fill?') && url.includes('at=')) return new Response(JSON.stringify({ available: true, running: true, done: 1, total: 9, hour: null, problem: null, ahead: 2, building: false, secondsPerHour: 110 }), { status: 200 })
      if (url.startsWith('/api/history/fill/priority')) return new Response(null, { status: 202 })
      if (url.startsWith('/api/history/frame')) return new Response('{}', { status: 404 })
      return s.fetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', ahead)
    const c = new HistoryController({ scope: { town: null, env: null } as never, islands: () => [], feed: () => undefined }, () => NOW)
    await c.loadRange()

    void c.goTo(NOW - 3 * 3_600_000 - MIN)
    await vi.advanceTimersByTimeAsync(10)

    expect(c.state.filling).toBe(true)
    expect(c.state.waiting).toEqual({ ahead: 2, building: false, secondsPerHour: 110 })
    c.dispose()
  })

  it('takes the ask back when the person goes live, and before asking for another hour', async () => {
    const s = server()
    const calls = s.calls
    const stuck: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/history/fill/priority')) return new Response(null, { status: init?.method === 'DELETE' ? 204 : 202 })
      if (url.startsWith('/api/history/frame')) return new Response('{}', { status: 404 }) // never ready
      return s.fetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).startsWith('/api/history/fill/priority')) calls.push(`${init?.method ?? 'GET'} ${String(input)}`); return stuck(input, init) })
    const c = new HistoryController({ scope: { town: null, env: null } as never, islands: () => [], feed: () => undefined }, () => NOW)
    await c.loadRange()

    void c.goTo(NOW - 3 * 3_600_000 - MIN)
    await vi.advanceTimersByTimeAsync(10)
    void c.goTo(NOW - 5 * 3_600_000 - MIN)
    await vi.advanceTimersByTimeAsync(10)
    const priority = calls.filter((x) => x.includes('/api/history/fill/priority')).map((x) => x.split(' ')[0])
    expect(priority.slice(0, 3)).toEqual(['POST', 'DELETE', 'POST']) // the first ask is taken back before the second is made

    await c.goLive()
    await vi.advanceTimersByTimeAsync(10)
    expect(calls.filter((x) => x.startsWith('DELETE')).length).toBe(2) // and going live takes the second back
    c.dispose()
  })

  it('gives up with the plain note when the filling has stopped and the time is not in it', async () => {
    const s = server()
    const fetchOnly: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/history/fill/priority')) return new Response(null, { status: 202 })
      if (url.startsWith('/api/history/fill')) return new Response(JSON.stringify({ available: true, running: false, done: 0, total: 0, hour: null, problem: 'login expired' }), { status: 200 })
      return s.fetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', fetchOnly)
    const c = new HistoryController({ scope: { town: null, env: null } as never, islands: () => [], feed: () => undefined }, () => NOW)
    await c.loadRange()

    const going = c.goTo(NOW - 3 * 3_600_000 - MIN)
    await vi.advanceTimersByTimeAsync(10_000)
    await going

    expect(c.state.filling).toBe(false)
    expect(c.state.noData).toBe(true)
    expect(c.state.rebuilt).toBe(false)
    c.dispose()
  })
})
