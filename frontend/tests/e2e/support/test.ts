import { test as base, expect } from '@playwright/test'
import { Town } from './city'

/** A test that fails if the page logs an error or throws, whatever else it checks. */
export const test = base.extend<{ town: Town; errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      // the browser reports a failed websocket handshake and similar network noise as errors; the page falls back to polling
      if (m.type() === 'error' && !/WebSocket|Failed to load resource|net::ERR|GPU stall|WebGL/i.test(m.text())) errors.push(`console: ${m.text()}`)
    })
    await use(errors)
  },
  town: async ({ page, request, errors }, use) => {
    const town = new Town(page, request)
    await use(town)
    await town.reset().catch(() => {})
    expect(errors, 'the page logged errors').toEqual([])
  },
})

export { expect }
