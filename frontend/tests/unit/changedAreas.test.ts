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

  it('runs everything for backend, shared data, config, contracts, workflows and anything unknown', () => {
    for (const file of ['backend/src/ObservabilityCity.Core/X.cs', 'shared-test-data/snapshots/calm.json', 'config/galactic-credit/town.yaml', 'contracts/openapi.json',
      '.github/workflows/ci.yml', '.github/scripts/changed-areas.mjs', 'global.json', 'something/new.bin'])
      expect(areasFor([file])).toEqual(everything)
  })

  it('combines mixed changes and runs everything when it cannot tell', () => {
    expect(areasFor(['frontend/src/a.ts', 'AGENTS.md'])).toEqual({ ...nothing, frontend: true, ui: true, backend: true })
    expect(areasFor(['frontend/src/a.ts', 'backend/src/b.cs'])).toEqual(everything)
    expect(areasFor([])).toEqual(everything)
  })
})
