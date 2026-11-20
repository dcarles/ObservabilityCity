import { describe, expect, it } from 'vitest'
import type { SourceFreshness } from '../../src/types'
import { firstRounds, isLoading, LoadingProgress, progressText } from '../../src/loadingGate'

// a server older than this page leaves the field out, so it can be missing
const src = (name: string, firstRoundDone?: boolean) => ({ name, lastRead: null, intervalSeconds: 10, overdue: false, ...(firstRoundDone === undefined ? {} : { firstRoundDone }) }) as SourceFreshness

describe('when the town is still loading', () => {
  it('is loading while any listed source has not finished a first round', () => {
    expect(isLoading({ mode: 'live', sources: [src('a', true), src('b', false)] })).toBe(true)
    expect(isLoading({ mode: 'live', sources: [src('a', true), src('b', true)] })).toBe(false)
  })

  it('never waits for a demo town, a town with no sources, or a server that does not say', () => {
    expect(isLoading({ mode: 'demo', sources: [src('a', false)] })).toBe(false)
    expect(isLoading({ mode: 'live', sources: null })).toBe(false)
    expect(isLoading({ mode: 'live', sources: [] })).toBe(false)
    expect(isLoading({ mode: 'live', sources: [src('a')] })).toBe(false)
  })

  it('counts the sources that are done', () => {
    const p = firstRounds([src('a', true), src('b', false), src('c', true)])
    expect(p).toEqual({ done: 2, total: 3 })
    expect(progressText(p!)).toBe('2 of 3 sources ready')
    expect(progressText({ done: 0, total: 1 })).toBe('0 of 1 source ready')
  })
})

describe('the loading rule over time', () => {
  const live = (...sources: SourceFreshness[]) => ({ mode: 'live', sources })

  it('waits for a first snapshot, loads while a source is out, and is done when all are in', () => {
    const p = new LoadingProgress()
    expect(p.phase).toBe('waiting')
    expect(p.update(live(src('a', true), src('b', false)), 0)).toBe('loading')
    expect(p.progress).toEqual({ done: 1, total: 2 })
    expect(p.update(live(src('a', true), src('b', true)), 5_000)).toBe('done')
  })

  it('happens once: a source that is not done later does not bring it back', () => {
    const p = new LoadingProgress()
    p.update(live(src('a', true)), 0)
    expect(p.update(live(src('a', false)), 1_000)).toBe('done')
  })

  it('is over at once for a demo town', () => {
    expect(new LoadingProgress().update({ mode: 'demo', sources: [src('a', false)] }, 0)).toBe('done')
  })

  it('gives up after the time, counted from the first snapshot that was loading, even if the feed says nothing more', () => {
    const p = new LoadingProgress(120_000)
    p.update(live(src('a', false)), 10_000)
    expect(p.tick(129_999)).toBe('loading')
    expect(p.tick(130_000)).toBe('late')
    expect(p.update(live(src('a', true)), 131_000)).toBe('late') // final
  })

  it('stays on the first source that never answers: a failed one counts as answered by the server, so only a source with no first round waits', () => {
    const p = new LoadingProgress(1000)
    expect(p.update(live(src('slow', false)), 0)).toBe('loading')
    expect(p.update(live(src('slow', false)), 1500)).toBe('late')
  })
})
