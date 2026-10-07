import { describe, expect, test } from 'claude-code/testing'

import { bandView, rowText } from '../src/band'
import type { Milestone, Plan } from '../src/milestones'
import type { ViewModel } from '../src/view'
import { BAND_WIDE, linesOf, step, STEP_ANSWERS, worldOf } from './fixtures'

const STEPS = ['Locate the plugin', 'Compare installed copy', 'Check versions', 'Report status', 'Outline scope']

function planOf(done: number): Plan {
  return {
    source: 'derived',
    items: STEPS.map((label, i): Milestone => ({ id: String(i), label, state: i < done ? 'done' : 'pending' })),
  }
}

function endedOf(done: number, waitingAgents = 0): ViewModel {
  return {
    plan: planOf(done),
    estimate: null,
    isWorking: false,
    showBasis: false,
    calibration: ['calibration: no finished tasks yet'],
    title: 'is the newest version of the plugin installed?',
    elapsedMs: 41_000,
    finished: { totalMs: 41_000, receipt: null, isAborted: false, waitingAgents },
  }
}

const OPEN = { collapsed: false, showBasis: false }

async function bandText(ui: { drawn: () => Promise<unknown> }): Promise<{ text: string; border?: string }> {
  const drawn = (await ui.drawn()) as { props: { borderColor?: string } }
  return { text: linesOf(drawn).join(''), border: drawn.props.borderColor }
}

describe('turn end (pure)', () => {
  test('steps left at turn end: a neutral card, never "All done", unreached steps say so', () => {
    const view = bandView(endedOf(2), 155, OPEN)
    const rows = view.rows.map(rowText)
    expect(view.tone).toBe('ended')
    expect(view.border).toBe('inactive')
    expect(rows[0]).toMatch(/^ ■ Turn ended · 2 of 5 steps reached  is the newest version/)
    expect(rows.join('\n')).not.toMatch(/All done|Working/)
    expect(rows[2]).toMatch(/^✓ Locate the plugin .*Done/)
    for (const row of rows.slice(4)) expect(row).toMatch(/^○ .*Not reached/)
  })

  test('every step done: still the green card', () => {
    const view = bandView(endedOf(5), 155, OPEN)
    expect(view.tone).toBe('done')
    expect(rowText(view.rows[0]!)).toMatch(/^ ✓ All done /)
  })

  test('agents still running: the title says what it waits on', () => {
    expect(rowText(bandView(endedOf(5, 2), 155, OPEN).rows[0]!)).toMatch(/waiting on 2 agents {2}.*took 41s/)
    expect(rowText(bandView(endedOf(5, 1), 155, OPEN).rows[0]!)).toMatch(/waiting on 1 agent {2}/)
  })
})

describe('turn end in the session', () => {
  test('regression: a derived plan with steps pending leaves Working on turn.complete', async ($, on) => {
    const world = worldOf(on, { plan: STEPS })
    STEP_ANSWERS.set('te1:0', 'Checking how this session loaded it.')
    await $.turn.start({ text: 'is the newest version installed?', turnId: 'te1' })
    await step($ as never, 'te1', 0)
    await world.clock.settle()
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect((await bandText(ui)).border).toBe('claude')

    await world.clock.advance(41_000)
    await $.turn.complete({ turnId: 'te1', answer: 'Yes, the newest version is installed.', durationMs: 41_000, isAborted: false, reason: 'answer' })
    const after = await bandText(ui)
    expect(after.border).toBe('inactive')
    expect(after.text).toMatch(/Turn ended · 1 of 5 steps reached/)
    expect(after.text).not.toMatch(/Working|All done/)
    expect(after.text).toMatch(/Not reached/)
  })

  test('a turn.complete whose id the band did not see still ends the task', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'first', turnId: 'te2' })
    await $.turn.complete({ turnId: 'someone-else', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect((await bandText(ui)).border).not.toBe('claude')
  })

  test('agents still running at turn end: "waiting on 2 agents", flipping as each finishes', async ($, on) => {
    const world = worldOf(on)
    await $.turn.start({ text: 'research mods', turnId: 'te3' })
    world.agents.push({ id: 'a1', status: 'running' }, { id: 'a2', status: 'running' }, { id: 'mine', status: 'running', spawnedBy: 'receipts' }, { id: 'old', status: 'completed' })
    await $.turn.complete({ turnId: 'te3', answer: 'Research is running.', durationMs: 1, isAborted: false, reason: 'answer' })
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect((await bandText(ui)).text).toMatch(/waiting on 2 agents/)

    world.agents[0]!.status = 'completed'
    await $.turn.complete({ turnId: 'a1-run', agentId: 'a1', answer: 'report', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect((await bandText(ui)).text).toMatch(/waiting on 1 agent(?!s)/)

    world.agents[1]!.status = 'completed'
    await $.turn.complete({ turnId: 'a2-run', agentId: 'a2', answer: 'report', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect((await bandText(ui)).text).not.toMatch(/waiting/)
  })

  test('the next prompt clears the wait, whatever the agents did', async ($, on) => {
    const world = worldOf(on)
    await $.turn.start({ text: 'one', turnId: 'te4' })
    world.agents.push({ id: 'a1', status: 'running' })
    await $.turn.complete({ turnId: 'te4', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
    const ended = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect((await bandText(ended)).text).toMatch(/waiting on 1 agent/)
    await ended.unmount()
    await $.turn.start({ text: 'two', turnId: 'te5' })
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect((await bandText(ui)).text).not.toMatch(/waiting/)
  })
})
