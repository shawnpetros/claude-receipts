import { describe, expect, test } from 'claude-code/testing'

import { HISTORY_KEY, type History } from '../src/history'
import type { Host } from '../src/host'
import { ReceiptsSession } from '../src/session'

/**
 * A host with a hand-moved clock and timers, for what the test kit cannot
 * drive: it drops `agentId` from an `agent.spawn` a stub answers ("set by
 * core"), so the spike's answer is exercised here, one layer down.
 */
function fakeHostOf(options: { plan?: string } = {}) {
  let now = 1_000_000
  const timers: { at: number; fn: () => void; isCancelled: boolean }[] = []
  const store = new Map<string, unknown>()
  const spawned: string[] = []
  const spawnArgs: { subagentType?: string; model?: string; description?: string }[] = []
  const host: Host = {
    now: async () => now,
    every: () => ({ cancel() {} }),
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, isCancelled: false }
      timers.push(timer)
      return {
        cancel() {
          timer.isCancelled = true
        },
      }
    },
    storeGet: async key => store.get(key),
    storeSet: async (key, value) => {
      store.set(key, JSON.parse(JSON.stringify(value)))
    },
    storeDelete: async key => {
      store.delete(key)
    },
    redraw: () => undefined,
    classify: async (_, labels) => (labels.includes('build') ? 'debug' : labels.includes('claims-done') ? 'claims-done' : 'step-not-done'),
    complete: async () =>
      ({ isAnswered: true, text: options.plan ?? '1. Read the code\n2. Fix the bug\n3. Run the tests', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as never,
    spawn: async args => {
      spawned.push(args.prompt)
      spawnArgs.push({ ...(args.subagentType ? { subagentType: args.subagentType } : {}), ...(args.model ? { model: args.model } : {}), ...(args.description ? { description: args.description } : {}) })
      return { model: 'haiku', agentId: `spike-${spawned.length}` }
    },
    cwd: async () => '/work',
    repo: async () => null,
    list: async () => [],
    agents: async () => [],
    usage: async () => ({ rateLimits: [] }),
    run: async () => ({ exitCode: 0, stdout: '' }),
  }
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers) {
      if (!timer.isCancelled && timer.at <= now) {
        timer.isCancelled = true
        timer.fn()
      }
    }
    await settle()
  }
  return { host, store, spawned, spawnArgs, settle, advance, now: () => now }
}

/**
 * Three steps as Claude records them: TaskCreate x3, the first in progress.
 * 0.3.0: plans are never derived, so the spike and learning tests build
 * theirs the way Claude does.
 */
async function threeSteps(session: ReceiptsSession, host: Host) {
  for (const [i, subject] of ['Read the code', 'Fix the bug', 'Run the tests'].entries()) {
    await session.afterTool(host, { tool: 'TaskCreate', tool_use_id: `c${i}` }, { subject }, { result: { task: { id: String(i + 1) } } } as never)
  }
  await session.afterTool(host, { tool: 'TaskUpdate', tool_use_id: 'u0' }, { taskId: '1', status: 'in_progress' }, { result: {} } as never)
}

async function complete(session: ReceiptsSession, host: Host, taskId: string) {
  await session.afterTool(host, { tool: 'TaskUpdate', tool_use_id: `done-${taskId}` }, { taskId, status: 'completed' }, { result: {} } as never)
}

describe('session', () => {
  test('the spike answer becomes the basis, named "spike guess"', async () => {
    const fake = fakeHostOf()
    const session = new ReceiptsSession({ spike: true })
    await session.turnStart(fake.host, 't1', 'the parser drops the last line')
    await threeSteps(session, fake.host)
    await fake.settle()
    expect(fake.spawned).toHaveLength(1)
    expect(session.viewModel(fake.now()).estimate).toMatchObject({ basis: 'prior only' })

    session.subagentComplete(fake.host, 'spike-1', 'Here you go: {"minutes": [1, 2, 3], "confidence": 3}')
    const est = session.viewModel(fake.now()).estimate
    expect(est).toMatchObject({ kind: 'range', basis: 'spike guess', samples: 0.5 })
  })

  test('a spike answer after its 60s cap, or for another plan length, is ignored', async () => {
    const fake = fakeHostOf()
    const session = new ReceiptsSession({ spike: true })
    await session.turnStart(fake.host, 't2', 'the parser drops the last line')
    await threeSteps(session, fake.host)
    await fake.settle()
    session.subagentComplete(fake.host, 'spike-1', '{"minutes": [1, 2], "confidence": 3}')
    expect(session.viewModel(fake.now()).estimate).toMatchObject({ basis: 'prior only' })

    const late = fakeHostOf()
    const other = new ReceiptsSession({ spike: true })
    await other.turnStart(late.host, 't3', 'the parser drops the last line')
    await threeSteps(other, late.host)
    await late.settle()
    await late.advance(61_000)
    other.subagentComplete(late.host, 'spike-1', '{"minutes": [1, 2, 3], "confidence": 3}')
    expect(other.viewModel(late.now()).estimate).toMatchObject({ basis: 'prior only' })
  })

  test('a 30s permission prompt inside a step is not learned as work: it teaches a 2s step', async () => {
    const fake = fakeHostOf()
    const session = new ReceiptsSession({ spike: false })
    await session.turnStart(fake.host, 'pw', 'run the suite')
    const ok = { result: { task: { id: '1' } } }
    session.beforeTool({ tool: 'TaskCreate', tool_use_id: 'c1' }, { subject: 'Run the suite' })
    await session.afterTool(fake.host, { tool: 'TaskCreate', tool_use_id: 'c1' }, { subject: 'Run the suite' }, ok as never)
    await session.afterTool(fake.host, { tool: 'TaskUpdate', tool_use_id: 'u1' }, { taskId: '1', status: 'in_progress' }, { result: {} } as never)
    // The Bash call waits 30s on the person, then runs for 2s
    session.toolStarted('b1', fake.now())
    await fake.advance(32_000)
    session.beforeTool({ tool: 'Bash', tool_use_id: 'b1' }, { command: 'make release' })
    await session.afterTool(fake.host, { tool: 'Bash', tool_use_id: 'b1' }, { command: 'make release' }, { result: { stdout: '', stderr: '' } } as never)
    session.toolRan('b1', 2_000)
    await session.afterTool(fake.host, { tool: 'TaskUpdate', tool_use_id: 'u2' }, { taskId: '1', status: 'completed' }, { result: {} } as never)
    await session.turnComplete(fake.host, { turnId: 'pw', answer: 'ok', isAborted: false, reason: 'answer' })
    const history = fake.store.get(HISTORY_KEY) as History
    expect(history.tasks[0]!.steps).toEqual([2_000])
    expect(history.tasks[0]!.totalMs).toBe(2_000)
  })

  test('the tick restarts from a render when nothing has polled for a while', async () => {
    const fake = fakeHostOf()
    let starts = 0
    const host = { ...fake.host, every: () => ((starts += 1), { cancel() {} }) }
    const session = new ReceiptsSession({ spike: false })
    await session.turnStart(host, 'tk', 'x')
    expect(starts).toBe(1)
    session.ensureTicking(host, fake.now() + 500)
    expect(starts).toBe(1)
    session.ensureTicking(host, fake.now() + 5_000)
    expect(starts).toBe(2)
  })

  test('cross-check: a confirmed verdict lands on the card; a refuted one prevents All done; silence is unclear', async () => {
    for (const [answer, expected] of [
      ['{"verdict":"confirmed","reason":"reran green","reran":true,"exit":0}', 'confirmed'],
      ['{"verdict":"refuted","reason":"tests cover only the happy path","reran":false,"exit":null}', 'refuted'],
    ] as const) {
      const fake = fakeHostOf()
      const session = new ReceiptsSession({ spike: false, crossCheck: true, crossCheckModel: 'opus' })
      await session.turnStart(fake.host, 'cc', 'fix the loader')
      await session.afterTool(fake.host, { tool: 'Edit', tool_use_id: 'e1' }, { file_path: '/work/src/x.ts' }, { result: {} } as never)
      await session.afterTool(fake.host, { tool: 'Bash', tool_use_id: 'b1' }, { command: 'bun test' }, { result: { stdout: ' 3 pass\n 0 fail\n', stderr: '' } } as never)
      await session.turnComplete(fake.host, { turnId: 'cc', answer: 'Done, tests pass.', isAborted: false, reason: 'answer' })
      await fake.settle()
      expect(fake.spawned).toHaveLength(1)
      expect(fake.spawnArgs[0]).toEqual({ subagentType: 'Explore', model: 'opus', description: 'receipts: cross-check' })
      session.subagentComplete(fake.host, 'spike-1', answer)
      const card = session.viewModel(fake.now()).finished
      expect(card?.crossCheck).toMatchObject({ state: expected })
    }

    const quiet = fakeHostOf()
    const session = new ReceiptsSession({ spike: false, crossCheck: true, crossCheckModel: 'opus' })
    await session.turnStart(quiet.host, 'cq', 'fix the loader')
    await session.afterTool(quiet.host, { tool: 'Edit', tool_use_id: 'e1' }, { file_path: '/work/src/x.ts' }, { result: {} } as never)
    await session.turnComplete(quiet.host, { turnId: 'cq', answer: 'Done.', isAborted: false, reason: 'answer' })
    await quiet.settle()
    await quiet.advance(91_000)
    expect(session.viewModel(quiet.now()).finished?.crossCheck).toMatchObject({ state: 'unclear' })
  })

  test('a finished task is learned, with its calibration verdict, and the store holds it', async () => {
    const fake = fakeHostOf()
    const session = new ReceiptsSession({ spike: false })
    await session.turnStart(fake.host, 't4', 'the parser drops the last line')
    await threeSteps(session, fake.host)
    await fake.settle()
    // A range was shown while three steps were left
    expect(session.viewModel(fake.now()).estimate?.kind).toBe('range')
    // The three steps finish 80s apart, as Claude marks them
    for (const id of ['1', '2', '3']) {
      await fake.advance(80_000)
      await complete(session, fake.host, id)
      if (id !== '3') await session.afterTool(fake.host, { tool: 'TaskUpdate', tool_use_id: `start-${id}` }, { taskId: String(Number(id) + 1), status: 'in_progress' }, { result: {} } as never)
    }
    const line = await session.turnComplete(fake.host, { turnId: 't4', answer: 'Here is the cause.', isAborted: false, reason: 'answer' })
    expect(line).toBeNull()

    const stored = fake.store.get(HISTORY_KEY) as History
    expect(stored.tasks).toHaveLength(1)
    expect(stored.tasks[0]).toMatchObject({ totalMs: 4 * 60_000, inside: true, shape: { taskType: 'debug', steps: '2-3' } })
    expect(session.statsText()).toMatch(/calibration: 100% of 1 task ended inside the range/)
  })

  test('an aborted turn teaches nothing', async () => {
    const fake = fakeHostOf()
    const session = new ReceiptsSession({ spike: false })
    await session.turnStart(fake.host, 't5', 'x')
    await fake.advance(30_000)
    await session.turnComplete(fake.host, { turnId: 't5', answer: '', isAborted: true, reason: 'aborted' })
    expect(fake.store.get(HISTORY_KEY)).toBeUndefined()
  })
})
