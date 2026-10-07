import { describe, expect, test } from 'claude-code/testing'

import { estimate, estimateRow, INDETERMINATE_CAP_MS, type Estimate } from '../src/estimator'
import { addTask, emptyHistory, statsOf, type History } from '../src/history'
import { completeCurrent, derivedPlan, emptyPlan, fallbackPlan, type Plan } from '../src/milestones'
import type { Shape } from '../src/shape'

const T0 = 1_000_000
const SHAPE: Shape = { taskType: 'build', steps: '4-6', repo: 'r1', hasTests: true, mix: 'none' }
const STEP_MS = [60_000, 120_000, 90_000, 30_000]

/**
 * A history holding `count` finished 4-step tasks of SHAPE, each step within
 * a few seconds of STEP_MS.
 */
function historyOf(count: number): History {
  let history = emptyHistory()
  for (let i = 0; i < count; i += 1) {
    const jitter = (i % 3) * 4_000 - 4_000
    const steps = STEP_MS.map(ms => ms + jitter)
    history = addTask(history, {
      at: T0 - (count - i) * 1_000,
      shape: SHAPE,
      steps,
      totalMs: steps.reduce((a, b) => a + b, 0),
    })
  }
  return history
}

function fourStepPlan(): Plan {
  return derivedPlan(['read', 'plan', 'edit', 'verify'], T0)
}

function rangeOf(est: Estimate) {
  if (est.kind !== 'range') throw new Error('expected a range, got ' + est.kind)
  return est
}

describe('estimator', () => {
  test('zero history and no plan is indeterminate, then the prior range at 90s', () => {
    const stats = statsOf(emptyHistory())
    const early = estimate({ now: T0 + 5_000, startedAt: T0, plan: emptyPlan(), stats, shape: SHAPE })
    expect(early.kind).toBe('indeterminate')
    expect(estimateRow(early)).toBe('indeterminate')

    const justBefore = estimate({ now: T0 + INDETERMINATE_CAP_MS - 1, startedAt: T0, plan: emptyPlan(), stats, shape: SHAPE })
    expect(justBefore.kind).toBe('indeterminate')

    const capped = estimate({ now: T0 + INDETERMINATE_CAP_MS, startedAt: T0, plan: emptyPlan(), stats, shape: SHAPE })
    expect(capped.kind).toBe('range')
    expect(estimateRow(capped)).toMatch(/^~\d+ to \d+ min · prior only$/)

    // The fallback single milestone is no plan: still time-boxed the same way
    const fallback = estimate({ now: T0 + 5_000, startedAt: T0, plan: fallbackPlan(T0), stats, shape: SHAPE })
    expect(fallback.kind).toBe('indeterminate')
    const fallbackCapped = estimate({ now: T0 + INDETERMINATE_CAP_MS, startedAt: T0, plan: fallbackPlan(T0), stats, shape: SHAPE })
    expect(fallbackCapped.kind).toBe('range')
  })

  test('a first completed milestone ends indeterminate before 90s', () => {
    const stats = statsOf(emptyHistory())
    let plan = fallbackPlan(T0)
    plan = completeCurrent(plan, T0 + 10_000)
    const est = estimate({ now: T0 + 11_000, startedAt: T0, plan, stats, shape: SHAPE })
    expect(est.kind).toBe('range')
  })

  test('a derived plan with no history shows the prior range at once, labelled', () => {
    const est = estimate({ now: T0 + 1_000, startedAt: T0, plan: fourStepPlan(), stats: statsOf(emptyHistory()), shape: SHAPE })
    expect(est.kind).toBe('range')
    expect(estimateRow(est)).toMatch(/· prior only · derived plan$/)
  })

  test('with 3 samples the range narrows monotonically as steps complete', () => {
    const stats = statsOf(historyOf(3))
    let plan = fourStepPlan()
    let at = T0
    const sigmas: number[] = []
    const widths: number[] = []
    for (let i = 0; i < STEP_MS.length; i += 1) {
      // Sample at the start, middle and end of each step
      for (const part of [0, 0.5, 0.95]) {
        const est = rangeOf(estimate({ now: at + STEP_MS[i]! * part, startedAt: T0, plan, stats, shape: SHAPE }))
        expect(est.basis).toBe('from 3 similar tasks · derived plan')
        sigmas.push(est.sigmaMs)
        widths.push(est.remainingHighMs - est.remainingLowMs)
      }
      at += STEP_MS[i]!
      plan = completeCurrent(plan, at)
    }
    for (let i = 1; i < sigmas.length; i += 1) {
      expect(sigmas[i]!, `sigma at sample ${i}`).toBeLessThanOrEqual(sigmas[i - 1]!)
      expect(widths[i]!, `width at sample ${i}`).toBeLessThanOrEqual(widths[i - 1]! + 1e-6)
    }
    expect(sigmas[sigmas.length - 1]!).toBeLessThan(sigmas[0]!)
  })

  test('past the upper bound: over by, lower bound at least elapsed, never indeterminate', () => {
    for (const stats of [statsOf(emptyHistory()), statsOf(historyOf(5))]) {
      for (const plan of [fallbackPlan(T0), emptyPlan(), fourStepPlan()]) {
        const elapsed = 4 * 60 * 60_000
        const est = rangeOf(estimate({ now: T0 + elapsed, startedAt: T0, plan, stats, shape: SHAPE }))
        expect(est.isOver).toBe(true)
        expect(est.totalLowMs).toBeGreaterThanOrEqual(elapsed)
        expect(est.totalHighMs).toBeGreaterThan(est.totalLowMs)
        expect(estimateRow(est)).toMatch(/^over by \d+h \d+m · ~\d+ to \d+ min more · /)
      }
    }
    const est = rangeOf(estimate({ now: T0 + 130_000 + 10 * 60_000, startedAt: T0, plan: fallbackPlan(T0), stats: statsOf(emptyHistory()), shape: SHAPE }))
    expect(estimateRow(est)).toMatch(/^over by \d+m \d+s · /)
  })

  test('the over-by range keeps moving as time passes, never frozen', () => {
    const stats = statsOf(emptyHistory())
    const a = rangeOf(estimate({ now: T0 + 60 * 60_000, startedAt: T0, plan: fallbackPlan(T0), stats, shape: SHAPE }))
    const b = rangeOf(estimate({ now: T0 + 61 * 60_000, startedAt: T0, plan: fallbackPlan(T0), stats, shape: SHAPE }))
    expect(b.overByMs).toBeGreaterThan(a.overByMs)
    expect(b.totalLowMs).toBeGreaterThan(a.totalLowMs)
  })

  test('countdown digits only at confidence 0.5 or more', () => {
    // Few samples, early: low confidence, a range in minutes and no digits
    const early = rangeOf(estimate({ now: T0 + 1_000, startedAt: T0, plan: fourStepPlan(), stats: statsOf(historyOf(3)), shape: SHAPE }))
    expect(early.confidence).toBeLessThan(0.5)
    expect(estimateRow(early)).not.toMatch(/\d+:\d\d/)
    expect(estimateRow(early)).toMatch(/^~\d+ to \d+ min · /)

    // Many tight samples, last step under way: digits, still a range
    let plan = fourStepPlan()
    let at = T0
    for (let i = 0; i < 3; i += 1) {
      at += STEP_MS[i]!
      plan = completeCurrent(plan, at)
    }
    const late = rangeOf(estimate({ now: at + 1_000, startedAt: T0, plan, stats: statsOf(historyOf(30)), shape: SHAPE }))
    expect(late.confidence).toBeGreaterThanOrEqual(0.5)
    expect(estimateRow(late)).toMatch(/^\d+:\d\d to \d+:\d\d left · from 30 similar tasks · derived plan$/)

    // The threshold itself, on a hand-made estimate
    const base = { ...late, isOver: false, overByMs: 0, remainingLowMs: 120_000, remainingHighMs: 300_000 }
    expect(estimateRow({ ...base, confidence: 0.49 })).toMatch(/^~2 to 5 min/)
    expect(estimateRow({ ...base, confidence: 0.5 })).toMatch(/^2:00 to 5:00 left/)
  })

  test('never a point: a range that rounds to one value still shows two', () => {
    const est = rangeOf(estimate({ now: T0 + 1_000, startedAt: T0, plan: fourStepPlan(), stats: statsOf(historyOf(3)), shape: SHAPE }))
    const point = { ...est, confidence: 0, remainingLowMs: 125_000, remainingHighMs: 130_000 }
    expect(estimateRow(point)).toMatch(/^~2 to 3 min/)
    const tiny = { ...est, confidence: 0, remainingLowMs: 20_000, remainingHighMs: 21_000 }
    expect(estimateRow(tiny)).toMatch(/^~20 to 25 sec/)
  })

  test('progress is weighted by expected step duration, not by count', () => {
    const stats = statsOf(historyOf(5))
    // Step one (60s of 300s) done: one step of four is 25% by count, 20% by weight
    const plan = completeCurrent(fourStepPlan(), T0 + 60_000)
    const est = rangeOf(estimate({ now: T0 + 60_000, startedAt: T0, plan, stats, shape: SHAPE }))
    expect(est.progress).toBeGreaterThan(0.17)
    expect(est.progress).toBeLessThan(0.23)
  })
})
