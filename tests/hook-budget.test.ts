import { describe, expect, test } from 'claude-code/testing'

import { BAND, PANE, STEP_ANSWERS, step, toolRowOf, worldOf, type World } from './fixtures'

/**
 * Mock-clock milliseconds a dispatch took: starts it unawaited, then moves the
 * clock in 50 ms ticks until it settles. A hook that awaited a 1.5 s model
 * call twice in a row, or at all on a path that must not, shows up here.
 */
async function clockMsOf(world: World, start: () => Promise<unknown>): Promise<number> {
  const begin = world.clock.now()
  let isDone = false
  let failure: unknown = null
  const running = start().then(
    () => {
      isDone = true
    },
    error => {
      isDone = true
      failure = error
    },
  )
  await world.clock.settle()
  while (!isDone && world.clock.now() - begin < 10_000) {
    await world.clock.advance(50)
  }
  await running
  if (failure) throw failure
  return world.clock.now() - begin
}

describe('hook budget', () => {
  test('every hook returns under 2s with model calls stubbed to 1.5s', async ($, on) => {
    const world = worldOf(on, { modelMs: 1_500 })
    const timings: Record<string, number> = {}
    const time = async (name: string, start: () => Promise<unknown>) => {
      timings[name] = await clockMsOf(world, start)
    }

    await time('session.start', () => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' }))
    await time('turn.start', () => $.turn.start({ text: 'fix the parser', turnId: 'b1' }))
    STEP_ANSWERS.set('b1:0', 'Looking at the parser.')
    await time('turn.step 0', () => step($ as never, 'b1', 0))
    STEP_ANSWERS.set('b1:1', 'Read the code; it drops the last line.')
    await time('turn.step 1', () => step($ as never, 'b1', 1))
    await time('tool.call Edit', () => $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' }))
    await time('tool.call Bash', () => $.tool.call({ tool: 'Bash', command: 'bun test' }))
    await time('tool.call TaskCreate', () => $.tool.call({ tool: 'TaskCreate', subject: 's', description: 'd' }))
    await time('command.run', () => $.command.run({ command: 'receipts', args: 'stats' } as never))
    await time('ui.render Pane', () => $.ui.mount({ ...PANE, surface: 'terminal' }))
    await time('ui.render AbovePrompt', () => $.ui.mount({ ...BAND, surface: 'terminal' }))
    await time('ui.render ToolUse', () => $.ui.mount({ ...toolRowOf(world.toolIds[0]!, 'Edit', { file_path: '/work/src/x.ts' }), surface: 'terminal' }))
    await time('turn.complete', () => $.turn.complete({ turnId: 'b1', answer: 'Done.', durationMs: 1000, isAborted: false, reason: 'answer' }))

    for (const [name, ms] of Object.entries(timings)) {
      expect(ms, `${name} took ${ms} ms of clock time`).toBeLessThan(2_000)
    }
    // Stricter than the 2s cap: only turn.complete may wait on a model call
    // (the claims-done label, deadline 1.5s); every other hook starts its
    // model calls and returns without waiting on them.
    for (const [name, ms] of Object.entries(timings)) {
      if (name !== 'turn.complete') expect(ms, `${name} waited on a model call`).toBeLessThanOrEqual(50)
    }
    expect(timings['turn.complete']!).toBeLessThanOrEqual(1_550)
    // The model calls were made, just not on the hot path
    expect(world.completes.length).toBeGreaterThan(0)
    expect(world.classifies.length).toBeGreaterThan(0)
  })
})
