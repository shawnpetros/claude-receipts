import { describe, expect, test } from 'claude-code/testing'

import { bandView, innerWidthOf, MAX_STEP_ROWS, rowText, type BandView } from '../src/band'
import type { RangeEstimate } from '../src/estimator'
import type { Milestone, Plan } from '../src/milestones'
import type { ViewModel } from '../src/view'
import { BAND, BAND_WIDE, linesOf, worldOf } from './fixtures'

const PROMPT = 'Build a weather dashboard for New York City, with a 7-day forecast and an air quality card'

function planOf(labels: readonly string[], current: number, source: Plan['source'] = 'tasks'): Plan {
  return {
    source,
    items: labels.map((label, i): Milestone => ({
      id: String(i),
      label,
      state: i < current ? 'done' : i === current ? 'current' : 'pending',
    })),
  }
}

function rangeOf(overrides: Partial<RangeEstimate> = {}): RangeEstimate {
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

function workingOf(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    plan: planOf(['Pick the page style and layout', 'Check how the page gets live weather', 'Build the weather dashboard', 'Publish it and share the link'], 1),
    estimate: rangeOf(),
    isWorking: true,
    showBasis: false,
    calibration: ['calibration: 61% of 18 tasks ended inside the range'],
    title: PROMPT,
    elapsedMs: 13_000,
    finished: null,
    ...overrides,
  }
}

function doneOf(receipt: string | null): ViewModel {
  const plan = planOf(['Pick the page style and layout', 'Check how the page gets live weather', 'Build the weather dashboard', 'Publish it and share the link'], 4)
  return workingOf({
    plan,
    estimate: null,
    isWorking: false,
    elapsedMs: 107_000,
    finished: { totalMs: 107_000, receipt, isAborted: false, waitingAgents: 0, ledger: 'verified', claimsDone: true, hasWork: true, crossCheck: null },
  })
}

const OPTIONS = { collapsed: false, showBasis: false }

function textsOf(view: BandView): string[] {
  return view.rows.map(rowText)
}

describe('band layout (pure)', () => {
  test('at 160 columns: title, summary, one row per step, every row exactly the inner width', () => {
    const columns = 155
    const view = bandView(workingOf(), columns, OPTIONS)
    const rows = textsOf(view)
    expect(view.tone).toBe('working')
    expect(rows).toHaveLength(2 + 4)
    for (const row of rows) expect([...row].length, row).toBe(innerWidthOf(columns))
    expect(rows[0]).toMatch(/^✶ Build a weather dashboard/)
    expect(rows[0]).toMatch(/13s \[▾\]$/)
    expect(rows[1]).toMatch(/^Step 2 of 4 /)
    expect(rows[1]).toMatch(/35% {2}~4 to 9 min · from 3 similar tasks$/)
    // Per-step rows: a 12-cell mini bar and a state word
    expect(rows[2]).toMatch(/^✓ Pick the page style and layout +█{12} {2}Done/)
    expect(rows[3]).toMatch(/^● Check how the page gets live weather +█{5}░{7} {2}Working/)
    expect(rows[4]).toMatch(/^○ Build the weather dashboard +░{12} {2}Next/)
    expect(rows[5]).toMatch(/ {2}Later/)
  })

  test('below 110 columns the per-step bars drop and nothing overflows', () => {
    const columns = 95
    const rows = textsOf(bandView(workingOf(), columns, OPTIONS))
    expect(rows).toHaveLength(6)
    for (const row of rows) expect([...row].length, row).toBe(innerWidthOf(columns))
    for (const row of rows.slice(2)) expect(row).not.toMatch(/[█░]/)
    expect(rows[3]).toMatch(/Working/)
  })

  test('more than six steps: six rows around the current one, then "+n more"', () => {
    const labels = Array.from({ length: 9 }, (_, i) => `Step number ${i + 1}`)
    const rows = textsOf(bandView(workingOf({ plan: planOf(labels, 5) }), 155, OPTIONS))
    expect(rows).toHaveLength(2 + MAX_STEP_ROWS + 1)
    expect(rows.some(row => row.startsWith('● Step number 6'))).toBe(true)
    expect(rows[rows.length - 1]).toMatch(/^\+3 more/)
  })

  test('collapsed: the title row alone, with the expand mark', () => {
    const rows = textsOf(bandView(workingOf(), 155, { ...OPTIONS, collapsed: true }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/\[▸\]$/)
  })

  test('the estimate is honest in the band: indeterminate, over by, basis named', () => {
    const indeterminate = textsOf(bandView(workingOf({ estimate: { kind: 'indeterminate' } }), 155, OPTIONS))
    expect(indeterminate[1]).toMatch(/indeterminate$/)

    const over = bandView(workingOf({ estimate: rangeOf({ isOver: true, overByMs: 130_000 }) }), 155, OPTIONS)
    expect(over.tone).toBe('over')
    expect(rowText(over.rows[1]!)).toMatch(/over by 2m 10s · ~4 to 9 min more · from 3 similar tasks$/)

    // 0.3.0: the "derived" label went with plan derivation
  })

  test('calibration is a tooltip on b, except a failing score, which stays', () => {
    const plain = textsOf(bandView(workingOf(), 155, OPTIONS))
    expect(plain.join('\n')).not.toMatch(/calibration/)
    const asked = textsOf(bandView(workingOf(), 155, { ...OPTIONS, showBasis: true }))
    expect(asked[asked.length - 1]).toMatch(/^basis: from 3 similar tasks · calibration: 61% of 18 tasks/)
    const bad = textsOf(bandView(workingOf({ calibration: ['calibration: 40% of 10 tasks ended inside the range', 'these ranges have missed more often than not; treat them as rough'] }), 155, OPTIONS))
    expect(bad[bad.length - 1]).toMatch(/^these ranges have missed/)
  })
})

// 0.3.0: three card tests were deleted because the 0.2 card they encoded is
// gone ("verified: the badge carries the receipt", "unverified: a warning
// badge, and the receipt text in the title row", "a failed verify run is not
// all done"); the receipt now has its own row. v030.test.ts covers all six states.
describe('completion card (pure)', () => {
  test('green: "✓ All done", n of n steps, a full bar, took, every step done', () => {
    const view = bandView(doneOf(null), 155, OPTIONS)
    const rows = textsOf(view)
    expect(view.tone).toBe('done')
    expect(view.border).toBe('success')
    expect(rows[0]).toMatch(/^ ✓ All done  Build a weather/)
    expect(rows[0]).toMatch(/took 1m 47s \[▾\]$/)
    expect(rows[1]).toMatch(/^4 of 4 steps ━+ 100%$/)
    for (const row of rows.slice(2)) expect(row).toMatch(/^✓ .+█{12} {2}Done/)
  })






})

describe('band in the session', () => {
  test('no pane opens unasked; the band draws a round border in the accent colour while working', async ($, on) => {
    const world = worldOf(on)
    await $.turn.start({ text: 'fix the loader', turnId: 'bw1' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Read the code', description: 'x' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Fix the bug', description: 'x' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    await world.clock.settle()
    expect(world.opens).toHaveLength(0)

    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const drawn = (await ui.drawn()) as unknown as { props: { borderStyle?: string; borderColor?: string } }
    expect(drawn.props.borderStyle).toBe('round')
    expect(drawn.props.borderColor).toBe('claude')
    const lines = linesOf(drawn).join('')
    expect(lines).toMatch(/fix the loader/)
    expect(lines).toMatch(/Step 1 of 2/)
    const row = await ui.find({ key: 'step-0' })
    expect(linesOf({ type: 'Box', children: row?.children })).toContain('Working')
  })

  test('the collapse mark shrinks it to the title row and is kept in state', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'fix', turnId: 'bw2' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'One', description: 'x' })
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect(await ui.find({ key: 'summary' })).toBeDefined()
    await ui.press({ key: 'collapse' })
    expect(await ui.find({ key: 'summary' })).toBeUndefined()
    expect(await ui.find({ key: 'title' })).toBeDefined()

    // Kept in state: a fresh drawing of the band is still collapsed
    await ui.unmount()
    const remounted = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect(await remounted.find({ key: 'summary' })).toBeUndefined()
    expect(await remounted.find({ key: 'collapse', text: '[▸]' })).toBeDefined()
    await remounted.press({ key: 'collapse' })
    expect(await remounted.find({ key: 'summary' })).toBeDefined()
  })

  test('turn.complete recolours it green and it stays until the next prompt', async ($, on) => {
    const world = worldOf(on, { claimsDone: true })
    await $.turn.start({ text: 'fix x', turnId: 'bw3' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await world.clock.advance(107_000)
    await $.turn.complete({ turnId: 'bw3', answer: 'Done, tests pass.', durationMs: 107_000, isAborted: false, reason: 'answer' })

    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const drawn = (await ui.drawn()) as unknown as { props: { borderColor?: string } }
    expect(drawn.props.borderColor).toBe('success')
    expect(linesOf(drawn).join('')).toMatch(/✓ All done/)
    expect(linesOf(drawn).join('')).toMatch(/receipt · bun test · exit 0/)
    expect(linesOf(drawn).join('')).toMatch(/took 1m 47s/)

    await ui.unmount()
    await $.turn.start({ text: 'next thing', turnId: 'bw4' })
    const again = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const next = (await again.drawn()) as unknown as { props: { borderColor?: string } }
    expect(next.props.borderColor).toBe('claude')
    expect(linesOf(next).join('')).toMatch(/next thing/)
  })

  test('an UNVERIFIED turn draws the warning badge', async ($, on) => {
    worldOf(on, { claimsDone: true })
    await $.turn.start({ text: 'fix y', turnId: 'bw5' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/y.ts', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ turnId: 'bw5', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawn = (await ui.drawn()) as unknown as { props: { borderColor?: string } }
    expect(drawn.props.borderColor).toBe('warning')
    expect(linesOf(drawn).join('')).toMatch(/⚠ Done, unverified/)
    expect(linesOf(drawn).join('')).toMatch(/src\/y\.ts/)
  })

  test('idle with nothing to show, and while a survey holds it, the band is Claude Code\'s', async ($, on) => {
    worldOf(on)
    const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(linesOf(await idle.drawn())).toEqual(['drawn by Claude Code'])
    await idle.unmount()
    await $.turn.start({ text: 'fix', turnId: 'bw6' })
    const survey = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
    expect(linesOf(await survey.drawn())).toEqual(['drawn by Claude Code'])
  })
})
