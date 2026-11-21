import { test, expect } from '@playwright/test'
import { API } from '../support/city'

// A demo town has no past worth keeping: no History button, and the server says history is not kept.

test('a demo town has no History button and its server keeps no history', async ({ page, request }) => {
  const range = await (await request.get(`${API}/api/history/range`)).json()
  expect(range.enabled).toBe(false)
  expect(range.points).toEqual([])
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  await expect(page.locator('#history-button')).toBeHidden()
})
