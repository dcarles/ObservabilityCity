import { test, expect } from '../support/test'

// A feed that says nothing for too long: the page must not go on looking live. The page is told to throw the snapshots away and to give up after 2 s instead of 45,
// which is what a socket that stays open but carries nothing looks like to it.
test('a town that hears nothing for too long greys and says so, and recovers when snapshots come again', async ({ town, page }) => {
  await town.open()
  await expect(page.locator('#topbar .status .label')).toHaveText(/^Live/)

  await page.evaluate(() => (window as any).city.muteFeed(true, 2000))
  await expect(page.locator('#topbar .status .label')).toHaveText(/^No update for over 45 s$/)
  await expect(page.locator('body')).toHaveClass(/feed-silent/)

  await page.evaluate(() => (window as any).city.muteFeed(false))
  await expect(page.locator('#topbar .status .label')).toHaveText(/^Live/, { timeout: 15_000 })
  await expect(page.locator('body')).not.toHaveClass(/feed-silent/)
})

test('the dashboard greys and says so when the feed goes quiet, and recovers', async ({ town, page }) => {
  await town.reset()
  await page.goto('/?view=dashboard')
  await page.waitForFunction(() => (window as any).dash?.seen.snapshots > 0)
  await expect(page.locator('#dash-status')).toContainText('Live')

  await page.evaluate(() => (window as any).dash.muteFeed(true, 2000))
  await expect(page.locator('#dash-status')).toContainText('No update for over 45 s')
  await expect(page.locator('body')).toHaveClass(/feed-silent/)

  await page.evaluate(() => (window as any).dash.muteFeed(false))
  await expect(page.locator('#dash-status')).toContainText('Live', { timeout: 15_000 })
  await expect(page.locator('body')).not.toHaveClass(/feed-silent/)
})
