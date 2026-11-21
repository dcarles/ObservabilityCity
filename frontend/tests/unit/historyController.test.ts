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
