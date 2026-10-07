import { describe, expect, test } from 'claude-code/testing'

import {
  addTask,
  bucketSamples,
  calibrationLines,
  calibrationOf,
  emptyHistory,
  MAX_BYTES,
  MAX_TASKS,
  parseHistory,
  prune,
  sizeOf,
  statsOf,
  type History,
  type TaskRecord,
} from '../src/history'
import type { Shape } from '../src/shape'

const SHAPE: Shape = { taskType: 'debug', steps: '2-3', repo: 'r1', hasTests: false, mix: 'edit' }

function recordOf(i: number, inside?: boolean): TaskRecord {
  return {
    at: 1_000 + i,
    shape: SHAPE,
    steps: [30_000 + i, 60_000, 45_000],
    totalMs: 135_000 + i,
    ...(inside === undefined ? {} : { inside }),
  }
}

function historyOf(records: TaskRecord[]): History {
  return records.reduce(addTask, emptyHistory())
}

describe('calibration', () => {
  test('10 synthetic tasks, 6 inside the range, read 60%', () => {
    const history = historyOf(Array.from({ length: 10 }, (_, i) => recordOf(i, i < 6)))
    expect(calibrationOf(history)).toEqual({ inside: 6, total: 10 })
    expect(calibrationLines(calibrationOf(history))).toEqual([
      'calibration: 60% of 10 tasks ended inside the range',
    ])
  })

  test('below 50% after 10 or more tasks, the pane says so in plain words', () => {
    const bad = calibrationOf(historyOf(Array.from({ length: 10 }, (_, i) => recordOf(i, i < 4))))
    const lines = calibrationLines(bad)
    expect(lines[0]).toBe('calibration: 40% of 10 tasks ended inside the range')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/missed more often than not/)

    // Nine tasks is too few to call it
    const early = calibrationOf(historyOf(Array.from({ length: 9 }, (_, i) => recordOf(i, i < 3))))
    expect(calibrationLines(early)).toHaveLength(1)
  })

  test('tasks that never showed a range do not count either way', () => {
    const history = historyOf([recordOf(0, true), recordOf(1), recordOf(2, false)])
    expect(calibrationOf(history)).toEqual({ inside: 1, total: 2 })
    expect(calibrationLines(calibrationOf(emptyHistory()))).toEqual(['calibration: no finished tasks yet'])
  })
})

describe('store pruning', () => {
  test('600 tasks keep the newest 500, oldest dropped, under 1 MiB', () => {
    const history = historyOf(Array.from({ length: 600 }, (_, i) => recordOf(i)))
    expect(history.tasks.length).toBeLessThanOrEqual(MAX_TASKS)
    expect(MAX_TASKS).toBe(500)
    expect(history.tasks[0]!.at).toBe(1_000 + 100)
    expect(history.tasks[history.tasks.length - 1]!.at).toBe(1_000 + 599)
    expect(sizeOf(history)).toBeLessThan(1024 * 1024)
    expect(MAX_BYTES).toBeLessThanOrEqual(1024 * 1024)
  })

  test('a byte cap drops the oldest until the store fits', () => {
    const history = historyOf(Array.from({ length: 200 }, (_, i) => recordOf(i)))
    const small = prune(history, 8_000)
    expect(sizeOf(small)).toBeLessThanOrEqual(8_000)
    expect(small.tasks[small.tasks.length - 1]!.at).toBe(1_000 + 199)
    expect(small.tasks.length).toBeGreaterThan(0)
  })

  test('a corrupt or foreign store value reads as empty, not a crash', () => {
    expect(parseHistory(undefined)).toEqual(emptyHistory())
    expect(parseHistory('nonsense')).toEqual(emptyHistory())
    expect(parseHistory({ v: 1, tasks: [{ at: 'x' }, recordOf(1)] }).tasks).toEqual([recordOf(1)])
  })
})

describe('samples', () => {
  test('2 samples plus a spike weigh 2.5', () => {
    const stats = statsOf(historyOf([recordOf(0), recordOf(1)]))
    expect(bucketSamples(stats, SHAPE)).toBe(2)
    expect(bucketSamples(stats, SHAPE, [60_000, 60_000, 60_000])).toBe(2.5)
  })
})
