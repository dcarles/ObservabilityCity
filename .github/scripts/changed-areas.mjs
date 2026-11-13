// Decides which CI jobs a change needs. CI passes the changed file paths (one per line) on stdin and reads the answer from stdout as
// "backend=true" style lines for $GITHUB_OUTPUT. A file this script does not recognise runs everything: skipping a test by mistake costs more than running one too many.
//
//   documents          nothing runs
//   documents that backend tests read (the handoff kit, config reference)   backend tests only
//   frontend/          frontend tests and build, and the browser tests (they start the real backend, which is itself unchanged)
//   files only some jobs read (see RULES below)   just those jobs
//   anything else      everything
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const JOBS = ['backend', 'frontend', 'ui', 'registries']

/** Documents the backend tests open (HandoffDocsTests, RegistryValidationTests): changing one can break them. */
const TESTED_DOCS = new Set(['AGENTS.md', '.github/copilot-instructions.md', 'docs/connect-your-company.md', 'extensions/README.md', 'docs/config-reference.md'])

const none = () => ({ backend: false, frontend: false, ui: false, registries: false })
const only = (...jobs) => ({ ...none(), ...Object.fromEntries(jobs.map((j) => [j, true])) })
const all = () => only(...JOBS)

/**
 * Files that only some jobs read, checked in order, first match wins (a path ending in / is a folder). Anything not listed here runs everything.
 *  - Housekeeping that no test or job opens, and slow.yml, which only runs on main and nightly: nothing runs.
 *  - The frontend unit tests are Vitest: the browser tests do not use them.
 *  - The backend tests, the adapter template (only the backend tests build it) and the settings-migration data: backend only.
 *  - The golden snapshots and the degraded-rule and layout data: read by the backend and frontend unit tests, never by the browser tests.
 *  - The validator and the one registry town that only backend tests load: the backend and the registry checks.
 * The theme contract and every registry town the browser tests load are deliberately not here: they run everything.
 */
const RULES = [
  [['.github/CODEOWNERS', '.github/dependabot.yml', '.github/workflows/slow.yml', '.gitignore', '.gitattributes', 'docs/screenshots/', 'scripts/trouble.'], []],
  [['frontend/tests/unit/'], ['frontend']],
  [['backend/tests/', 'templates/adapter/', 'shared-test-data/settings-migration/'], ['backend']],
  [['shared-test-data/snapshots/', 'shared-test-data/degraded-rules/', 'shared-test-data/layout/'], ['backend', 'frontend']],
  [['backend/tools/', 'shared-test-data/registries/neutral-scope-town/'], ['backend', 'registries']],
]

function jobsFor(file) {
  if (TESTED_DOCS.has(file)) return only('backend')
  if (/\.md$/i.test(file) || /^LICENSE/i.test(file)) return none()
  for (const [prefixes, jobs] of RULES) if (prefixes.some((p) => file.startsWith(p))) return only(...jobs)
  if (file.startsWith('frontend/')) return only('frontend', 'ui')
  return all()
}

/** @param {string[]} files changed paths, relative to the repo root */
export function areasFor(files) {
  const paths = files.map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean)
  if (paths.length === 0) return all()
  const result = none()
  for (const file of paths) for (const [job, needed] of Object.entries(jobsFor(file))) if (needed) result[job] = true
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Pushes to main and the nightly run always run everything: that is the safety net for what a pull request skipped.
  const everything = process.env.CI_RUN_ALL === 'true'
  const result = everything ? all() : areasFor(readFileSync(0, 'utf8').split('\n'))
  for (const [job, needed] of Object.entries(result)) console.log(`${job}=${needed}`)
}
