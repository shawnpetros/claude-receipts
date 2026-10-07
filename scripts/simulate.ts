// A sanity run of the pure modules on a mocked clock: one 4-step task with an
// empty history (indeterminate, then the prior range, then narrowing to done),
// the same shape again with 3 learned samples, and a task that runs over.
//
//   bun scripts/simulate.ts

import { estimate, estimateRow, type Estimate } from '../src/estimator'
import { addTask, calibrationLines, calibrationOf, emptyHistory, statsOf, type History } from '../src/history'
import { completeCurrent, derivedPlan, emptyPlan, stepDurations, type Plan } from '../src/milestones'
import type { Shape } from '../src/shape'
import { barOf } from '../src/view'

const SHAPE: Shape = { taskType: 'build', steps: '4-6', repo: 'demo', hasTests: true, mix: 'none' }
const STEPS = ['Read the loader', 'Write the resolver', 'Add the tests', 'Run the suite']
const ACTUAL_MS = [70_000, 150_000, 95_000, 40_000]

function mmss(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, ' ')}:${String(s % 60).padStart(2, '0')}`
}

function show(label: string, t: number, est: Estimate): void {
  const progress = est.kind === 'range' ? est.progress : 0
  const sigma = est.kind === 'range' ? `σ ${mmss(est.sigmaMs)}` : '        '
  console.log(`  t=${mmss(t)}  ${barOf(progress, 12)}  ${sigma}  ${label.padEnd(22)} ${estimateRow(est)}`)
}

/**
 * Runs one task: `planAt` is when the derived plan lands; each step then
 * takes ACTUAL_MS scaled by `scale`. Prints the row at each event.
 */
function runTask(title: string, history: History, planAt: number, scale: number): History {
  console.log(`\n${title}`)
  const stats = statsOf(history)
  const t0 = 0
  let plan: Plan = emptyPlan()
  const at = (t: number, label: string) => show(label, t, estimate({ now: t0 + t, startedAt: t0, plan, stats, shape: SHAPE }))

  at(5_000, 'no plan yet')
  if (planAt > 90_000) {
    at(60_000, 'still no plan')
    at(90_000, '90s cap')
  }
  // The derived plan's first step started with the turn, as in the session
  plan = derivedPlan(STEPS, t0)
  at(planAt, 'plan derived')
  let t = 0
  STEPS.forEach((step, i) => {
    const ms = ACTUAL_MS[i]! * scale
    const mid = t + ms / 2
    if (mid > planAt) at(mid, `mid: ${step}`.slice(0, 22))
    t += ms
    plan = completeCurrent(plan, t0 + t)
    at(t, `done ${i + 1}/4`)
  })
  console.log(`  finished in ${mmss(t)}; steps ${stepDurations(plan, t0).map(mmss).join(', ')}`)
  return addTask(history, { at: t, shape: SHAPE, steps: stepDurations(plan, t0), totalMs: t, inside: true })
}

function runOver(history: History): void {
  console.log('\nOver: the same shape, but step 2 stalls')
  const stats = statsOf(history)
  let plan = derivedPlan(STEPS, 0)
  plan = completeCurrent(plan, ACTUAL_MS[0]!)
  for (const t of [ACTUAL_MS[0]! + 120_000, ACTUAL_MS[0]! + 420_000, ACTUAL_MS[0]! + 600_000, ACTUAL_MS[0]! + 900_000]) {
    show('step 2 still going', t, estimate({ now: t, startedAt: 0, plan, stats, shape: SHAPE }))
  }
}

let history = emptyHistory()
history = runTask('Task 1: empty history, plan lands at 1m 40s', history, 100_000, 1.6)
for (const scale of [0.9, 1.1]) {
  history = addTask(history, {
    at: 0,
    shape: SHAPE,
    steps: ACTUAL_MS.map(ms => ms * scale),
    totalMs: ACTUAL_MS.reduce((a, b) => a + b, 0) * scale,
    inside: scale < 1,
  })
}
history = runTask('Task 2: 3 similar tasks learned, plan lands at 10s', history, 10_000, 1.05)
runOver(history)
console.log('\n' + calibrationLines(calibrationOf(history)).join('\n'))
