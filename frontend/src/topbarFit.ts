/**
 * Keeps the top bar on one line without anything cut off or overlapping. The dropdowns, the search and the town's name shorten first
 * (flexbox does that); when that is not enough, the least useful numbers are left out one at a time, the town time first, until the
 * rest fits. A window narrow enough for the bar to wrap to more rows is left alone: nothing is cut off there.
 */

/** The classes that leave things out, one more each step. style.css says what each one hides. */
export const FIT_STEPS = ['fit-1', 'fit-2', 'fit-3', 'fit-4'] as const

/** True when something in the bar is wider than the room it was given. */
export function barOverflows(bar: HTMLElement): boolean {
  if (getComputedStyle(bar).flexWrap !== 'nowrap') return false
  const tools = document.getElementById('tools')
  const room = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight)
  // the last control must end inside the bar, and the dropdowns must not be wider than the room they were given
  const pushedOut = !!tools && tools.getBoundingClientRect().width > 0 && tools.getBoundingClientRect().right > room + 1
  const views = document.getElementById('view-bar')
  return pushedOut || (!!views && views.scrollWidth > views.clientWidth + 1)
}

/** Starts from the whole bar and leaves out one more thing each time it still does not fit. Returns how many steps it took. */
export function fitTopBar(bar: HTMLElement, overflows: (bar: HTMLElement) => boolean = barOverflows): number {
  bar.classList.remove(...FIT_STEPS)
  let steps = 0
  for (const step of FIT_STEPS) {
    if (!overflows(bar)) break
    bar.classList.add(step)
    steps++
  }
  return steps
}
