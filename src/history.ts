/**
 * The learning store: finished tasks, the statistics replayed from them, and
 * the mod's own calibration score (SPEC 3, "History" and "Learning").
 *
 * Only finished task records are persisted. EMA mean and variance per shape
 * key and step index are rebuilt by replaying those records oldest first, so
 * pruning the oldest tasks also ages them out of the statistics; there is no
 * second copy of the numbers to drift from the records.
 *
 * Invariant 8, the store stays under 1 MiB: `addTask` prunes to the newest
 * MAX_TASKS and then drops the oldest until the JSON fits MAX_BYTES.
 */

import { GLOBAL_KEY, levelKeysOf, planKeyOf, type Shape } from './shape'

export const HISTORY_KEY = 'history'
export const MAX_TASKS = 500
/** Under 1 MiB (1,048,576) with room for the store's own framing. */
export const MAX_BYTES = 1_000_000

export type TaskRecord = {
  /** When the task ended, ms. */
  at: number
  shape: Shape
  /** How long each step that ran took, in order, ms. */
  steps: number[]
  totalMs: number
  /**
   * Whether the total landed inside the last range shown before the final
   * step; absent when no range was ever shown.
   */
  inside?: boolean
}

export type History = {
  v: 1
  tasks: TaskRecord[]
}

export type Ema = {
  /** Sum of sample weights. A spike counts 0.5. */
  n: number
  mean: number
  var: number
}

export type Bucket = {
  total: Ema
  /** Per step index. */
  steps: Ema[]
  /** Every step duration, any index. */
  pooled: Ema
}

export type Stats = ReadonlyMap<string, Bucket>

export type Calibration = {
  inside: number
  total: number
}

/** The EMA's floor rate: early samples average, later ones decay at 10%. */
const ALPHA = 0.1

export const EMPTY_EMA: Ema = { n: 0, mean: 0, var: 0 }

export function emptyHistory(): History {
  return { v: 1, tasks: [] }
}

/**
 * Adds one sample at weight `w`. While few samples are in, this is the plain
 * running mean and population variance; past 1/ALPHA samples it decays.
 */
export function emaAdd(ema: Ema, x: number, w = 1): Ema {
  const n = ema.n + w
  const a = Math.min(1, Math.max(w / n, ALPHA * w))
  const d = x - ema.mean
  return { n, mean: ema.mean + a * d, var: (1 - a) * (ema.var + a * d * d) }
}

export function emptyBucket(): Bucket {
  return { total: EMPTY_EMA, steps: [], pooled: EMPTY_EMA }
}

/**
 * Folds one task into a bucket at a weight.
 */
export function bucketAdd(bucket: Bucket, steps: readonly number[], totalMs: number, w = 1): Bucket {
  const next: Ema[] = [...bucket.steps]
  let pooled = bucket.pooled
  steps.forEach((ms, i) => {
    next[i] = emaAdd(next[i] ?? EMPTY_EMA, ms, w)
    pooled = emaAdd(pooled, ms, w)
  })
  return { total: emaAdd(bucket.total, totalMs, w), steps: next, pooled }
}

/**
 * Replays every retained task, oldest first, into a bucket per shape level
 * and one global bucket.
 */
export function statsOf(history: History): Stats {
  const stats = new Map<string, Bucket>()
  for (const task of history.tasks) {
    for (const key of [...levelKeysOf(task.shape), GLOBAL_KEY]) {
      stats.set(key, bucketAdd(stats.get(key) ?? emptyBucket(), task.steps, task.totalMs))
    }
  }
  return stats
}

/**
 * Sample weight behind the plan-time shape (every field but tool mix), with
 * a spike counted at 0.5. The spike gate fires below 3.
 */
export function bucketSamples(stats: Stats, shape: Shape, spike?: readonly number[]): number {
  const real = stats.get(planKeyOf(shape))?.total.n ?? 0
  return real + (spike && spike.length > 0 ? 0.5 : 0)
}

export function sizeOf(history: History): number {
  return new TextEncoder().encode(JSON.stringify(history)).length
}

/**
 * The newest MAX_TASKS tasks, then the oldest dropped until the JSON fits.
 */
export function prune(history: History, maxBytes = MAX_BYTES): History {
  let tasks = history.tasks.slice(-MAX_TASKS)
  let size = sizeOf({ v: 1, tasks })
  while (size > maxBytes && tasks.length > 0) {
    const perTask = size / tasks.length
    const drop = Math.max(1, Math.ceil((size - maxBytes) / perTask))
    tasks = tasks.slice(drop)
    size = sizeOf({ v: 1, tasks })
  }
  return { v: 1, tasks }
}

export function addTask(history: History, task: TaskRecord): History {
  return prune({ v: 1, tasks: [...history.tasks, task] })
}

export function calibrationOf(history: History): Calibration {
  let inside = 0
  let total = 0
  for (const task of history.tasks) {
    if (task.inside === undefined) continue
    total += 1
    if (task.inside) inside += 1
  }
  return { inside, total }
}

/**
 * The calibration line, always shown, and a plain-words warning once the mod
 * has missed more often than not over 10 or more tasks (invariant 3).
 */
export function calibrationLines(calibration: Calibration): string[] {
  if (calibration.total === 0) return ['calibration: no finished tasks yet']
  const percent = Math.round((calibration.inside / calibration.total) * 100)
  const noun = calibration.total === 1 ? 'task' : 'tasks'
  const lines = [`calibration: ${percent}% of ${calibration.total} ${noun} ended inside the range`]
  if (calibration.total >= 10 && percent < 50) {
    lines.push('these ranges have missed more often than not; treat them as rough')
  }
  return lines
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShape(value: unknown): value is Shape {
  return (
    isRecord(value) &&
    typeof value.taskType === 'string' &&
    typeof value.steps === 'string' &&
    typeof value.repo === 'string' &&
    typeof value.hasTests === 'boolean' &&
    typeof value.mix === 'string'
  )
}

function isTask(value: unknown): value is TaskRecord {
  return (
    isRecord(value) &&
    typeof value.at === 'number' &&
    isShape(value.shape) &&
    Array.isArray(value.steps) &&
    value.steps.every(ms => typeof ms === 'number' && Number.isFinite(ms)) &&
    typeof value.totalMs === 'number' &&
    (value.inside === undefined || typeof value.inside === 'boolean')
  )
}

/**
 * Reads what the store holds, keeping only well-formed records: a corrupt or
 * foreign value is an empty history, never a crash in a hook.
 */
export function parseHistory(raw: unknown): History {
  if (!isRecord(raw) || !Array.isArray(raw.tasks)) return emptyHistory()
  return { v: 1, tasks: raw.tasks.filter(isTask) }
}
