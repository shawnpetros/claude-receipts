import { describe, expect, test } from 'claude-code/testing'

import { addTask, emptyHistory, HISTORY_KEY } from '../src/history'
import { repoHashOf, type Shape } from '../src/shape'
import { STEP_ANSWERS, step, worldOf } from './fixtures'

/**
 * The plan-time shape the fixtures produce: classify says debug, the plan has
 * three steps, the repo is /work and it has a tests directory.
 */
const WORLD_SHAPE: Shape = { taskType: 'debug', steps: '2-3', repo: repoHashOf('/work'), hasTests: true, mix: 'edit' }

function storedHistory(count: number) {
  let history = emptyHistory()
  for (let i = 0; i < count; i += 1) {
    history = addTask(history, { at: i, shape: WORLD_SHAPE, steps: [60_000, 60_000, 60_000], totalMs: 180_000 })
  }
  return { [HISTORY_KEY]: history }
}

async function runTask($: never, world: ReturnType<typeof worldOf>, turnId: string, steps: number) {
  const engine = $ as unknown as { turn: { start: (e: unknown) => Promise<unknown>; complete: (e: unknown) => Promise<unknown> } }
  STEP_ANSWERS.set(`${turnId}:0`, 'Looking at it.')
  await engine.turn.start({ text: 'the parser drops the last line', turnId })
  for (let i = 0; i < steps; i += 1) {
    await step($, turnId, i)
    await world.clock.settle()
  }
  await engine.turn.complete({ turnId, answer: 'Here is what I found.', durationMs: 1000, isAborted: false, reason: 'answer' })
  await world.clock.settle()
}

describe('spike', () => {
  test('an unfamiliar shape with a 3-step plan spawns one subagent, once per shape per session', async ($, on) => {
    const world = worldOf(on)
    await runTask($ as never, world, 's1', 3)
    expect(world.spawns).toHaveLength(1)
    expect(world.spawns[0]).toMatch(/Read the code/)
    // The same shape again in this session: its guess is already in hand.
    // Scar: a cheap subagent per prompt in an unfamiliar repo (0.2.0 live run)
    await runTask($ as never, world, 's2', 2)
    expect(world.spawns).toHaveLength(1)
  })

  for (const taskType of ['research', 'writing', 'chat']) {
    test(`${taskType} tasks never spike: their steps are cheap`, async ($, on) => {
      const world = worldOf(on, { taskType })
      await runTask($ as never, world, `s-${taskType}`, 3)
      expect(world.spawns).toHaveLength(0)
    })
  }

  test('a 2-step plan does not spike', async ($, on) => {
    const world = worldOf(on, { plan: ['Look', 'Answer'] })
    await runTask($ as never, world, 's3', 3)
    expect(world.spawns).toHaveLength(0)
  })

  test('3 or more samples in the bucket: no spike', async ($, on) => {
    const world = worldOf(on, { store: storedHistory(3) })
    await runTask($ as never, world, 's4', 3)
    expect(world.spawns).toHaveLength(0)
  })

  test('2 samples in the bucket still spike', async ($, on) => {
    const world = worldOf(on, { store: storedHistory(2) })
    await runTask($ as never, world, 's5', 3)
    expect(world.spawns).toHaveLength(1)
  })

  test('spike off in config never spawns', { options: { spike: false } }, async ($, on) => {
    const world = worldOf(on)
    await runTask($ as never, world, 's6', 3)
    await runTask($ as never, world, 's7', 3)
    expect(world.spawns).toHaveLength(0)
  })
})
