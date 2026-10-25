// Regenerates contracts/openapi.json (from the C# records) and src/contracts.ts (from the OpenAPI file).
// With --check it regenerates into a temp folder and fails if the committed files differ, so contract drift is a build error.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(webDir, '..')
const check = process.argv.includes('--check')
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

const hostProject = join(repoRoot, 'src', 'ObservabilityCity.Host')
run('dotnet', ['build', hostProject, '-c', 'Debug', '--nologo', '-v', 'q'], repoRoot)
run('dotnet', ['tool', 'restore'], repoRoot)

const out = check ? mkdtempSync(join(tmpdir(), 'oc-contracts-')) : null
const openapi = check ? join(out, 'openapi.json') : join(repoRoot, 'contracts', 'openapi.json')
const contracts = check ? join(out, 'contracts.ts') : join(webDir, 'src', 'contracts.ts')

const dll = join(hostProject, 'bin', 'Debug', 'net10.0', 'ObservabilityCity.Host.dll')
run('dotnet', ['swagger', 'tofile', '--output', openapi, dll, 'v1'], repoRoot)
run('npx', ['openapi-typescript', openapi, '-o', contracts], webDir)

if (check) {
  const same = (a, b) => readFileSync(a, 'utf8').replace(/\r\n/g, '\n') === readFileSync(b, 'utf8').replace(/\r\n/g, '\n')
  const stale = []
  if (!existsSync(join(repoRoot, 'contracts', 'openapi.json')) || !same(openapi, join(repoRoot, 'contracts', 'openapi.json'))) stale.push('contracts/openapi.json')
  if (!existsSync(join(webDir, 'src', 'contracts.ts')) || !same(contracts, join(webDir, 'src', 'contracts.ts'))) stale.push('web/src/contracts.ts')
  if (stale.length) {
    console.error(`Contract drift: ${stale.join(', ')} no longer match the C# records. Run "npm run gen:contracts" in web/ and commit.`)
    process.exit(1)
  }
  console.log('Contracts are up to date.')
}
