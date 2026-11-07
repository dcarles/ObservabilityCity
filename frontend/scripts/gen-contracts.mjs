// Regenerates contracts/openapi.json (from the C# records, by the built-in ASP.NET Core OpenAPI generator) and src/contracts.ts (from the OpenAPI file, by scripts/openapi-to-ts.mjs).
// With --check it regenerates into a temp folder and fails if the committed files differ, so contract drift is a build error.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './openapi-to-ts.mjs'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(webDir, '..')
const check = process.argv.includes('--check')
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

const hostProject = join(repoRoot, 'backend', 'src', 'ObservabilityCity.Host')

const out = check ? mkdtempSync(join(tmpdir(), 'oc-contracts-')) : null
const openapi = check ? join(out, 'openapi.json') : join(repoRoot, 'contracts', 'openapi.json')
const contracts = check ? join(out, 'contracts.ts') : join(webDir, 'src', 'contracts.ts')

// The generator skips itself when the build is up to date, and remembers the folder it wrote to, so its marker is cleared first.
rmSync(join(hostProject, 'obj', 'ObservabilityCity.Host.OpenApiFiles.cache'), { force: true })
// The built-in OpenAPI generator writes the document while the Host builds (it starts the app once to read its endpoints).
run('dotnet', ['build', hostProject, '-c', 'Debug', '--nologo', '-v', 'q', '-p:OpenApiGenerateDocumentsOnBuild=true', `-p:OpenApiDocumentsDirectory=${dirname(openapi)}`], repoRoot)
// Fixed order and layout, so the file is the same on every run and every machine.
const doc = JSON.parse(readFileSync(openapi, 'utf8'))
const schemas = doc.components?.schemas ?? {}
doc.components.schemas = Object.fromEntries(Object.keys(schemas).sort().map((k) => [k, schemas[k]]))
writeFileSync(openapi, JSON.stringify(doc, null, 2) + '\n')
writeFileSync(contracts, generate(doc))

if (check) {
  const same = (a, b) => readFileSync(a, 'utf8').replace(/\r\n/g, '\n') === readFileSync(b, 'utf8').replace(/\r\n/g, '\n')
  const stale = []
  if (!existsSync(join(repoRoot, 'contracts', 'openapi.json')) || !same(openapi, join(repoRoot, 'contracts', 'openapi.json'))) stale.push('contracts/openapi.json')
  if (!existsSync(join(webDir, 'src', 'contracts.ts')) || !same(contracts, join(webDir, 'src', 'contracts.ts'))) stale.push('frontend/src/contracts.ts')
  if (stale.length) {
    console.error(`Contract drift: ${stale.join(', ')} no longer match the C# records. Run "npm run gen:contracts" in frontend/ and commit.`)
    process.exit(1)
  }
  console.log('Contracts are up to date.')
}
