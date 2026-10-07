// The band as the pure view draws it, for fixtures in each state: working,
// over the range, done (verified), done (unverified), narrow, collapsed, and
// the settings popover. Plain text, no colour: the border colour and badge
// fill are named beside each.
//
//   bun scripts/mock-band.ts [columns]

import { bandView, framedText, innerWidthOf, toolsView, TOOLS_COLUMNS, type BandOptions } from '../src/band'
import type { RangeEstimate } from '../src/estimator'
import type { Milestone, Plan } from '../src/milestones'
import type { ViewModel } from '../src/view'

const columns = Number(process.argv[2] ?? 155)
const STEPS = ['Pick the page style and layout', 'Check how the page gets live weather', 'Build the weather dashboard', 'Publish it and share the link']
const PROMPT = 'Build a weather dashboard for New York City, with a 7-day forecast and an air quality card'
const OPEN: BandOptions = { collapsed: false, showBasis: false }

function planOf(current: number): Plan {
  return {
    source: 'tasks',
    items: STEPS.map((label, i): Milestone => ({ id: String(i), label, state: i < current ? 'done' : i === current ? 'current' : 'pending' })),
  }
}

function range(overrides: Partial<RangeEstimate> = {}): RangeEstimate {
  return {
    kind: 'range',
    basis: 'from 3 similar tasks',
    remainingLowMs: 4 * 60_000,
    remainingHighMs: 9 * 60_000,
    totalLowMs: 5 * 60_000,
    totalHighMs: 10 * 60_000,
    sigmaMs: 60_000,
    confidence: 0.3,
    isOver: false,
    overByMs: 0,
    progress: 0.35,
    samples: 3,
    stepProgress: [1, 0.4, 0, 0],
    ...overrides,
  }
}

const base: ViewModel = {
  plan: planOf(1),
  estimate: range(),
  isWorking: true,
  showBasis: false,
  calibration: ['calibration: 61% of 18 tasks ended inside the range'],
  title: PROMPT,
  elapsedMs: 73_000,
  finished: null,
}

const done = (receipt: string | null): ViewModel => ({
  ...base,
  plan: planOf(4),
  estimate: null,
  isWorking: false,
  elapsedMs: 107_000,
  finished: { totalMs: 107_000, receipt, isAborted: false, waitingAgents: 0 },
})

function show(label: string, model: ViewModel, width = columns, options = OPEN): void {
  const view = bandView(model, width, options)
  console.log(`\n${label} · ${width} body columns · border ${view.border}`)
  for (const row of framedText(view.rows, innerWidthOf(width))) console.log(row)
}

show('working', base)
show('over the range', {
  ...base,
  plan: planOf(2),
  elapsedMs: 12 * 60_000 + 10_000,
  estimate: range({ isOver: true, overByMs: 130_000, progress: 0.62, remainingLowMs: 60_000, remainingHighMs: 4 * 60_000, stepProgress: [1, 1, 0.95, 0] }),
})
show('done, verified', done('receipt · bun test ✓ 152 pass · 1m ago'))
show('turn ended with steps left', { ...done(null), plan: planOf(2) })
show('done, agents still running', { ...done(null), finished: { totalMs: 107_000, receipt: null, isAborted: false, waitingAgents: 2 } })
show('done, unverified', done('UNVERIFIED · claimed done, no test/build/run after the last edit (src/x.ts at 14:02)'))
show('working, narrow terminal', base, 95)
show('done, unverified, narrow terminal', done('UNVERIFIED · claimed done, no test/build/run after the last edit (src/x.ts at 14:02)'), 95)
show('collapsed', base, columns, { ...OPEN, collapsed: true })
show('basis tooltip (b)', base, columns, { ...OPEN, showBasis: true })

const toolsWidth = Math.min(columns, TOOLS_COLUMNS) - 4
console.log(`\nsettings popover (t) · ${toolsWidth + 4} columns, right-aligned in the band`)
const rows = toolsView({ model: 'claude-opus-5-5[1m]', effort: 'high', rows: 'quiet', spike: true }, toolsWidth)
for (const row of framedText(rows, toolsWidth)) console.log(row.padStart(columns))
