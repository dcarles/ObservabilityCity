// Decides which CI jobs a change needs. CI passes the changed file paths (one per line) on stdin and reads the answer from stdout as
// "backend=true" style lines for $GITHUB_OUTPUT. A file this script does not recognise runs everything: skipping a test by mistake costs more than running one too many.
//
//   documents          nothing runs
//   documents that backend tests read (the handoff kit, config reference)   backend tests only
//   frontend/          frontend tests and build, and the browser tests (they start the real backend, which is itself unchanged)
//   anything else      everything
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const JOBS = ['backend', 'frontend', 'ui', 'registries']

/** Documents the backend tests open (HandoffDocsTests, RegistryValidationTests): changing one can break them. */
const TESTED_DOCS = new Set(['AGENTS.md', '.github/copilot-instructions.md', 'docs/connect-your-company.md', 'extensions/README.md', 'docs/config-reference.md'])

const none = () => ({ backend: false, frontend: false, ui: false, registries: false })
const only = (...jobs) => ({ ...none(), ...Object.fromEntries(jobs.map((j) => [j, true])) })
const all = () => only(...JOBS)

function jobsFor(file) {
  if (TESTED_DOCS.has(file)) return only('backend')
  if (/\.md$/i.test(file) || /^LICENSE/i.test(file)) return none()
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
