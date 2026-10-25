import type { Page, TestInfo } from '@playwright/test'

export interface FrameCost {
  ms: number
  calls: number
  triangles: number
}

/** Draws the town a few times and returns the median cost. Software rendering is slow, so the budgets are set for it. */
export async function frameCost(page: Page, frames = 3): Promise<FrameCost> {
  const costs: FrameCost[] = []
  for (let i = 0; i < frames; i++) costs.push(await page.evaluate(() => (window as any).city.measureFrame()))
  costs.sort((a, b) => a.ms - b.ms)
  return costs[Math.floor(costs.length / 2)]
}

/** Puts a line in the test report and in the log, so a trend can be read from CI runs. */
export function note(info: TestInfo, name: string, value: string): void {
  info.annotations.push({ type: name, description: value })
  console.log(`[perf] ${name}: ${value}`)
}
