import { describe, expect, test } from 'claude-code/testing'

import { HISTORY_KEY, type History } from '../src/history'
import { BAND_WIDE, linesOf, PANE, step, STEP_ANSWERS, worldOf } from './fixtures'

const STEPS = ['Locate the plugin', 'Compare installed copy', 'Check version numbers', 'Report whether it is current', 'Outline scope']
const RECAP = 'The cache matches HEAD at c362279, and the manifest version is 0.1.0, so the installed plugin is current.'

async function band($: { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }): Promise<string> {
  const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' } as never)
  const text = linesOf(await ui.drawn()).join('')
  await ui.unmount()
  return text
}

describe('derived steps at turn end', () => {
  test('one pass over the final answer marks the steps it completes', async ($, on) => {
    const world = worldOf(on, { plan: STEPS, stepsDone: '3, 4' })
    STEP_ANSWERS.set('d1:0', 'Checking how this session loaded it.')
    await $.turn.start({ text: 'is the newest version installed?', turnId: 'd1' })
    await step($ as never, 'd1', 0)
    await world.clock.settle()
    await $.turn.complete({ turnId: 'd1', answer: RECAP, durationMs: 41_000, isAborted: false, reason: 'answer' })

    const asked = world.completes.filter(prompt => prompt.includes('Steps not yet marked done'))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/2\. Compare installed copy/)
    expect(asked[0]).toMatch(/c362279/)
    const text = await band($ as never)
    expect(text).toMatch(/Turn ended · 3 of 5 steps reached/)
    expect(text).toMatch(/Check version numbers.*Done/)
    expect(text).toMatch(/Report whether it is current.*Done/)
  })

  test('every step covered: the green card', async ($, on) => {
    const world = worldOf(on, { plan: STEPS, stepsDone: '2, 3, 4, 5' })
    STEP_ANSWERS.set('d2:0', 'Looking.')
    await $.turn.start({ text: 'x', turnId: 'd2' })
    await step($ as never, 'd2', 0)
    await world.clock.settle()
    await $.turn.complete({ turnId: 'd2', answer: RECAP, durationMs: 1, isAborted: false, reason: 'answer' })
    expect(await band($ as never)).toMatch(/✓ All done/)
  })

  test('a slow answer misses the deadline and the card says how far it got', async ($, on) => {
    const world = worldOf(on, { plan: STEPS, stepsDone: '2, 3, 4, 5', modelMs: 5_000 })
    STEP_ANSWERS.set('d3:0', 'Looking.')
    await $.turn.start({ text: 'x', turnId: 'd3' })
    await step($ as never, 'd3', 0)
    await world.clock.advance(6_000)
    const done = $.turn.complete({ turnId: 'd3', answer: RECAP, durationMs: 1, isAborted: false, reason: 'answer' })
    await world.clock.advance(1_600)
    await done
    expect(await band($ as never)).toMatch(/Turn ended · 1 of 5 steps reached/)
  })
})

describe('cost on the receipt line', () => {
  async function receiptOf($: never, world: ReturnType<typeof worldOf>, turnId: string, before: () => void, after: () => void): Promise<string> {
    const engine = $ as unknown as { turn: { start: (e: unknown) => Promise<unknown>; complete: (e: unknown) => Promise<{ text: string }> }; tool: { call: (e: unknown) => Promise<unknown> } }
    before()
    await engine.turn.start({ text: 'fix x', turnId })
    await engine.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await engine.tool.call({ tool: 'Bash', command: 'bun test' })
    after()
    await world.clock.advance(5_000)
    return (await engine.turn.complete({ turnId, answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })).text
  }

  test('plan user: the five-hour window used and when it resets', async ($, on) => {
    const world = worldOf(on, { claimsDone: true })
    const resets = new Date(2026, 9, 7, 18, 30).toISOString()
    const text = await receiptOf($ as never, world, 'c1', () => undefined, () => {
      world.usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 6, resetsAt: resets }], cost: { usd: 0 } }
    })
    expect(text).toMatch(/^receipt · bun test ✓ · 5s ago · 5h window 6% used, resets 18:30$/)
  })

  test('API key: dollars this turn', async ($, on) => {
    const world = worldOf(on, { claimsDone: true })
    const text = await receiptOf($ as never, world, 'c2', () => {
      world.usage = { rateLimits: [], cost: { usd: 1.0 } }
    }, () => {
      world.usage = { rateLimits: [], cost: { usd: 1.42 } }
    })
    expect(text).toMatch(/ · \$0\.42 this turn$/)
  })

  test('unknown: nothing rather than a guess', async ($, on) => {
    const world = worldOf(on, { claimsDone: true })
    const text = await receiptOf($ as never, world, 'c3', () => undefined, () => undefined)
    expect(text).toMatch(/^receipt · bun test ✓ · 5s ago$/)
  })
})

describe('the claims-done false-positive counter', () => {
  test('/receipts wrong marks the last receipt once; stats report the rate', async ($, on) => {
    const world = worldOf(on, { claimsDone: true })
    const run = (args: string) => $.command.run({ command: 'receipts', args } as never) as Promise<{ text?: string }>
    expect((await run('wrong')).text).toMatch(/no receipt/)
    await $.turn.start({ text: 'fix x', turnId: 'w1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ turnId: 'w1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
    expect((await run('wrong')).text).toMatch(/marked wrong/)
    expect((await run('wrong')).text).toMatch(/already/)
    expect((await run('stats')).text).toMatch(/1 of 1 receipt marked wrong \(100%\)/)
    expect(JSON.stringify(world.saved.get('audit'))).toMatch(/"wrong":1/)
  })
})

describe('surfaces', () => {
  test('a docked pane draws no more rows than it has', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'x', turnId: 'p1' })
    for (let i = 0; i < 8; i += 1) await $.tool.call({ tool: 'TaskCreate', subject: `step ${i}`, description: 'x' })
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 5 } }, surface: 'terminal' })
    expect(linesOf(await ui.drawn()).length).toBeLessThanOrEqual(5)
  })
})

describe('learning', () => {
  test('history keeps the store record valid after the new fields', async ($, on) => {
    const world = worldOf(on)
    await $.turn.start({ text: 'x', turnId: 'l1' })
    await $.turn.complete({ turnId: 'l1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
    expect((world.saved.get(HISTORY_KEY) as History).tasks).toHaveLength(1)
  })
})
