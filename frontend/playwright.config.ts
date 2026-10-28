import { defineConfig } from '@playwright/test'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Browser tests against the real backend (fake source) and the real page.
//   npm run e2e          the fast set: UI scenarios on a small town, then the link rules on a town with one island for each case. Runs on every pull request.
//   npm run e2e:links    the link rules alone (pier, bridge and buildings follow real links)
//   npm run e2e:ui       the top bar, island filter, layers, inspector drawer, legend and Day/Dusk, on the small town
//   npm run e2e:direct   how a filtered island's traffic is shown in a town without a hub (signposts), on a small town with direct topology
//   npm run e2e:live     a live town (no mode in town.yaml): no Break things panel, no story bar, no /api/fake, "Live" in the top bar
//   npm run e2e:sources  a live town whose environment configures some signals and not others: absent signals are not shown, silent ones are grey
//   npm run e2e:scope    two live towns with opposite scope conventions (names; tags): the inspector says where each system lives, from a recorded inventory
//   npm run e2e:tenants  environments, tenant yards, tenant traffic and service groups, on a town with two pillars and three environments
//   npm run e2e:towns    the town switcher and the second sample town (Droid Shop, on Kafka), on the server's own config folder with both sample towns
//   npm run e2e:wide     islands of 2, 10, 15 and 27 services: how many pads a row, every building on land, nothing overlapping, on a town of four islands
//   npm run e2e:slow     the slow set: the 23-island and 35-island stress towns and the full sample town, with screenshots. Runs on merge to main and nightly.
// Set E2E_NO_BUILD=1 when the backend is already built in Release (CI does this).

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const suite = process.env.E2E_SUITE ?? 'scenarios'
const registries: Record<string, string> = {
  scenarios: 'shared-test-data/registries/mini-town',
  links: 'shared-test-data/registries/links-town',
  ui: 'shared-test-data/registries/mini-town',
  direct: 'shared-test-data/registries/direct-town',
  live: 'shared-test-data/registries/live-town',
  sources: 'shared-test-data/registries/live-sources-town',
  tenants: 'shared-test-data/registries/tenants-town',
  scope: 'shared-test-data/registries/scope-town-a',
  scopeb: 'shared-test-data/registries/scope-town-b',
  // no single folder: the server finds the towns in config/ itself
  towns: '',
  wide: 'shared-test-data/registries/wide-town',
  stress: 'shared-test-data/registries/stress-23',
  stress35: 'shared-test-data/registries/stress-35',
  town: 'config/galactic-credit',
}
const fixture = registries[suite] ? resolve(repo, registries[suite]) : ''

// The scenario tests edit registry files to check reloading, so they run against a copy. The main process makes the copy and
// passes its path down in the environment, which the workers inherit, so there is only ever one.
if (['scenarios', 'links', 'tenants', 'ui', 'direct', 'live', 'sources', 'scope', 'scopeb'].includes(suite) && !process.env.E2E_REGISTRY_COPY) {
  const copy = mkdtempSync(join(tmpdir(), 'oc-e2e-registry-'))
  cpSync(fixture, copy, { recursive: true })
  process.env.E2E_REGISTRY_COPY = copy
}
// the towns suite reads the sample towns in place; it changes no registry file
const registry = process.env.E2E_REGISTRY_COPY ?? fixture

const API_PORT = Number(process.env.E2E_API_PORT ?? 5290)
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5291)
const api = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: suite === 'scenarios' ? 'scenarios/**/*.spec.ts' : `${suite.replace('stress35', 'stress').replace('scopeb', 'scope')}/**/*.spec.ts`,
  // one backend, one fake source: tests steer shared state, so they take turns
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: ['scenarios', 'links', 'tenants', 'ui', 'direct', 'live', 'sources', 'scope', 'scopeb', 'towns', 'wide'].includes(suite) ? 60_000 : 240_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 960, height: 600 },
    trace: 'retain-on-failure',
    launchOptions: {
      // a machine whose browser is somewhere else (not the one Playwright downloaded) names it here
      executablePath: process.env.E2E_CHROMIUM || undefined,
      // no GPU in CI: draw with SwiftShader
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: `dotnet run --project ../backend/src/ObservabilityCity.Host -c Release --no-launch-profile ${process.env.E2E_NO_BUILD ? '--no-build' : ''}`,
      url: `${api}/api/health`,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI && !!process.env.E2E_REUSE,
      env: {
        ASPNETCORE_URLS: api,
        Registry__Path: registry,
        // fast, steady numbers: a snapshot every half second, and a quiet source turns stale in 3 seconds
        Snapshot__IntervalSeconds: '0.5',
        Snapshot__StaleAfterSeconds: '3',
        Fake__PollInterval: process.env.E2E_FAKE_POLL ?? '00:00:00.5',
        Registry__WatchSeconds: '1',
      },
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI && !!process.env.E2E_REUSE,
      env: { services__host__http__0: api },
    },
  ],
})
