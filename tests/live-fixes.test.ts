import { describe, expect, test } from 'claude-code/testing'

import { HISTORY_KEY, type History } from '../src/history'
import { BAND_WIDE, linesOf, PANE, step, STEP_ANSWERS, worldOf } from './fixtures'


async function band($: { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }): Promise<string> {
  const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' } as never)
  const text = linesOf(await ui.drawn()).join('')
  await ui.unmount()
  return text
}

// 0.3.0: "derived steps at turn end" (3 tests) was deleted with the
// end-of-turn judgement pass over derived plans (SPEC-0.3 invariant 10).

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
    expect(text).toMatch(/^receipt · bun test · exit 0 · 5s ago · 5h window 6% used, resets 18:30$/)
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
    expect(text).toMatch(/^receipt · bun test · exit 0 · 5s ago$/)
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
    expect((await run('stats')).text).toMatch(/claims-done false positives: 1 of 1 receipt \(100%\)/)
    expect(JSON.stringify(world.saved.get('audit'))).toMatch(/"wrong":1/)
  })

  test('/receipts wrong is about the current turn: a later turn with no receipt has nothing to mark', async ($, on) => {
    worldOf(on, { claimsDone: true })
    const run = (args: string) => $.command.run({ command: 'receipts', args } as never) as Promise<{ text?: string }>
    await $.turn.start({ text: 'fix x', turnId: 'w2' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ turnId: 'w2', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
    await $.turn.start({ text: 'what does x do?', turnId: 'w3' })
    await $.turn.complete({ turnId: 'w3', answer: 'It parses.', durationMs: 1, isAborted: false, reason: 'answer' })
    expect((await run('wrong')).text).toMatch(/no receipt/)
    expect((await run('stats')).text).toMatch(/claims-done false positives: 0 of 1 receipt \(0%\)/)
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
