import { describe, expect, it } from 'vitest'
import { callLines, groupCallWords, methodLines, SIGN_CALLS } from '../../src/routesModel'
import type { NodeSnapshot } from '../../src/types'

function api(id: string, routes: [string, string, number, number][], methods: [string, number, number][] = [], serviceCode: string | null = null): NodeSnapshot {
  return {
    id, name: id, service: 'svc', serviceCode, errorAmber: 0.01, errorRed: 0.05,
    routes: routes.map(([method, route, perSecond, errorRate]) => ({ method, route, perSecond, errorRate })),
    methods: methods.map(([method, perSecond, share]) => ({ method, perSecond, share })),
  } as unknown as NodeSnapshot
}

describe('the calls an API serves, in words', () => {
  it('lists each call with its rate and the share that failed, coloured against the system\'s own error lines', () => {
    const lines = callLines(api('cl.mgs-api', [['GET', 'customers/{id}', 46.2, 0], ['POST', 'customers', 3.04, 0.02], ['PUT', 'customers/{id}', 1, 0.2], ['GET', 'x', 0.5, 0.0004]]))

    expect(lines.map((l) => [l.method, l.route, l.rate, l.errors, l.tone])).toEqual([
      ['GET', 'customers/{id}', '46 rps', '', ''],
      ['POST', 'customers', '3.0 rps', '2.0% errors', 'warn'],
      ['PUT', 'customers/{id}', '1.0 rps', '20.0% errors', 'bad'],
      ['GET', 'x', '0.5 rps', '<0.1% errors', ''],
    ])
  })

  it('says nothing when the environment measures no calls', () => {
    expect(callLines({ ...api('a.b-api', []), routes: null } as unknown as NodeSnapshot)).toEqual([])
    expect(methodLines({ methods: null })).toEqual([])
  })

  it('divides the requests by method with a share, a rate and a bar width', () => {
    expect(methodLines(api('a.b-api', [], [['GET', 46, 0.78], ['POST', 11, 0.18], ['PUT', 0.4, 0.004]]))).toEqual([
      { method: 'GET', share: '78%', rate: '46 rps', percent: 78 },
      { method: 'POST', share: '18%', rate: '11 rps', percent: 18 },
      { method: 'PUT', share: '<1%', rate: '0.4 rps', percent: 0 },
    ])
  })
})

describe('what an island\'s sign says when hovered', () => {
  const nodes = [
    api('cl.mgs-api', [['GET', 'a/{id}', 40, 0], ['POST', 'a', 5, 0]], [['GET', 40, 0.89], ['POST', 5, 0.11]], 'mgs'),
    api('cl.stm-api', [['GET', 'b', 30, 0], ['GET', 'c', 20, 0], ['PUT', 'd', 1, 0]], [['GET', 50, 0.98], ['PUT', 1, 0.02]]),
    { ...api('cl.db', []), routes: null, methods: null } as unknown as NodeSnapshot,
  ]

  it('lists the busiest calls of all its systems with the system that serves each, and the method split of all together', () => {
    const words = groupCallWords(nodes)

    expect(words[0]).toBe('Top calls')
    expect(words.slice(1, 1 + SIGN_CALLS)).toEqual(['GET a/{id} · cl.mgs · 40 rps', 'GET b · cl.svc · 30 rps', 'GET c · cl.svc · 20 rps'])
    expect(words[1 + SIGN_CALLS]).toBe('Methods GET 94% · POST 5% · PUT 1%')
  })

  it('is empty when no system of the island measures its calls', () => {
    expect(groupCallWords([{ ...nodes[2] }])).toEqual([])
    expect(groupCallWords([])).toEqual([])
  })
})
