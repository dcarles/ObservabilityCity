import { describe, expect, it } from 'vitest'
import { areasFor } from '../../../.github/scripts/changed-areas.mjs'

// Which CI jobs a pull request needs, from the files it changes. When unsure the answer is "everything".

const nothing = { backend: false, frontend: false, ui: false, registries: false }
const everything = { backend: true, frontend: true, ui: true, registries: true }

describe('changed-areas', () => {
  it('runs no tests for documents', () => {
    expect(areasFor(['README.md', 'docs/easter-eggs.md', 'docs/frontend-stack.md', 'frontend/public/events/CREDITS.md', 'templates/adapter/README.md'])).toEqual(nothing)
  })

  it('runs only the backend tests for a document the backend tests read', () => {
    for (const doc of ['AGENTS.md', '.github/copilot-instructions.md', 'docs/connect-your-company.md', 'extensions/README.md', 'docs/config-reference.md'])
      expect(areasFor([doc])).toEqual({ ...nothing, backend: true })
  })

  it('runs the frontend and browser tests, and not the backend tests, for a frontend change', () => {
    expect(areasFor(['frontend/src/scene/island.ts', 'frontend/tests/unit/x.test.ts', 'README.md'])).toEqual({ ...nothing, frontend: true, ui: true })
  })

  it('runs everything for backend code, data the browser tests read, config, contracts, workflows and anything unknown', () => {
    for (const file of ['backend/src/ObservabilityCity.Core/X.cs', 'shared-test-data/registries/mini-town/town.yaml', 'shared-test-data/themes/theme-contract.json', 'config/galactic-credit/town.yaml',
      'contracts/openapi.json', '.github/workflows/ci.yml', '.github/scripts/changed-areas.mjs', 'global.json', 'frontend/scripts/e2e.mjs', 'something/new.bin'])
      expect(areasFor([file])).toEqual(file.startsWith('frontend/') ? { ...nothing, frontend: true, ui: true } : everything)
  })

  it('runs no tests for housekeeping files and for slow.yml, which only runs on main and nightly', () => {
    expect(areasFor(['.github/CODEOWNERS', '.github/dependabot.yml', '.github/workflows/slow.yml', '.gitignore', '.gitattributes', 'docs/screenshots/dashboard.png', 'scripts/trouble.ps1', 'scripts/trouble.http'])).toEqual(nothing)
  })

  it('runs only the frontend tests for a frontend unit test', () => {
    expect(areasFor(['frontend/tests/unit/x.test.ts'])).toEqual({ ...nothing, frontend: true })
  })

  it('runs only the backend tests for backend tests, the adapter template and the settings-migration data', () => {
    expect(areasFor(['backend/tests/ObservabilityCity.Tests/X.cs', 'templates/adapter/ExampleHttpSource.cs', 'shared-test-data/settings-migration/a.json'])).toEqual({ ...nothing, backend: true })
  })

  it('runs the backend and frontend tests, and not the browser tests, for data only those read', () => {
    expect(areasFor(['shared-test-data/snapshots/calm.json', 'shared-test-data/degraded-rules/cpu.json', 'shared-test-data/layout/galactic-credit.json'])).toEqual({ ...nothing, backend: true, frontend: true })
  })

  it('runs the backend tests and the registry checks for the validator and the town only backend tests load', () => {
    expect(areasFor(['backend/tools/ObservabilityCity.Validate/Program.cs', 'shared-test-data/registries/neutral-scope-town/town.yaml'])).toEqual({ ...nothing, backend: true, registries: true })
  })

  it('combines mixed changes and runs everything when it cannot tell', () => {
    expect(areasFor(['frontend/src/a.ts', 'AGENTS.md'])).toEqual({ ...nothing, frontend: true, ui: true, backend: true })
    expect(areasFor(['frontend/src/a.ts', 'backend/src/b.cs'])).toEqual(everything)
    expect(areasFor([])).toEqual(everything)
  })
})
