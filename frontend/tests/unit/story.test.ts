import { describe, expect, it } from 'vitest'
import { cameraMove, clockText, IDLE, nextSpeed, playAction, SPEEDS, stepMarks, type StoryState, type StorySummary } from '../../src/story'

const story: StorySummary = {
  id: 's', name: 'S', duration: 40,
  steps: [{ index: 0, at: 0, caption: 'a' }, { index: 1, at: 10, caption: 'b', camera: 'x' }, { index: 2, at: 40 }],
}
const at = (over: Partial<StoryState>): StoryState => ({ ...IDLE, storyId: 's', duration: 40, ...over })

describe('story times', () => {
  it('shows minutes and seconds', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(9.9)).toBe('0:09')
    expect(clockText(75)).toBe('1:15')
    expect(clockText(-3)).toBe('0:00')
  })

  it('puts a tick for each step along the bar, none past the end', () => {
    expect(stepMarks(story).map((m) => m.fraction)).toEqual([0, 0.25, 1])
    expect(stepMarks({ ...story, duration: 0 }).map((m) => m.fraction)).toEqual([0, 0, 0])
  })

  it('goes through the speeds and round again', () => {
    expect(SPEEDS).toEqual([0.5, 1, 2, 4, 8])
    expect(nextSpeed(1)).toBe(2)
    expect(nextSpeed(8)).toBe(0.5)
    expect(nextSpeed(3)).toBe(0.5) // an unknown speed starts the round again
  })
})

describe('the play button', () => {
  it('plays when idle, pauses when playing, resumes when paused or ended', () => {
    expect(playAction(IDLE)).toBe('play')
    expect(playAction(at({ playing: true }))).toBe('pause')
    expect(playAction(at({ playing: false }))).toBe('resume')
    expect(playAction(at({ playing: false, ended: true }))).toBe('resume')
  })
})

describe('the camera of a story', () => {
  it('glides once when a step with a camera begins, and not again while the step lasts', () => {
    const last = { story: null as string | null, step: -2 }
    const first = at({ step: 1, camera: 'x' })

    expect(cameraMove(last, first)).toBe('x')
    expect(cameraMove({ story: 's', step: 1 }, first)).toBeNull()
    expect(cameraMove({ story: 's', step: 1 }, at({ step: 2, camera: null }))).toBeNull()
    expect(cameraMove({ story: 's', step: 2 }, at({ step: 1, camera: 'x' }))).toBe('x') // scrubbing back to it
  })

  it('does not move for a story that is not playing', () => {
    expect(cameraMove({ story: 's', step: 1 }, IDLE)).toBeNull()
  })

  it('starting the same story again moves the camera again', () => {
    expect(cameraMove({ story: null, step: -1 }, at({ step: 0, camera: 'y' }))).toBe('y')
  })
})
