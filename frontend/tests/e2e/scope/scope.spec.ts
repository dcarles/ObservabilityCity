import { test, expect, type Page } from '@playwright/test'
import { API } from '../support/city'

// A live town whose environment has scope rules and an inventory source replaying a recorded response. The same checks run on two towns with the
// opposite conventions (scope-town-a: everything in the names; scope-town-b: tags, other resource types, derived telemetry names). The inspector says
// the same thing about both, which is the proof that the rules, not the program, know the conventions.

const B = process.env.E2E_SUITE === 'scopeb'
const town = B
  ? { subscription: 'Alpha Production', via: 'found by its tag', workspace: 'law-live-prod', apiRole: 'OrdersAPI', apiNote: 'derived from the environment template', apiResources: ['orders-api'], dbResources: 3, countedText: /3 instances/ }
  : { subscription: 'acme-eu-prd-al', via: 'found by its name', workspace: 'ws-prd-main', apiRole: 'OrdersApi', apiNote: 'set on this system', apiResources: ['api-acme-al-ord-northeurope1x', 'plan-cf-acme-al-ord-northeurope1x', 'plan-cf-acme-al-ord-westeurope9z'], dbResources: 3, countedText: /1 instance.*2 instances|2 instances.*1 instance/ }

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

  // Phase 2, slice 3: the floors come from the counted instances, and the two conventions count the same town (plan workers; container replicas).
  test('the server reports the counted instances of each system, and none for what has no count', async ({ request }) => {
    await expect.poll(async () => (await (await request.get(`${API}/api/systems/aa.orders-api`)).json()).scope?.inventoryState, { timeout: 15_000 }).toBe('read')
    await expect.poll(async () => {
      const snap = await (await request.get(`${API}/api/snapshot/latest`)).json()
      return Object.fromEntries(snap.groups.flatMap((g: any) => g.nodes).map((n: any) => [n.id, `${n.state}:${n.instancesHealthy}/${n.instancesTotal}`]))
    }, { timeout: 15_000 }).toMatchObject({
      'aa.orders-api': 'Healthy:3/3', 'aa.orders-worker': 'Healthy:3/3', 'bb.ledger-api': 'Healthy:5/5', 'bb.ledger-worker': 'Healthy:5/5',
      'aa.orders-db': 'Stale:0/0', // an account has no instances to count: grey, never healthy
    })
  })

  test('a building has as many floors as its counted instances ask for, and the plaque says so', async ({ page }) => {
    await page.goto('/?test=1&quality=low')
    await page.waitForFunction(() => (window as any).city?.seen.snapshots > 0)
    await page.waitForFunction(() => (window as any).city.inspect('aa.orders-api')?.state === 'Healthy')
    await page.evaluate(() => (window as any).city.step(2))
    const orders = await page.evaluate(() => (window as any).city.inspect('aa.orders-api'))
    const ledger = await page.evaluate(() => (window as any).city.inspect('bb.ledger-api'))
    expect(orders.floors).toBe(3)
    expect(orders.plaque).toBe('3/3 healthy')
    expect(ledger.floors).toBe(4)
    expect(ledger.plaque).toBe('5/5 healthy')
  })

  test('the Config tab adds the instances up and shows what each resource counts', async ({ page }) => {
    await openConfig(page, 'Orders API')
    await expect(page.locator('#inspector .cfg-row[data-key="instances"] .v')).toHaveText('3')
    const counted = page.locator('#inspector .cfg-row[data-resource]', { hasText: /\d+ instances?/ })
    expect((await counted.allTextContents()).join(' ')).toMatch(town.countedText)
  })
})
