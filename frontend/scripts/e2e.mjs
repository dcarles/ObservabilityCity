// Runs the Playwright tests for one or more suites, one after the other (the suite name is read from E2E_SUITE by playwright.config.ts).
//   node scripts/e2e.mjs links                       one suite
//   node scripts/e2e.mjs scope scopeb                two suites in a row
//   node scripts/e2e.mjs towns E2E_ALL_THEMES=1 -- themes.spec.ts    NAME=value sets an environment variable; what follows -- goes to Playwright
// It sets the variables itself, so the same npm script works in Windows PowerShell and in Linux shells.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
const args = process.argv.slice(2)
const split = args.indexOf('--')
const own = split < 0 ? args : args.slice(0, split)
const passThrough = split < 0 ? [] : args.slice(split + 1)
const extraEnv = Object.fromEntries(own.filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]))
const suites = own.filter((a) => !a.includes('='))
if (suites.length === 0) {
  console.error('Usage: node scripts/e2e.mjs <suite> [<suite>...] [NAME=value...] [-- playwright arguments]')
  process.exit(2)
}

for (const suite of suites) {
  const result = spawnSync(process.execPath, [cli, 'test', ...passThrough], { stdio: 'inherit', env: { ...process.env, ...extraEnv, E2E_SUITE: suite } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
