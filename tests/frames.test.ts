import { describe, expect, test } from 'claude-code/testing'

import { bandView, dividerRow, rowText, toolsView, type ToolsModel } from '../src/band'
import type { RangeEstimate } from '../src/estimator'
import type { Milestone, Plan } from '../src/milestones'
import { switchesOf, type Switch } from '../src/switches'
import type { ViewModel } from '../src/view'
import { BAND, BAND_WIDE, linesOf, worldOf } from './fixtures'

/**
 * The band and the tools panel as the reference video draws them (Clean View
 * segment, frames 18, 20, 22, 26 for the band; 10, 13, 14 for the footer
 * button and the panel).
 */

const ASK = 'Build a weather dashboard for New York City.'
const STEPS = ['Pick the page style and layout', 'Check how the page gets live weather', 'Build the weather dashboard', 'Publish it and share the link']
const OPEN = { collapsed: false, showBasis: false }

function planOf(current: number, done = current): Plan {
  return {
    source: 'tasks',
    items: STEPS.map((label, i): Milestone => ({ id: String(i), label, state: i < done ? 'done' : i === current ? 'current' : 'pending' })),
  }
}

function range(progress: number, stepProgress: number[]): RangeEstimate {
  return {
    kind: 'range',
    basis: 'prior only',
    remainingLowMs: 60_000,
    remainingHighMs: 240_000,
    totalLowMs: 70_000,
    totalHighMs: 250_000,
    sigmaMs: 60_000,
    confidence: 0,
    isOver: false,
    overByMs: 0,
    progress,
    samples: 0,
    stepProgress,
  }
}

function working(elapsedMs: number, progress: number, stepProgress: number[]): ViewModel {
  return {
    plan: planOf(1),
    estimate: range(progress, stepProgress),
    isWorking: true,
    showBasis: false,
    calibration: ['calibration: no finished tasks yet'],
    title: ASK,
    elapsedMs,
    finished: null,
  }
}

describe('the band, frame by frame', () => {
  test('frame 20: title capped with an ellipsis, elapsed at right, no buttons; step bar, percent at right', () => {
    const rows = bandView(working(7_000, 0.25, [1, 0, 0, 0]), 155, OPEN).rows.map(rowText)
    expect(rows[0]).toMatch(/^✶ Build a weather dashboard for New York… /)
    expect(rows[0]).toMatch(/ 7s$/)
    expect(rows[0]).not.toMatch(/basis|tools|\[▾\]|\[-\]/)
    expect(rows[1]).toMatch(/^Step 2 of 4 █+░+ 25%$/)
    expect(rows[2]).toMatch(/^✓ Pick the page style and layout +█{16} {2}Done/)
    expect(rows[3]).toMatch(/^● Check how the page gets live weather +░{16} {2}Working/)
    expect(rows[4]).toMatch(/^○ Build the weather dashboard +░{16} {2}Next/)
    expect(rows[5]).toMatch(/^○ Publish it and share the link +░{16} {2}Up next/)
  })

  test('frame 22: once the step under way has progress, its word is that percent', () => {
    const rows = bandView(working(11_000, 0.35, [1, 0.4, 0, 0]), 155, OPEN).rows.map(rowText)
    expect(rows[1]).toMatch(/ 35%$/)
    expect(rows[3]).toMatch(/^● Check how the page gets live weather +█{6}░{10} {2}40%/)
  })

  test('the bars sit in one column whatever the label lengths', () => {
    const rows = bandView(working(7_000, 0.25, [1, 0, 0, 0]), 155, OPEN).rows.map(rowText).slice(2)
    const columns = rows.map(row => row.search(/[█░]/))
    expect(new Set(columns).size).toBe(1)
  })

  test('frame 26: the green card: badge, title, took at right; full bars and Done', () => {
    const model: ViewModel = {
      ...working(107_000, 1, [1, 1, 1, 1]),
      plan: planOf(4),
      estimate: null,
      isWorking: false,
      finished: { totalMs: 107_000, receipt: null, isAborted: false, waitingAgents: 0, ledger: 'none', claimsDone: false, hasWork: true, crossCheck: null },
    }
    const view = bandView(model, 155, OPEN)
    const rows = view.rows.map(rowText)
    expect(view.border).toBe('success')
    expect(rows[0]).toMatch(/^ ✓ All done  Build a weather dashboard for New York… +took 1m 47s$/)
    expect(rows[1]).toMatch(/^4 of 4 steps █+ 100%$/)
    for (const row of rows.slice(2)) expect(row).toMatch(/^✓ .+█{16} {2}Done/)
  })

  test('the estimate keeps its place: dim, before the elapsed time, basis named', () => {
    const rows = bandView(working(7_000, 0.25, [1, 0, 0, 0]), 155, OPEN).rows.map(rowText)
    expect(rows[0]).toMatch(/~1 to 4 min · prior only {2}7s$/)
  })
})

describe('the Clean View divider', () => {
  test('frames 10, 18, 26: a rule with "Clean View" at its right end, the band\'s full width', () => {
    const row = dividerRow(95, 'Clean View')
    expect(rowText(row)).toMatch(/^─+ Clean View ─$/)
    expect([...rowText(row)].length).toBe(95)
  })

  test('drawn idle and working while the rows level is not off; gone at off', async ($, on) => {
    worldOf(on)
    const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(linesOf(await idle.drawn()).join('')).toMatch(/─ Clean View ─$/)
    await idle.unmount()
    await $.command.run({ command: 'receipts', args: 'rows off' } as never)
    const off = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(linesOf(await off.drawn())).toEqual(['drawn by Claude Code'])
  })
})

// ---- the tools panel -------------------------------------------------------------

const MODS: Switch[] = [
  { mod: 'receipts', id: 'receipts.line', label: 'Receipt line', description: 'under answers that claim done', value: true },
  { mod: 'buddy', id: 'buddy', label: 'Buddy', description: 'a companion in the corner', value: false },
]

const PANEL: ToolsModel = { model: 'claude-opus-5-5[1m]', effort: 'high', rows: 'quiet', crossCheck: true, spike: false, chatter: true, mods: MODS }

describe('the tools panel', () => {
  test('frame 14: letter-spaced title with the model and effort at right; MODEL and EFFORT chips', () => {
    const rows = toolsView(PANEL, 63).map(rowText)
    expect(rows[0]).toMatch(/^◆ S H A W N ' S {3}T O O L S +Opus 5\.5 · High$/)
    const model = rows.find(row => row.startsWith('MODEL'))!
    expect(model).toMatch(/^MODEL {5}Haiku 4\.5 {2}Sonnet 5 {2} Opus 5\.5 {2}Fable 5\.1/)
    expect(rows.find(row => row.startsWith('EFFORT'))).toMatch(/^EFFORT {4}Low {2}Medium {2} High {2}XHigh {2}Max/)
    for (const row of rows) expect([...row].length).toBe(63)
  })

  test('the current model and effort are highlighted, not pressable; the rest are buttons', () => {
    const segs = toolsView(PANEL, 63).flatMap(row => row.segs)
    expect(segs.find(seg => seg.inverse && seg.text.trim() === 'Opus 5.5')).toBeDefined()
    expect(segs.find(seg => seg.inverse && seg.text.trim() === 'High')).toBeDefined()
    expect(segs.find(seg => seg.button?.key === 'model-opus')).toBeUndefined()
    expect(segs.find(seg => seg.button?.key === 'model-haiku')?.text).toBe('Haiku 4.5')
    expect(segs.find(seg => seg.button?.key === 'effort-max')?.text).toBe('Max')
  })

  test('SETTINGS: a dot, a name, a dim description and a toggle at the right', () => {
    const rows = toolsView(PANEL, 63)
    const text = rows.map(rowText)
    expect(text.some(row => /^─+ S E T T I N G S ─+$/.test(row) || /S E T T I N G S/.test(row))).toBe(true)
    const setting = (name: string) => rows.find(row => rowText(row).includes(name))!
    expect(rowText(setting('Clean View'))).toMatch(/^● Clean View +simple checklist +Quiet$/)
    expect(rowText(setting('Receipts cross-check'))).toMatch(/^● Receipts cross-check .* On$/)
    expect(rowText(setting('Spike'))).toMatch(/^○ Spike .* Off$/)
    expect(rowText(setting('Suppress agent chatter'))).toMatch(/^● Suppress agent chatter .* On$/)
    expect(setting('Clean View').segs.find(seg => seg.button)?.button?.key).toBe('set-rows')
    expect(setting('Receipts cross-check').segs.find(seg => seg.button)?.button?.key).toBe('set-crosscheck')
  })

  test('MODS lists every registered switch; LAUNCH holds the two actions', () => {
    const rows = toolsView(PANEL, 63)
    const text = rows.map(rowText)
    expect(text.some(row => /M O D S/.test(row))).toBe(true)
    expect(text.some(row => /^● Receipt line +under answers that claim done +On$/.test(row))).toBe(true)
    expect(text.some(row => /^○ Buddy +a companion in the corner +Off$/.test(row))).toBe(true)
    expect(text.some(row => /L A U N C H/.test(row))).toBe(true)
    const keys = rows.flatMap(row => row.segs).map(seg => seg.button?.key).filter(Boolean)
    expect(keys).toEqual(expect.arrayContaining(['mod-receipts.line', 'mod-buddy', 'launch-stats', 'launch-wrong']))
  })
})

describe('the switch registry', () => {
  test('each mod publishes its own list; the panel reads them all, receipts first, malformed entries dropped', () => {
    const merged = switchesOf([
      ['buddy', [{ id: 'buddy', label: 'Buddy', description: 'a companion', value: false }, { id: 3 }]],
      ['receipts', [{ id: 'receipts.line', label: 'Receipt line', description: 'under answers', value: true }]],
      ['nobody', undefined],
    ])
    expect(merged.map(entry => `${entry.mod}:${entry.id}`)).toEqual(['receipts:receipts.line', 'buddy:buddy'])
  })

  test('receipts registers its own switch; pressing it turns the line under the answer off', async ($, on) => {
    worldOf(on, { claimsDone: true })
    await $.command.run({ command: 'receipts', args: 'tools' } as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect((await ui.find({ key: 'mod-receipts.line' }))?.props.label).toBe('On')
    await ui.press({ key: 'mod-receipts.line' })
    expect((await ui.find({ key: 'mod-receipts.line' }))?.props.label).toBe('Off')
    await ui.unmount()
    await $.turn.start({ text: 'fix x', turnId: 'm1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    const out = await $.turn.complete({ turnId: 'm1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(out.text).toBe('')
  })
})

describe('the footer button', () => {
  test('frames 10 and 13: "◆ Shawn\'s Tools ▲" beside the modes; pressed, the panel opens and it reads ▼', async ($, on) => {
    worldOf(on)
    const footer = await $.ui.mount({ plugin: 'receipts', component: 'SessionMode', requestId: 'mode', surface: 'terminal', props: { modes: ['focus'] } } as never)
    expect(linesOf(await footer.drawn())).toContain('focus')
    expect((await footer.find({ key: 'tools-footer' }))?.props.label).toBe("◆ Shawn's Tools ▲")
    await footer.press({ key: 'tools-footer' })
    expect((await footer.find({ key: 'tools-footer' }))?.props.label).toBe("◆ Shawn's Tools ▼")
    const band = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect(await band.find({ key: 'tools' })).toBeDefined()
    await footer.press({ key: 'tools-footer' })
    expect(await band.find({ key: 'tools' })).toBeUndefined()
  })
})
