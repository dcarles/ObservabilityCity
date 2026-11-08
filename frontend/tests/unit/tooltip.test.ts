import { afterEach, describe, expect, it, vi } from 'vitest'
import { showTooltip } from '../../src/ui'
import type { NodeSnapshot } from '../../src/types'

// A system's name and id come from a pillar file that any team may edit, so the tooltip must show them as text and never as markup.
describe('the building tooltip', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows a name and id with tags in them as text', () => {
    const el = { hidden: true, innerHTML: '', offsetWidth: 100, offsetHeight: 50, style: {} as Record<string, string> }
    vi.stubGlobal('document', { getElementById: () => el })
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
    const node = { id: 'aa.<i>x</i>', name: '<b>x</b><img src=x onerror=alert(1)>', state: 'Healthy', absent: [], quiet: false, engine: null, tenants: null, instancesHealthy: 1, instancesTotal: 1, requestsPerSecond: 1, errorRate: 0, errorAmber: 0.01, errorRed: 0.05, p99Ms: 10, slaP99Ms: 100, load: 0.1 } as unknown as NodeSnapshot

    showTooltip(node, 10, 10)

    expect(el.innerHTML).toContain('&lt;b&gt;x&lt;/b&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(el.innerHTML).toContain('aa.&lt;i&gt;x&lt;/i&gt;')
    expect(el.innerHTML).not.toContain('<img')
    expect(el.innerHTML).not.toContain('<i>')
  })
})
