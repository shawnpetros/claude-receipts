/**
 * The estimate (SPEC 3): remaining time as a range with its basis named.
 *
 * The honesty contract, and the scar behind each rule:
 * - Never a point, never a frozen countdown (invariant 1; every "ETA" in
 *   every tool ever). `estimateRow` always prints two different numbers, and
 *   the over-by branch keeps moving with the clock.
 * - Indeterminate is time-boxed (invariant 2; "don't cheat and just stay
 *   indeterminate"): only while there is no plan AND no history, and never
 *   past the first completed milestone or 90 seconds.
 * - The basis is always named (invariant 3).
 * - Countdown digits only at confidence 0.5 or more, and even then as a
 *   range: `3:52 to 8:40 left`.
 *
 * Remaining time = sum over the steps not done of their expected duration,
 * from the most specific shape bucket with 3 or more samples, else a coarser
 * one, else the global prior. sigma sums only the steps not yet done, so it
 * shrinks as steps complete; each step's sigma also shrinks with samples.
 */

import { emptyBucket, type Bucket, type Stats, bucketAdd } from './history'
import { hasCompleted, type Plan } from './milestones'
import { GLOBAL_KEY, levelKeysOf, planKeyOf, planlessKeysOf, type Shape } from './shape'

export const INDETERMINATE_CAP_MS = 90_000
/** Interval half-width in sigmas: about an 87% band for a normal. */
export const K = 1.5
export const MIN_SAMPLES = 3
export const COUNTDOWN_CONFIDENCE = 0.5

/** The prior when nothing has been learned: a step, and a whole task. */
const DEFAULT_STEP = { mean: 120_000, sd: 90_000 }
const DEFAULT_TOTAL = { mean: 300_000, sd: 180_000 }
/** How much wider the prior is than its own sd. */
const PRIOR_SPREAD = 1.25
/** No step is ever known to better than a quarter of its length, or 15s. */
const SD_FLOOR_RATIO = 0.25
const SD_FLOOR_MS = 15_000
/** A step under way always has a tenth of its expected time left. */
const MIN_LEFT_RATIO = 0.1
/** Past the range, re-widen by half of what the estimate missed by. */
const OVER_WIDEN = 0.5

export type EstimateInput = {
  now: number
  startedAt: number
  plan: Plan
  stats: Stats
  shape: Shape
  /** The spike subagent's minutes per step, in ms; one sample at weight 0.5. */
  spike?: readonly number[]
}

export type RangeEstimate = {
  kind: 'range'
  basis: string
  remainingLowMs: number
  remainingHighMs: number
  totalLowMs: number
  totalHighMs: number
  sigmaMs: number
  confidence: number
  isOver: boolean
  overByMs: number
  /** Fraction done, weighted by expected step durations. */
  progress: number
  samples: number
}

export type Estimate = { kind: 'indeterminate' } | RangeEstimate

type Basis = {
  bucket: Bucket | null
  label: string
  /** Effective samples for confidence; 0 for any prior. */
  samples: number
}

type Expectation = {
  mean: number
  sd: number
}

export function estimate(input: EstimateInput): Estimate {
  const { now, startedAt, plan, stats } = input
  const elapsed = Math.max(0, now - startedAt)
  const isPlanless = plan.source === 'none' || plan.source === 'fallback'
  const hasHistory = (stats.get(GLOBAL_KEY)?.total.n ?? 0) > 0

  if (isPlanless && !hasHistory && elapsed < INDETERMINATE_CAP_MS && !hasCompleted(plan)) {
    return { kind: 'indeterminate' }
  }

  return isPlanless ? totalMode(input, elapsed) : stepMode(input, elapsed)
}

/**
 * No plan to walk: the whole task's learned duration against elapsed time.
 */
function totalMode(input: EstimateInput, elapsed: number): RangeEstimate {
  const basis = basisOf(input.stats, planlessKeysOf(input.shape))
  const exp = basis.bucket ? spreadOf(basis.bucket.total.mean, basis.bucket.total.var, basis.samples) : priorOf(DEFAULT_TOTAL)
  const remMean = Math.max(exp.mean - elapsed, MIN_LEFT_RATIO * exp.mean)
  const plannedHigh = exp.mean + K * exp.sd
  const progress = Math.min(elapsed / exp.mean, 0.95)
  return rangeOf({ elapsed, remMean, sigma: exp.sd, plannedHigh, progress, basis, suffix: '' })
}

/**
 * A plan to walk: each step not done contributes its expected duration, the
 * one under way less what it has used.
 */
function stepMode(input: EstimateInput, elapsed: number): RangeEstimate {
  const { now, startedAt, plan, stats, shape, spike } = input
  const basis = basisOf(stats, levelKeysOf(shape), spike, planKeyOf(shape))
  const items = plan.items
  const stepCount = items.length
  const hasCurrent = items.some(item => item.state === 'current')
  const implicit = hasCurrent ? -1 : items.findIndex(item => item.state === 'pending')

  let remMean = 0
  let remVar = 0
  let doneWeight = 0
  let totalWeight = 0
  let plannedEnd: number | null = null
  let pendingMean = 0
  let previousEnd = startedAt

  items.forEach((item, i) => {
    const exp = basis.bucket ? stepExpectation(basis.bucket, i, stepCount, basis.samples) : priorOf(DEFAULT_STEP)
    totalWeight += exp.mean
    if (item.state === 'done') {
      doneWeight += exp.mean
      previousEnd = item.doneAt ?? previousEnd
      return
    }
    remVar += exp.sd * exp.sd
    if (item.state === 'current' || i === implicit) {
      const start = item.startedAt ?? previousEnd
      const inStep = Math.max(0, now - start)
      remMean += Math.max(exp.mean - inStep, MIN_LEFT_RATIO * exp.mean)
      doneWeight += Math.min(inStep / exp.mean, 0.95) * exp.mean
      plannedEnd = Math.max(plannedEnd ?? -Infinity, start + exp.mean)
      return
    }
    remMean += exp.mean
    pendingMean += exp.mean
  })

  const sigma = Math.sqrt(remVar)
  const plannedHigh = (plannedEnd ?? now) - startedAt + pendingMean + K * sigma
  const progress = totalWeight > 0 ? doneWeight / totalWeight : 0
  const suffix = plan.source === 'derived' ? ' · derived plan' : ''
  return rangeOf({ elapsed, remMean, sigma, plannedHigh, progress, basis, suffix })
}

function rangeOf(args: {
  elapsed: number
  remMean: number
  sigma: number
  plannedHigh: number
  progress: number
  basis: Basis
  suffix: string
}): RangeEstimate {
  const { elapsed, remMean, sigma, plannedHigh, progress, basis } = args
  const isOver = elapsed > plannedHigh
  const overByMs = isOver ? elapsed - plannedHigh : 0
  const remainingLowMs = Math.max(0, remMean - K * sigma)
  const remainingHighMs = remMean + K * sigma + OVER_WIDEN * overByMs
  const n = basis.samples
  const cv = sigma / Math.max(remMean, 1)
  const confidence = n <= 0 ? 0 : (n / (n + MIN_SAMPLES)) * (0.6 + 0.4 * progress) / (1 + cv)
  return {
    kind: 'range',
    basis: basis.label + args.suffix,
    remainingLowMs,
    remainingHighMs,
    totalLowMs: elapsed + remainingLowMs,
    totalHighMs: elapsed + remainingHighMs,
    sigmaMs: sigma,
    confidence: Math.max(0, Math.min(1, confidence)),
    isOver,
    overByMs,
    progress: Math.max(0, Math.min(1, progress)),
    samples: n,
  }
}

/**
 * The most specific bucket with MIN_SAMPLES or more; else, with a spike, the
 * plan-time bucket plus the spike at weight 0.5; else the global prior.
 */
function basisOf(stats: Stats, keys: readonly string[], spike?: readonly number[], spikeKey?: string): Basis {
  for (const key of keys) {
    const bucket = stats.get(key)
    if (bucket && bucket.total.n >= MIN_SAMPLES) {
      return { bucket, label: `from ${countOf(bucket.total.n)} similar tasks`, samples: bucket.total.n }
    }
  }
  if (spike && spike.length > 0 && spikeKey !== undefined) {
    const real = stats.get(spikeKey) ?? emptyBucket()
    const bucket = bucketAdd(real, spike, spike.reduce((a, b) => a + b, 0), 0.5)
    const n = real.total.n
    return { bucket, label: n > 0 ? `spike guess + ${countOf(n)} similar` : 'spike guess', samples: bucket.total.n }
  }
  const global = stats.get(GLOBAL_KEY)
  if (global && global.total.n > 0) return { bucket: global, label: 'prior only', samples: 0 }
  return { bucket: null, label: 'prior only', samples: 0 }
}

function stepExpectation(bucket: Bucket, index: number, stepCount: number, samples: number): Expectation {
  const own = bucket.steps[index]
  if (own && own.n > 0) return spreadOf(own.mean, own.var, samples)
  if (bucket.pooled.n > 0) return spreadOf(bucket.pooled.mean, bucket.pooled.var, samples)
  return spreadOf(bucket.total.mean / Math.max(1, stepCount), bucket.total.var / Math.max(1, stepCount), samples)
}

/**
 * A learned mean and variance as an expectation: the sd floored, then
 * widened for how few samples stand behind it (predictive sd, sqrt(1 + 1/n));
 * a bucket used only as a prior gets the prior's spread.
 */
function spreadOf(mean: number, variance: number, samples: number): Expectation {
  const safeMean = Math.max(mean, 1_000)
  const sd = Math.max(Math.sqrt(Math.max(variance, 0)), SD_FLOOR_RATIO * safeMean, SD_FLOOR_MS)
  const widen = samples > 0 ? Math.sqrt(1 + 1 / samples) : PRIOR_SPREAD
  return { mean: safeMean, sd: sd * widen }
}

function priorOf(prior: Expectation): Expectation {
  return { mean: prior.mean, sd: prior.sd * PRIOR_SPREAD }
}

function countOf(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * The estimate row the pane and band print.
 */
export function estimateRow(est: Estimate): string {
  if (est.kind === 'indeterminate') return 'indeterminate'
  if (est.isOver) {
    return `over by ${durationOf(est.overByMs)} · ${approxRangeOf(est.remainingLowMs, est.remainingHighMs)} more · ${est.basis}`
  }
  const range =
    est.confidence >= COUNTDOWN_CONFIDENCE
      ? `${digitsOf(est.remainingLowMs)} to ${digitsOf(Math.max(est.remainingHighMs, est.remainingLowMs + 1_000))} left`
      : approxRangeOf(est.remainingLowMs, est.remainingHighMs)
  return `${range} · ${est.basis}`
}

/**
 * `~4 to 9 min`, or `~20 to 45 sec` when the top is under a minute. The two
 * numbers always differ: a range that rounds to one value is widened.
 */
export function approxRangeOf(lowMs: number, highMs: number): string {
  if (highMs < 60_000) {
    const low = Math.floor(lowMs / 5_000) * 5
    let high = Math.ceil(highMs / 5_000) * 5
    if (high <= low) high = low + 5
    return `~${low} to ${high} sec`
  }
  const low = Math.floor(lowMs / 60_000)
  let high = Math.ceil(highMs / 60_000)
  if (high <= low) high = low + 1
  return `~${low} to ${high} min`
}

function digitsOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * `2m 10s`, `45s`, `1h 5m`.
 */
export function durationOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The basis button's detail: where the numbers come from, in plain words.
 */
export function basisLines(est: Estimate): string[] {
  if (est.kind === 'indeterminate') {
    return ['basis: no plan and no history yet; a range from the prior shows by 90s or the first finished milestone']
  }
  return [
    `basis: ${est.basis}`,
    `sigma ±${durationOf(est.sigmaMs)} over the steps left · confidence ${est.confidence.toFixed(2)}`,
    `whole task: ${durationOf(est.totalLowMs)} to ${durationOf(est.totalHighMs)}`,
  ]
}
