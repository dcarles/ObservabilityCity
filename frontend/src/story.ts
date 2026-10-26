// The story bar's rules, apart from the page: the shapes the server sends, and how a position is shown.

export interface StorySummary {
  id: string
  name: string
  description?: string | null
  duration: number
  steps: { index: number; at: number; caption?: string | null; camera?: string | null }[]
}

export interface StoryState {
  storyId: string | null
  playing: boolean
  ended: boolean
  speed: number
  position: number
  duration: number
  step: number
  caption: string | null
  camera: string | null
  effects: { id: string; target: string; kind: string; intensity: number }[]
}

export const IDLE: StoryState = { storyId: null, playing: false, ended: false, speed: 1, position: 0, duration: 0, step: -1, caption: null, camera: null, effects: [] }

export const SPEEDS: readonly number[] = [0.5, 1, 2, 4, 8]

/** 75 seconds as "1:15". */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const speedText = (speed: number): string => `${speed}x`

/** The speed after this one, round to the first after the last. */
export function nextSpeed(speed: number): number {
  const i = SPEEDS.indexOf(speed)
  return SPEEDS[(i + 1) % SPEEDS.length] ?? 1
}

/** Where each step sits along the scrub bar, 0 to 1, for the tick marks. */
export function stepMarks(story: StorySummary): { index: number; at: number; fraction: number }[] {
  return story.steps.map((s) => ({ index: s.index, at: s.at, fraction: story.duration > 0 ? Math.min(1, s.at / story.duration) : 0 }))
}

/** What the play button does next. */
export function playAction(s: StoryState): 'play' | 'pause' | 'resume' {
  if (s.storyId === null) return 'play'
  return s.playing ? 'pause' : 'resume'
}

/**
 * The camera target to glide to now, or null when there is none or it was already visited: the camera moves when a new step with a camera
 * begins, and not again every time the state is read.
 */
export function cameraMove(last: { story: string | null; step: number }, s: StoryState): string | null {
  if (s.storyId === null) return null
  if (last.story === s.storyId && last.step === s.step) return null
  return s.camera
}
