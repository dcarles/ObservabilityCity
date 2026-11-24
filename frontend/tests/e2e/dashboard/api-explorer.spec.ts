import { test, expect } from '../support/test'
import type { Page } from '@playwright/test'

// The API explorer in a demo town: the drawer of a service with an API opens the big window with that API chosen, and the window lists operations and policies.

async function openDrawer(town: { reset(): Promise<void> }, page: Page): Promise<void> {
  await town.reset()
  await page.goto('/?view=dashboard')
  await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
  const card = page.locator('[data-pillar="aa"]')
  await card.locator('[data-toggle]').click()
  const group = card.locator('tr.g', { hasText: 'orders' })
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click()
  await card.locator('tr.row[data-system="aa.orders-api"]').locator('td').first().click()
  await expect(page.locator('#inspector')).toBeVisible()
}

test.describe('the API explorer', () => {
  test('opens from the drawer with the service\'s API chosen, shows its operations and policy, and closes with Esc', async ({ town, page }) => {
    await openDrawer(town, page)
    const button = page.locator('#inspector [data-api-explorer]')
    await expect(button).toBeVisible()
    await button.click()
    const win = page.locator('#api-explorer')
    await expect(win).toBeVisible()
    await expect(win.locator('.ae-api.sel')).toHaveCount(1)
    // opened from a service: only its own APIs are listed, and the chip brings the rest back
    const own = await win.locator('.ae-api').count()
    await expect(win.locator('[data-ae-chip="system"]')).toBeVisible()
    await win.locator('[data-ae-chip="system"]').click()
    expect(await win.locator('.ae-api').count()).toBeGreaterThan(own)
    await win.locator('[data-ae-foldall="close"]').click()
    await expect(win.locator('.ae-api')).toHaveCount(0)
    await expect(win.locator('.ae-group-head')).not.toHaveCount(0)
    await win.locator('[data-ae-foldall="open"]').click()
    expect(await win.locator('.ae-api').count()).toBeGreaterThan(own)
    await expect(win.locator('.ae-op').first()).toBeVisible()
    await win.locator('.ae-op').first().click()
    await expect(win.locator('#ae-detail')).toContainText('Responses')
    await expect(win.locator('#ae-detail')).toContainText('Policy on the API')
    // the request body (a create call has one) with its fields, a fold that opens, and a response chosen by its code
    await win.locator('.ae-op', { hasText: 'Create' }).click()
    await expect(win.locator('#ae-detail')).toContainText('Request body')
    await expect(win.locator('#ae-detail .ae-fields').first()).toContainText('name')
    await win.locator('#ae-detail [data-ae-fold]').first().click()
    await expect(win.locator('#ae-detail .ae-ind').first()).toContainText('line1')
    await win.locator('#ae-detail [data-ae-code="409"]').click()
    await expect(win.locator('#ae-detail .ae-resp')).toContainText('It exists already')
    await win.locator('#ae-search').fill('zzzz-no-such-api')
    await expect(win.locator('.ae-api')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(win).toBeHidden()
  })
})
