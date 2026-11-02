import { describe, expect, it } from 'vitest'
import { jobRows } from '../../src/inspectorModel'
import { checkSnapshot } from '../../src/snapshotGuard'
import { JOB_BOAT_RATE, schedulerRate } from '../../src/scene/scheduler'
import type { JobSnapshot, ScheduleSnapshot } from '../../src/types'
import { healthyTown } from './wall.testutil'

// Phase 3, slice 5: the pillar's file says which services a scheduled job starts work for. A mapped job sails boats, an unmapped one does not and says so.

const job = (name: string, status: JobSnapshot['status'] = 'Ok', region: string | null = null): JobSnapshot => ({ name, region, status, lastRun: '2026-01-01T10:00:00Z', next: '2026-01-01T11:00:00Z' })
const map = (system: string, name: string, services: string[]): ScheduleSnapshot => ({ system, job: name, services })
const fn = (jobs: JobSnapshot[], state: 'Healthy' | 'Stale' = 'Healthy') => ({ jobs, state })

describe('the boats of a scheduler', () => {
  const schedules = [map('aa.sched', 'purge', ['orders']), map('aa.sched', 'daily', ['orders', 'reports'])]

  it('sail for each mapped job that runs fine, once however many regions run it', () => {
    const node = fn([job('purge', 'Ok', 'West'), job('purge', 'Ok', 'North'), job('daily')])
    expect(schedulerRate(schedules, () => node)).toBeCloseTo(2 * JOB_BOAT_RATE, 9)
  })

  it('match the job name whatever its case', () => {
    expect(schedulerRate([map('aa.sched', 'PURGE', ['orders'])], () => fn([job('purge')]))).toBeCloseTo(JOB_BOAT_RATE, 9)
  })

  it('do not sail for a job that is not mapped, or one mapped to no service', () => {
    expect(schedulerRate([], () => fn([job('purge')]))).toBe(0)
    expect(schedulerRate([map('aa.sched', 'purge', [])], () => fn([job('purge')]))).toBe(0)
  })

  it('stop for a job that failed or is late in any region: the scheduler is in trouble, not busy', () => {
    expect(schedulerRate(schedules, () => fn([job('purge', 'Failed', 'West'), job('purge', 'Ok', 'North'), job('daily', 'Overdue')]))).toBe(0)
  })

  it('stop when the function has no fresh reading, or none at all', () => {
    expect(schedulerRate(schedules, () => fn([job('purge')], 'Stale'))).toBe(0)
    expect(schedulerRate(schedules, () => undefined)).toBe(0)
    expect(schedulerRate(schedules, () => null)).toBe(0)
  })

  it('ignore a job the function does not run', () => {
    expect(schedulerRate(schedules, () => fn([job('weekly')]))).toBe(0)
  })
})

describe('the job rows with the pillar\'s schedules', () => {
  const n = { id: 'aa.sched', jobs: [job('daily', 'Ok', 'North'), job('hourly', 'Ok', 'West')] }

  it('say which services a mapped job starts work for, and that a missing one is not mapped', () => {
    const rows = jobRows(n, Date.parse('2026-01-01T12:00:00Z'), [map('aa.sched', 'daily', ['orders', 'reports'])])
    expect(rows[0]!.value).toMatch(/· starts orders, reports$/)
    expect(rows[1]!.value).toMatch(/· not mapped$/)
  })

  it('only look at the schedules of this function', () => {
    const rows = jobRows(n, Date.now(), [map('aa.other', 'daily', ['orders'])])
    expect(rows[0]!.value).toMatch(/not mapped$/)
  })

  it('say nothing about targets when no schedules are given', () => {
    expect(jobRows(n)[0]!.value).not.toMatch(/mapped|starts/)
  })
})

describe('the snapshot guard and schedules', () => {
  it('keeps a well formed schedule, drops one without a system or job, and treats a missing list as none', () => {
    const t = healthyTown() as any
    t.groups[0].messaging.schedules = [{ system: 'x.f', job: 'daily', services: ['a', 7, ''] }, { system: '', job: 'bad', services: [] }, { system: 'x.f', services: [] }, 'junk']
    const checked = checkSnapshot(t)
    expect(checked.snapshot!.groups[0]!.messaging.schedules).toEqual([{ system: 'x.f', job: 'daily', services: ['a'] }])

    delete t.groups[0].messaging.schedules
    expect(checkSnapshot(t).snapshot!.groups[0]!.messaging.schedules).toEqual([])
  })
})
