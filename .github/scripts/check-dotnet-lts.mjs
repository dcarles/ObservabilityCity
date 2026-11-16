// Keeps the repo on .NET 10 (LTS). Fails when a Microsoft .NET package, a Microsoft npm package or the target framework is on major version 11 or higher.
// Dependabot is told not to propose such bumps (.github/dependabot.yml); this catches one made by hand or by a tool that ignores that file.
// Run from the repo root: node .github/scripts/check-dotnet-lts.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_MAJOR = 10
const problems = []

const major = (version) => Number.parseInt(String(version).replace(/^[^\d]*/, ''), 10)

// NuGet: central package versions. Microsoft.* and System.* follow the .NET release; Aspire.* has its own numbering and is not checked.
const props = readFileSync('backend/Directory.Packages.props', 'utf8')
for (const [, name, version] of props.matchAll(/<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"/g)) {
  if (/^(Microsoft|System)\./.test(name) && major(version) > MAX_MAJOR) problems.push(`${name} ${version} in backend/Directory.Packages.props`)
}

// Target framework of every project and the shared props files.
function* files(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'bin' || entry === 'obj' || entry === '.git') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (/\.(csproj|props|targets)$/.test(entry)) yield path
  }
}
for (const dir of ['backend', 'templates', 'extensions']) {
  try {
    for (const file of files(dir)) {
      for (const [, tfm] of readFileSync(file, 'utf8').matchAll(/<TargetFrameworks?>([^<]+)</g)) {
        for (const one of tfm.split(';')) if (/^net(\d+)\./.test(one) && Number.parseInt(one.slice(3), 10) > MAX_MAJOR) problems.push(`${one} in ${file}`)
      }
    }
  } catch { /* a folder this checkout does not have */ }
}

// npm: the @microsoft/* packages (the SignalR client) follow the .NET release too.
const pkg = JSON.parse(readFileSync('frontend/package.json', 'utf8'))
for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(pkg[section] ?? {})) {
    if (name.startsWith('@microsoft/') && major(range) > MAX_MAJOR) problems.push(`${name} ${range} in frontend/package.json`)
  }
}

if (problems.length > 0) {
  console.error(`The repo stays on .NET ${MAX_MAJOR} (LTS). These are newer:\n  ${problems.join('\n  ')}\nMove to a newer .NET on purpose, in its own pull request, and raise MAX_MAJOR here and the ignore rules in .github/dependabot.yml together.`)
  process.exit(1)
}
console.log(`Microsoft .NET packages and the target framework are on .NET ${MAX_MAJOR} or lower.`)
