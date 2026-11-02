import { describe, expect, it } from 'vitest'
import { deadLetterLinkRow } from '../../src/inspectorModel'

// Phase 3, slice 5: a consumer's drawer links to its dead letters in the team's support tool, when the environment names one.

describe('the link to a consumer\'s dead letters', () => {
  it('is a row of the "open in" list with the tool\'s name and address', () => {
    expect(deadLetterLinkRow({ deadLetterLink: { name: 'Support tool', url: 'https://support.example.test/q?team=al' } }))
      .toEqual({ resource: 'Dead letters', link: { name: 'Support tool', url: 'https://support.example.test/q?team=al' } })
  })

  it('is nothing when the environment names no tool, or the system has no detail', () => {
    expect(deadLetterLinkRow({})).toBeNull()
    expect(deadLetterLinkRow({ deadLetterLink: null })).toBeNull()
    expect(deadLetterLinkRow(null)).toBeNull()
    expect(deadLetterLinkRow(undefined)).toBeNull()
  })

  it('is nothing for an address that is not a web address, so a link can never run a script', () => {
    expect(deadLetterLinkRow({ deadLetterLink: { name: 'x', url: 'javascript:alert(1)' } })).toBeNull()
    expect(deadLetterLinkRow({ deadLetterLink: { name: 'x', url: '//evil.example.test' } })).toBeNull()
    expect(deadLetterLinkRow({ deadLetterLink: { name: '', url: 'https://ok.example.test' } })).toBeNull()
  })
})
