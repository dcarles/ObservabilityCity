import { describe, expect, it } from 'vitest'
import { databaseSignText, engineSignText, engineSignTitle } from '../../src/engineSign'

describe('what a database building\'s sign says', () => {
  it('names the engine in capitals with the type under it', () => {
    expect(engineSignText({ name: 'SQL Server', typeName: 'Relational' })).toEqual({ title: 'SQL SERVER', sub: 'Relational' })
    expect(databaseSignText({ name: 'SQL Server', typeName: 'Relational' })).toBe('SQL SERVER · Relational')
  })

  it('says nothing when the database names no engine', () => {
    expect(engineSignText(null)).toBeNull()
    expect(engineSignText(undefined)).toBeNull()
    expect(engineSignText({ name: '  ', typeName: 'Document' })).toBeNull()
    expect(databaseSignText(null)).toBeUndefined()
  })

  it('shortens a long engine name to fit the board', () => {
    const title = engineSignTitle({ name: 'Azure Database for PostgreSQL', typeName: 'Relational' })
    expect(title.length).toBeLessThanOrEqual(14)
    expect(title.endsWith('…')).toBe(true)
  })
})
