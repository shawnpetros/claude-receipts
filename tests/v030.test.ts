import { describe, expect, test } from 'claude-code/testing'

import { bandView, rowText, type BandView } from '../src/band'
import { crossCheckRowOf, diffForCheck, parseVerdict, PLAN_INSTRUCTION } from '../src/crosscheck'
import {
  emptyLedger,
  isGrepForError,
  ledgerStateOf,
  receiptLine,
  recordEdit,
  recordGrep,
  recordVerify,
  summaryLineOf,
} from '../src/ledger'
import type { Milestone, Plan } from '../src/milestones'
import type { Finished, ViewModel } from '../src/view'
import { BAND, BAND_WIDE, linesOf, worldOf } from './fixtures'

const T = new Date(2026, 9, 14, 14, 2).getTime()

// ---- 1. plan-first -----------------------------------------------------------

async function submit($: unknown, text: string): Promise<readonly string[]> {
  const engine = $ as { prompt: { submit: (e: unknown) => Promise<{ context?: readonly string[] }> } }
  const out = await engine.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  return out.context ?? []
}

async function bandText($: unknown, wide = true): Promise<{ text: string; border?: string }> {
  const engine = $ as { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }
  const ui = await engine.ui.mount({ ...(wide ? BAND_WIDE : BAND), surface: 'terminal' } as never)
  const drawn = (await ui.drawn()) as { props: { borderColor?: string } }
  const text = linesOf(drawn).join('')
  await ui.unmount()
  return { text, border: drawn.props.borderColor }
}

describe('plan-first', () => {
  test('a build prompt carries the plan instruction; a writing prompt does not', async ($, on) => {
    worldOf(on, { taskType: 'build' })
    expect(await submit($, 'add retries to the loader')).toContain(PLAN_INSTRUCTION)
  })

  test('a writing prompt gets no plan instruction', async ($, on) => {
    worldOf(on, { taskType: 'writing' })
    expect(await submit($, 'draft the release note')).not.toContain(PLAN_INSTRUCTION)
  })

  test('the instruction is byte-stable across prompts', () => {
    expect(PLAN_INSTRUCTION).toBe(
      'Before non-trivial work, record your plan with TaskCreate as 2 to 8 short steps, mark each in_progress and completed with TaskUpdate as you go, and keep the list current if the plan changes.',
    )
  })

  test('TaskCreate with 4 steps yields 4 milestones', async ($, on) => {
    worldOf(on, { taskType: 'build' })
    await $.turn.start({ text: 'build it', turnId: 'p1' })
    for (const subject of ['Read', 'Write', 'Test', 'Ship']) await $.tool.call({ tool: 'TaskCreate', subject, description: 'x' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    const { text } = await bandText($)
    expect(text).toMatch(/Step 1 of 4/)
    for (const label of ['Read', 'Write', 'Test', 'Ship']) expect(text).toContain(`${label} `)
    expect(text).not.toMatch(/derived/)
  })

  test('a Read during an answer turn leaves the plan at one step', async ($, on) => {
    const world = worldOf(on, { taskType: 'writing' })
    await $.turn.start({ text: 'what does the README say about install?', turnId: 'p2' })
    await world.clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/README.md' })
    await $.tool.call({ tool: 'Grep', pattern: 'install' })
    const { text } = await bandText($)
    expect(text).toMatch(/Step 1 of 1 · answer/)
    expect(world.completes).toHaveLength(0)
  })

  test('an Edit during a build turn with no task tools: "working", no steps, no percent', async ($, on) => {
    const world = worldOf(on, { taskType: 'build' })
    await $.turn.start({ text: 'fix the loader', turnId: 'p3' })
    await world.clock.settle()
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await world.clock.advance(73_000)
    const { text } = await bandText($)
    expect(text).toMatch(/working · 1m 13s/)
    expect(text).not.toMatch(/Step \d|%|Not reached/)
    expect(world.completes).toHaveLength(0)
  })

  test('the mod never calls a model to make up steps', async ($, on) => {
    const world = worldOf(on, { taskType: 'debug' })
    await $.turn.start({ text: 'why does the parser drop a line', turnId: 'p4' })
    await world.clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/src/parser.ts' })
    await $.turn.complete({ turnId: 'p4', answer: 'Found it.', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(world.completes).toHaveLength(0)
  })
})

// ---- 3. receipts by definition ----------------------------------------------

describe('ledger: summary lines, verbatim', () => {
  const cases: [string, string, string][] = [
    ['bun', 'bun test v1.2\n\n 105 pass\n 0 fail\nRan 105 tests across 15 files. [0.89s]\n', '105 pass, 0 fail'],
    ['jest', 'PASS src/a.test.ts\nTests:       3 passed, 3 total\nTime: 1s\n', 'Tests:       3 passed, 3 total'],
    ['vitest', ' ✓ a.test.ts (3)\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n', 'Tests  3 passed (3)'],
    ['pytest', 'collected 4 items\n\n========= 3 passed, 1 failed in 0.12s =========\n', '========= 3 passed, 1 failed in 0.12s ========='],
    ['cargo', 'running 5 tests\ntest result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured\n', 'test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured'],
    ['cargo build', 'error[E0308]: mismatched types\n  --> src/main.rs:4:5\n', 'error[E0308]: mismatched types'],
    ['go', '--- FAIL: TestParse (0.00s)\nFAIL\tgithub.com/x/parse\t0.012s\n', 'FAIL\tgithub.com/x/parse\t0.012s'],
    ['go ok', 'ok  \tgithub.com/x/parse\t0.012s\n', 'ok  \tgithub.com/x/parse\t0.012s'],
    ['make', 'cc -c a.c\nmake: *** [Makefile:4: check] Error 2\n', 'make: *** [Makefile:4: check] Error 2'],
  ]
  for (const [name, output, line] of cases) {
    test(name, () => expect(summaryLineOf(output)).toBe(line))
  }
  test('nothing recognisable: no summary rather than a guess', () => {
    expect(summaryLineOf('compiled 12 files\n')).toBeUndefined()
  })
})

describe('ledger: what counts as a receipt', () => {
  test('grep for "error" over a log is flagged, never a receipt', () => {
    expect(isGrepForError('grep -i error build.log')).toBe(true)
    expect(isGrepForError('cat out.txt | grep -ci "error"')).toBe(true)
    expect(isGrepForError('bun test')).toBe(false)
    let ledger = recordEdit(emptyLedger(), '/work/src/x.ts', T)
    ledger = recordGrep(ledger, 'grep -i error build.log', T + 1_000)
    expect(ledgerStateOf(ledger)).toBe('unverified')
    expect(receiptLine(ledger, true, T + 60_000, '/work')).toBe(
      'UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since (grep-for-error, not a receipt)',
    )
  })

  test('a passing verify after the last edit: command, exit code, summary verbatim', () => {
    let ledger = recordEdit(emptyLedger(), '/work/src/x.ts', T)
    ledger = recordVerify(ledger, 'bun test', 0, ' 105 pass\n 0 fail\n', T + 1_000)
    expect(ledgerStateOf(ledger)).toBe('verified')
    expect(receiptLine(ledger, true, T + 61_000, '/work')).toBe('receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago')
  })

  test('a verify before the last edit does not count', () => {
    let ledger = recordVerify(emptyLedger(), 'bun test', 0, ' 3 pass\n 0 fail\n', T - 5_000)
    ledger = recordEdit(ledger, '/work/src/x.ts', T)
    expect(ledgerStateOf(ledger)).toBe('unverified')
    expect(receiptLine(ledger, true, T + 1_000, '/work')).toBe('UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since')
  })

  test('a failing verify after the last edit: FAILED', () => {
    let ledger = recordEdit(emptyLedger(), '/work/src/main.rs', T)
    ledger = recordVerify(ledger, 'cargo test', 101, 'test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured\n', T + 1_000)
    expect(ledgerStateOf(ledger)).toBe('failed')
    expect(receiptLine(ledger, true, T + 2_000, '/work')).toBe('FAILED · cargo test · exit 101 · test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured')
  })

  test('no edits: no receipt, whatever ran', () => {
    const ledger = recordVerify(emptyLedger(), 'bun test', 0, ' 1 pass\n', T)
    expect(ledgerStateOf(ledger)).toBe('none')
    expect(receiptLine(ledger, true, T, '/work')).toBeNull()
  })
})

// ---- 4. cross-check ------------------------------------------------------------

describe('cross-check (pure)', () => {
  test('a diff over 400 lines is sent as its stat, said so', () => {
    const small = Array.from({ length: 400 }, (_, i) => `+line ${i}`).join('\n')
    expect(diffForCheck(small, ' 1 file changed')).toBe(small)
    const big = Array.from({ length: 401 }, (_, i) => `+line ${i}`).join('\n')
    const sent = diffForCheck(big, ' src/x.ts | 401 +\n 1 file changed')
    expect(sent).toMatch(/^diff too large to read in full/)
    expect(sent).toContain('src/x.ts | 401 +')
    expect(sent).not.toContain('+line 0')
  })

  test('verdicts parse from the agent\'s JSON, fenced or not; anything else is unclear', () => {
    expect(parseVerdict('```json\n{"verdict":"confirmed","reason":"tests ran green","reran":true,"exit":0}\n```')).toEqual({
      verdict: 'confirmed',
      reason: 'tests ran green',
      reran: true,
      exit: 0,
    })
    expect(parseVerdict('{"verdict":"refuted","reason":"tests cover only the happy path","reran":false,"exit":null}').verdict).toBe('refuted')
    expect(parseVerdict('I think it is fine').verdict).toBe('unclear')
  })

  test('rows for all three verdicts, verbatim reasons', () => {
    expect(crossCheckRowOf({ state: 'confirmed', model: 'opus', reason: 'ok', reran: true, exit: 0, command: 'bun test', ms: 38_000 })).toBe(
      'cross-check · ✓ confirmed (opus, reran bun test exit 0) · 38s',
    )
    expect(crossCheckRowOf({ state: 'refuted', model: 'opus', reason: 'tests cover only the happy path', reran: false, exit: null, ms: 20_000 })).toBe(
      'cross-check · ✗ refuted: tests cover only the happy path',
    )
    expect(crossCheckRowOf({ state: 'unclear', model: 'opus', reason: '', reran: false, exit: null, ms: 90_000 })).toBe('cross-check · ? unclear')
    expect(crossCheckRowOf({ state: 'running', model: 'opus' })).toBe('cross-check · running (opus)…')
  })
})

describe('cross-check in the session', () => {
  async function editAndClaim($: unknown, world: ReturnType<typeof worldOf>, turnId: string, edit = true) {
    const engine = $ as {
      turn: { start: (e: unknown) => Promise<unknown>; complete: (e: unknown) => Promise<unknown> }
      tool: { call: (e: unknown) => Promise<unknown> }
    }
    await engine.turn.start({ text: 'fix the loader', turnId })
    await world.clock.settle()
    if (edit) await engine.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await engine.tool.call({ tool: 'Bash', command: 'bun test' })
    await engine.turn.complete({ turnId, answer: 'Done, tests pass.', durationMs: 1, isAborted: false, reason: 'answer' })
    await world.clock.settle()
  }

  test('spawned once per qualifying turn: Explore, opus, read-only, with the ask, the claim, the ledger and the diff', async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build', diff: 'diff --git a/src/x.ts\n-a\n+b' })
    await editAndClaim($, world, 'x1')
    expect(world.spawnArgs).toHaveLength(1)
    const args = world.spawnArgs[0]!
    expect(args.subagentType).toBe('Explore')
    expect(args.model).toBe('opus')
    expect(args.prompt).toMatch(/Try to refute the claim that this work is done and verified/)
    expect(args.prompt).toContain('fix the loader')
    expect(args.prompt).toContain('Done, tests pass.')
    expect(args.prompt).toContain('bun test · exit 0')
    expect(args.prompt).toContain('+b')
    expect(world.runs.some(argv => argv.join(' ') === 'git diff -- /work/src/x.ts')).toBe(true)
  })

  test('skipped with no edits', async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build' })
    await editAndClaim($, world, 'x2', false)
    expect(world.spawnArgs).toHaveLength(0)
  })

  test('skipped with the config off', { options: { crossCheck: false } }, async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build' })
    await editAndClaim($, world, 'x3')
    expect(world.spawnArgs).toHaveLength(0)
  })

  test('skipped with /receipts check off', async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build' })
    await $.command.run({ command: 'receipts', args: 'check off' } as never)
    await editAndClaim($, world, 'x4')
    expect(world.spawnArgs).toHaveLength(0)
  })

  test('skipped above the usage guard (five-hour window over 85%)', async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build' })
    world.usage = { rateLimits: [{ kind: 'five_hour', percentUsed: 90 }] }
    await editAndClaim($, world, 'x5')
    expect(world.spawnArgs).toHaveLength(0)
  })

  test('skipped in -p mode', async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build' })
    await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' } as never)
    await editAndClaim($, world, 'x6')
    expect(world.spawnArgs).toHaveLength(0)
  })

  test('the card shows the cross-check row while it runs', async ($, on) => {
    const world = worldOf(on, { claimsDone: true, taskType: 'build' })
    await editAndClaim($, world, 'x7')
    expect((await bandText($)).text).toMatch(/cross-check · running \(opus\)…/)
  })
})

// ---- 5. card states ------------------------------------------------------------

function tasksOf(done: number, total: number): Plan {
  return {
    source: 'tasks',
    items: Array.from({ length: total }, (_, i): Milestone => ({ id: String(i), label: `Step ${i + 1} of the work`, state: i < done ? 'done' : 'pending' })),
  }
}

function endedOf(plan: Plan | null, finished: Partial<Finished>): ViewModel {
  return {
    plan,
    estimate: null,
    isWorking: false,
    showBasis: false,
    calibration: ['calibration: no finished tasks yet'],
    title: 'fix the loader so includes resolve relative to their file',
    elapsedMs: 107_000,
    finished: {
      totalMs: 107_000,
      receipt: null,
      isAborted: false,
      waitingAgents: 0,
      ledger: 'none',
      claimsDone: false,
      hasWork: false,
      crossCheck: null,
      ...finished,
    },
  }
}

const VERIFIED = 'receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago'
const CONFIRMED = { state: 'confirmed' as const, model: 'opus', reason: 'ok', reran: true, exit: 0, command: 'bun test', ms: 38_000 }

const STATES: [string, ViewModel, string, RegExp][] = [
  [
    'working',
    {
      ...endedOf(tasksOf(1, 3), {}),
      isWorking: true,
      finished: null,
      plan: { source: 'tasks', items: tasksOf(1, 3).items.map((item, i) => (i === 1 ? { ...item, state: 'current' } : item)) },
    },
    'claude',
    /^✶ fix the loader/,
  ],
  ['turn ended', endedOf(tasksOf(2, 5), { hasWork: true, ledger: 'unverified' }), 'inactive', /^ ■ Turn ended · 2 of 5 steps reached /],
  ['all done', endedOf(tasksOf(3, 3), { hasWork: true, ledger: 'verified', claimsDone: true, receipt: VERIFIED, crossCheck: CONFIRMED }), 'success', /^ ✓ All done /],
  [
    'done, unverified',
    endedOf(tasksOf(3, 3), { hasWork: true, ledger: 'unverified', claimsDone: true, receipt: 'UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since' }),
    'warning',
    /^ ⚠ Done, unverified /,
  ],
  [
    'done, refuted',
    endedOf(tasksOf(3, 3), {
      hasWork: true,
      ledger: 'verified',
      claimsDone: true,
      receipt: VERIFIED,
      crossCheck: { state: 'refuted', model: 'opus', reason: 'tests cover only the happy path', reran: false, exit: null, ms: 20_000 },
    }),
    'warning',
    /^ ✗ Done, refuted  tests cover only the happy path/,
  ],
  ['answered', endedOf({ source: 'answer', items: [{ id: 'answer', label: 'answer the question', state: 'done' }] }, { totalMs: 25_000 }), 'success', /^ ✓ Answered · 25s /],
]

describe('the six card states', () => {
  for (const columns of [95, 155]) {
    for (const [name, model, border, title] of STATES) {
      test(`${name} at ${columns + 5} columns`, () => {
        const view: BandView = bandView(model, columns, { collapsed: false, showBasis: false })
        expect(view.border).toBe(border)
        const rows = view.rows.map(rowText)
        for (const row of rows) expect([...row].length, row).toBe(columns - 4)
        expect(rows[0]).toMatch(title)
      })
    }
  }

  test('All done needs every step, a receipt after the last edit, and no refutation', () => {
    const base = { hasWork: true, claimsDone: true, receipt: VERIFIED, ledger: 'verified' as const }
    expect(bandView(endedOf(tasksOf(3, 3), base), 155, { collapsed: false, showBasis: false }).tone).toBe('done')
    expect(bandView(endedOf(tasksOf(2, 3), base), 155, { collapsed: false, showBasis: false }).tone).toBe('ended')
    expect(bandView(endedOf(tasksOf(3, 3), { ...base, ledger: 'unverified', receipt: null }), 155, { collapsed: false, showBasis: false }).tone).toBe('unverified')
    expect(
      bandView(endedOf(tasksOf(3, 3), { ...base, crossCheck: { state: 'refuted', model: 'opus', reason: 'no', reran: false, exit: null, ms: 1 } }), 155, {
        collapsed: false,
        showBasis: false,
      }).tone,
    ).toBe('refuted')
  })

  test('a failing verify forces the FAILED card, never All done', () => {
    const view = bandView(
      endedOf(tasksOf(3, 3), { hasWork: true, claimsDone: true, ledger: 'failed', receipt: 'FAILED · cargo test · exit 101 · test result: FAILED. 3 passed; 2 failed' }),
      155,
      { collapsed: false, showBasis: false },
    )
    expect(view.tone).toBe('unverified')
    expect(view.border).toBe('warning')
    const rows = view.rows.map(rowText)
    expect(rows[0]).toMatch(/^ ✗ Done, checks failed /)
    expect(rows.join('\n')).toMatch(/FAILED · cargo test · exit 101/)
  })

  test('the receipt row and the cross-check row follow the steps', () => {
    const rows = bandView(endedOf(tasksOf(3, 3), { hasWork: true, ledger: 'verified', claimsDone: true, receipt: VERIFIED, crossCheck: CONFIRMED }), 155, {
      collapsed: false,
      showBasis: false,
    }).rows.map(rowText)
    expect(rows[rows.length - 2]).toMatch(/^receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago/)
    expect(rows[rows.length - 1]).toMatch(/^cross-check · ✓ confirmed \(opus, reran bun test exit 0\) · 38s/)
  })
})

// ---- stats ---------------------------------------------------------------------

describe('stats', () => {
  test('stats count cross-check verdicts beside the false positives', async ($, on) => {
    worldOf(on)
    const out = (await $.command.run({ command: 'receipts', args: 'stats' } as never)) as { text?: string }
    expect(out.text).toMatch(/cross-checks: 0 confirmed, 0 refuted, 0 unclear/)
    expect(out.text).toMatch(/claims-done false positives: 0 of 0 receipts/)
  })
})

// The band's narrow-terminal width check uses the 100-column fixture too
test('fixtures stay in step', () => {
  expect(BAND.props.bodyColumns).toBe(95)
  expect(BAND_WIDE.props.bodyColumns).toBe(155)
})
