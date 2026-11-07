import { describe, expect, it } from 'vitest'
import { FIT_STEPS, fitTopBar } from '../../src/topbarFit'

/** A bar that is only its class list: the rules for what is left out and in what order do not need a page. */
const fakeBar = () => {
  const on = new Set<string>()
  const bar = { classList: { add: (c: string) => on.add(c), remove: (...cs: string[]) => cs.forEach((c) => on.delete(c)) } } as unknown as HTMLElement
  return { bar, on }
}

describe('fitting the top bar on one line', () => {
  it('leaves everything in when the bar fits', () => {
    const { bar, on } = fakeBar()
    expect(fitTopBar(bar, () => false)).toBe(0)
    expect([...on]).toEqual([])
  })

  it('leaves out one more thing at a time, in order, until it fits', () => {
    const { bar, on } = fakeBar()
    // it fits once the second step is taken
    expect(fitTopBar(bar, () => on.size < 2)).toBe(2)
    expect([...on]).toEqual(['fit-1', 'fit-2'])
  })

  it('stops after the last step when it still does not fit, instead of looping', () => {
    const { bar, on } = fakeBar()
    expect(fitTopBar(bar, () => true)).toBe(FIT_STEPS.length)
    expect([...on]).toEqual([...FIT_STEPS])
  })

  it('starts from the whole bar each time, so a wider window gets its numbers back', () => {
    const { bar, on } = fakeBar()
    fitTopBar(bar, () => true)
    fitTopBar(bar, () => false)
    expect([...on]).toEqual([])
  })

  it('leaves the messages a second out before the dead letters, which stay until last', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8')
    expect(css).toMatch(/#topbar\.fit-5 \.chip\.msgs/)
    expect(css).toMatch(/#topbar\.fit-6 \.chip\.dlq/)
    expect(css).not.toMatch(/#topbar\.fit-5 \.chip\.dlq/)
  })
})
