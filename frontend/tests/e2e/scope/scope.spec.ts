import { test, expect, type Page } from '@playwright/test'
import { API } from '../support/city'

// A live town whose environment has scope rules and an inventory source replaying a recorded response. The same checks run on two towns with the
// opposite conventions (scope-town-a: everything in the names; scope-town-b: tags, other resource types, derived telemetry names). The inspector says
// the same thing about both, which is the proof that the rules, not the program, know the conventions.

const B = process.env.E2E_SUITE === 'scopeb'
const town = B
  ? { subscription: 'Alpha Production', via: 'found by its tag', workspace: 'law-live-prod', apiRole: 'OrdersAPI', apiNote: 'derived from the environment template', apiResources: ['orders-api'], dbResources: 3 }
  : { subscription: 'acme-eu-prd-al', via: 'found by its name', workspace: 'ws-prd-main', apiRole: 'OrdersApi', apiNote: 'set on this system', apiResources: ['api-acme-al-ord-northeurope1x', 'plan-cf-acme-al-ord-northeurope1x', 'plan-cf-acme-al-ord-westeurope9z'], dbResources: 3 }

async function openConfig(page: Page, name: string): Promise<void> {
  await page.goto('/?test=1&quality=low')
  await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
  await page.locator('#search-input').fill(name)
  await page.locator('#search-results .hit').first().click()
  await page.locator('#inspector [data-tab="config"]').click()
}

test.describe(`a live town with scope rules (${B ? 'tags and derived names' : 'names'})`, () => {
  test('the server places an API: its subscription, workspace, telemetry role and resources', async ({ request }) => {
    // the inventory is read on the first poll, so give it a moment
    await expect.poll(async () => (await (await request.get(`${API}/api/systems/aa.orders-api`)).json()).scope?.inventoryState, { timeout: 15_000 }).toBe('read')
    const scope = (await (await request.get(`${API}/api/systems/aa.orders-api`)).json()).scope
    expect(scope.subscription).toBe(town.subscription)
    expect(scope.workspace).toBe(town.workspace)
    expect(scope.telemetryRole).toBe(town.apiRole)
    expect(scope.resources.map((r: any) => r.name)).toEqual(town.apiResources)
    expect(scope.problems).toEqual([])
  })

  test('the Config tab says where the system lives, and how each value was found', async ({ page }) => {
    await openConfig(page, 'Orders API')
    await expect(page.locator('#inspector .scope-title')).toHaveText('Where it lives')
    await expect(page.locator('#inspector .scope-status')).toHaveCount(0) // the inventory has been read
    const sub = page.locator('#inspector .cfg-row[data-key="subscription"]')
    await expect(sub).toContainText(town.subscription)
    await expect(sub.locator('.o')).toHaveText(town.via)
    await expect(page.locator('#inspector .cfg-row[data-key="workspace"]')).toContainText(town.workspace)
    const role = page.locator('#inspector .cfg-row[data-key="telemetry role"]')
    await expect(role).toContainText(town.apiRole)
    await expect(role.locator('.o')).toHaveText(town.apiNote)
    for (const name of town.apiResources) await expect(page.locator(`#inspector .cfg-row[data-resource="${name}"]`)).toBeVisible()
  })

  test('a tenant database lists its tenants by their friendly names', async ({ page }) => {
    await openConfig(page, 'Orders DB')
    const rows = page.locator('#inspector .cfg-row[data-resource]')
    await expect(rows).toHaveCount(town.dbResources)
    const text = (await rows.allTextContents()).join(' ')
    for (const customer of ['Acme Bank', 'Borealis Credit Union', 'Cygnus Finance']) expect(text).toContain(customer)
  })

  test('a system of the other pillar is placed in its own subscription', async ({ page }) => {
    await openConfig(page, 'Ledger API')
    await expect(page.locator('#inspector .cfg-row[data-key="subscription"]')).toContainText(B ? 'Beta Production' : 'acme-eu-prd-be')
  })
})
