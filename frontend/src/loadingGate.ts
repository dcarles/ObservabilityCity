import type { Snapshot, SourceFreshness } from './types'

/** How long the town stays greyed at most. After this the page shows what it has and says that some sources are still loading. */
export const LOADING_GIVE_UP_MS = 120_000

export const LOADING_TITLE = 'Loading town data'
export const LOADING_TEXT = 'Some sources are still reporting for the first time. Dead letters, degraded services and notices may be incomplete until they are done.'
export const LOADING_LATE_TEXT = 'Some sources are still loading, so some data may be missing.'

/** How many of the configured sources have finished a first round of asking, or null when there is nothing to wait for (no source listed). */
export function firstRounds(sources: readonly SourceFreshness[] | null | undefined): { done: number; total: number } | null {
  if (!sources || sources.length === 0) return null
  return { done: sources.filter((s) => s.firstRoundDone !== false).length, total: sources.length }
}

/** The progress line: "3 of 7 sources ready". */
export function progressText(p: { done: number; total: number }): string {
  return `${p.done} of ${p.total} source${p.total === 1 ? '' : 's'} ready`
}

/**
 * Whether this snapshot still has the town loading. A demo town (fake data, nothing to wait for), a server that lists no sources and a server
 * that does not say are never loading. A source that failed or timed out has finished its first round, so it never keeps the town greyed.
 */
export function isLoading(s: Pick<Snapshot, 'mode' | 'sources'>): boolean {
  if (s.mode === 'demo') return false
  const p = firstRounds(s.sources)
  return p !== null && p.done < p.total
}

export type LoadingPhase = 'waiting' | 'loading' | 'done' | 'late'

/**
 * The rule, without the page: waiting (no snapshot yet), loading (some source has not finished its first round), done, or late (the time was up
 * first). It happens once per page load: done and late are final.
 */
export class LoadingProgress {
  phase: LoadingPhase = 'waiting'
  progress: { done: number; total: number } | null = null
  private since: number | null = null

  constructor(private readonly giveUpMs = LOADING_GIVE_UP_MS) {}

  update(s: Pick<Snapshot, 'mode' | 'sources'>, now: number): LoadingPhase {
    if (this.phase === 'done' || this.phase === 'late') return this.phase
    if (!isLoading(s)) return (this.phase = 'done')
    this.progress = firstRounds(s.sources)
    this.since ??= now
    this.phase = 'loading'
    return this.tick(now)
  }

  /** Called as time passes too, since the feed may say nothing. */
  tick(now: number): LoadingPhase {
    if (this.phase === 'loading' && this.since !== null && now - this.since >= this.giveUpMs) this.phase = 'late'
    return this.phase
  }
}

/**
 * Greys the town (body class `loading-data`) and shows a card until every source has finished its first round. Notices and unknown hosts are
 * hidden with it by the style sheet, because they are wrong until every source has reported.
 */
export class LoadingGate {
  private rule: LoadingProgress
  private card: HTMLElement | null = null
  private timer: number | undefined

  constructor(private readonly giveUpMs = LOADING_GIVE_UP_MS) { this.rule = new LoadingProgress(giveUpMs) }

  /** For tests: forget that loading ever ended, as a page that has just opened would be. */
  reset(): void {
    this.finish(false)
    this.rule = new LoadingProgress(this.giveUpMs)
  }

  update(s: Pick<Snapshot, 'mode' | 'sources'>): void {
    this.show(this.rule.update(s, Date.now()))
  }

  private show(phase: LoadingPhase): void {
    if (phase === 'loading') {
      if (!this.card) this.open()
      this.card!.querySelector('.progress')!.textContent = this.rule.progress ? progressText(this.rule.progress) : ''
    } else if (phase === 'done' || phase === 'late') this.finish(phase === 'late')
  }

  private open(): void {
    document.body.classList.add('loading-data')
    const card = document.createElement('div')
    card.id = 'loading-card'
    card.setAttribute('role', 'status')
    card.innerHTML = `<b>${LOADING_TITLE}</b><p>${LOADING_TEXT}</p><div class="progress"></div>`
    document.body.append(card)
    this.card = card
    // the feed may be quiet, so the time is watched on its own
    this.timer = window.setTimeout(() => this.show(this.rule.tick(Date.now() + this.giveUpMs)), this.giveUpMs)
  }

  private finish(late: boolean): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    document.body.classList.remove('loading-data')
    if (!this.card) return
    if (!late) { this.card.remove(); this.card = null; return }
    // time is up: the town shows what it has and the card turns into a small note that can be closed
    this.card.classList.add('late')
    this.card.innerHTML = `<span>${LOADING_LATE_TEXT}</span> <button type="button" aria-label="Close">×</button>`
    this.card.querySelector('button')!.addEventListener('click', () => { this.card?.remove(); this.card = null })
  }
}
