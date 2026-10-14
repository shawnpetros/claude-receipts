// The band as the pure view draws it, for fixtures in each state: the six
// card states, then working with no task list, over the range, checks
// failed, narrow, collapsed, and the settings popover. Plain text, no colour: the border colour and badge
// fill are named beside each.
//
//   bun scripts/mock-band.ts [columns]

import { bandView, dividerRow, framedText, innerWidthOf, rowText, toolsView, TOOLS_COLUMNS, type BandOptions } from '../src/band'
import { receiptsSwitches } from '../src/switches'
import type { RangeEstimate } from '../src/estimator'
import type { Milestone, Plan } from '../src/milestones'
import type { Finished, ViewModel } from '../src/view'

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

const VERIFIED = 'receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago'
const UNVERIFIED = 'UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since'

const ended = (plan: Plan, finished: Partial<Finished>): ViewModel => ({
  ...base,
  plan,
  estimate: null,
  isWorking: false,
  elapsedMs: 107_000,
  finished: {
    totalMs: 107_000,
    receipt: null,
    isAborted: false,
    waitingAgents: 0,
    ledger: 'none',
    claimsDone: false,
    hasWork: true,
    crossCheck: null,
    ...finished,
  },
})

function show(label: string, model: ViewModel, width = columns, options = OPEN): void {
  const view = bandView(model, width, options)
  console.log(`\n${label} · ${width} body columns · border ${view.border}`)
  for (const row of framedText(view.rows, innerWidthOf(width))) console.log(row)
  console.log(rowText(dividerRow(width, 'Clean View')))
}

// The six card states (SPEC-0.3 section 5)
show('1. working', base)
show('2. turn ended, steps left', ended(planOf(2), { ledger: 'unverified' }))
show(
  '3. all done',
  ended(planOf(4), {
    ledger: 'verified',
    claimsDone: true,
    receipt: VERIFIED,
    crossCheck: { state: 'confirmed', model: 'opus', reason: 'reran green', reran: true, exit: 0, command: 'bun test', ms: 38_000 },
  }),
)
show('4. done, unverified', ended(planOf(4), { ledger: 'unverified', claimsDone: true, receipt: UNVERIFIED, crossCheck: { state: 'running', model: 'opus' } }))
show(
  '5. done, refuted',
  ended(planOf(4), {
    ledger: 'verified',
    claimsDone: true,
    receipt: VERIFIED,
    crossCheck: { state: 'refuted', model: 'opus', reason: 'tests cover only the happy path', reran: false, exit: null, ms: 20_000 },
  }),
)
show('6. answered', { ...ended({ source: 'answer', items: [{ id: 'answer', label: 'answer the question', state: 'done' }] }, { hasWork: false, totalMs: 25_000 }), title: 'can we invite them by email?' })

// And the rest
show('working, no task list recorded', { ...base, plan: { source: 'tasks', items: [] }, estimate: { kind: 'indeterminate' }, elapsedMs: 73_000 })
show('over the range', {
  ...base,
  plan: planOf(2),
  elapsedMs: 12 * 60_000 + 10_000,
  estimate: range({ isOver: true, overByMs: 130_000, progress: 0.62, remainingLowMs: 60_000, remainingHighMs: 4 * 60_000, stepProgress: [1, 1, 0.95, 0] }),
})
show(
  'checks failed',
  ended(planOf(4), { ledger: 'failed', claimsDone: true, receipt: 'FAILED · cargo test · exit 101 · test result: FAILED. 3 passed; 2 failed; 0 ignored' }),
)
show('working, narrow terminal', base, 95)
show('done, unverified, narrow terminal', ended(planOf(4), { ledger: 'unverified', claimsDone: true, receipt: UNVERIFIED }), 95)
show('collapsed', base, columns, { ...OPEN, collapsed: true })

const toolsWidth = Math.min(columns, TOOLS_COLUMNS) - 4
console.log(`\ntools panel · ${toolsWidth + 4} columns, right-aligned in the band, opened from the footer`)
const rows = toolsView(
  {
    model: 'claude-opus-5-5[1m]',
    effort: 'high',
    rows: 'quiet',
    crossCheck: true,
    spike: true,
    chatter: true,
    mods: [
      ...receiptsSwitches(true).map(entry => ({ mod: 'receipts', ...entry })),
      { mod: 'buddy', id: 'buddy', label: 'Buddy', description: 'a companion in the corner', value: false },
    ],
  },
  toolsWidth,
)
for (const row of framedText(rows, toolsWidth)) console.log(row.padStart(columns))
console.log(rowText(dividerRow(columns, 'Clean View')))
console.log(`${'footer, closed:'.padEnd(columns - 18)}◆ Shawn's Tools ▲`)
console.log(`${'footer, open:'.padEnd(columns - 18)}◆ Shawn's Tools ▼`)
