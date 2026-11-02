import type { NodeSnapshot, ScheduleSnapshot } from '../types'

/** Boats a second one mapped job that runs fine sends: a job is a handful of messages now and then, not a stream. */
export const JOB_BOAT_RATE = 0.03

/**
 * How fast boats sail for the scheduled jobs of an island. Only a job the pillar's file maps to services sends boats (an unmapped job has no known
 * target), each name counts once however many regions run it, and a job that failed its last run, or did not run when it should have, sends none:
 * the scheduler is in trouble, not busy. `nodeOf` finds a function's current reading by its id.
 */
export function schedulerRate(schedules: readonly ScheduleSnapshot[], nodeOf: (system: string) => Pick<NodeSnapshot, 'jobs' | 'state'> | null | undefined): number {
  let total = 0
  const seen = new Set<string>()
  for (const s of schedules) {
    if (s.services.length === 0) continue
    const node = nodeOf(s.system)
    if (!node || node.state === 'Stale') continue
    const runs = (node.jobs ?? []).filter((j) => j.name.toLowerCase() === s.job.toLowerCase())
    const key = `${s.system}/${s.job.toLowerCase()}`
    if (runs.length === 0 || seen.has(key) || runs.some((j) => j.status !== 'Ok')) continue
    seen.add(key)
    total += JOB_BOAT_RATE
  }
  return total
}
