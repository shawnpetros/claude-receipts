import { describe, expect, test } from 'claude-code/testing'

import { receiptLine, recordEdit, recordVerify, emptyLedger, exitCodeOf, isVerifyCommand, testCountsOf } from '../src/ledger'
import { worldOf } from './fixtures'

const PASSING = { result: { stdout: 'bun test v1.2\n\n 152 pass\n 0 fail\n', stderr: '', interrupted: false } }

function completeOf(turnId: string, answer: string) {
  return { turnId, answer, durationMs: 60_000, isAborted: false, reason: 'answer' as const }
}

describe('receipt on turn.complete', () => {
  test('edit, then bun test exit 0, then "done": the receipt line', async ($, on) => {
    const world = worldOf(on, { tools: { Bash: PASSING } })
    await $.turn.start({ text: 'fix x', turnId: 'r1' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await world.clock.advance(30_000)
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await world.clock.advance(60_000)
    const out = await $.turn.complete(completeOf('r1', 'Done. All 152 tests pass.'))
    expect(out.text).toBe('receipt · bun test ✓ 152 pass · 1m ago')
  })

  test('edit, then "done" with no verify: UNVERIFIED', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'fix x', turnId: 'r2' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    const out = await $.turn.complete(completeOf('r2', 'Fixed it, all done.'))
    expect(out.text).toMatch(/^UNVERIFIED · claimed done, no test\/build\/run after the last edit \(src\/x\.ts at \d\d:\d\d\)$/)
  })

  test('no edits: no line', async ($, on) => {
    const world = worldOf(on, { tools: { Bash: PASSING } })
    await $.turn.start({ text: 'what does x do', turnId: 'r3' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/x.ts' })
    const out = await $.turn.complete(completeOf('r3', 'Done: x parses the header.'))
    expect(out.text).toBe('')
    expect(world.classifies.some(labels => labels.includes('claims-done'))).toBe(false)
  })

  test('verify before the last edit: UNVERIFIED', async ($, on) => {
    const world = worldOf(on, { tools: { Bash: PASSING } })
    await $.turn.start({ text: 'fix x', turnId: 'r4' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await world.clock.advance(5_000)
    await $.tool.call({ tool: 'Write', file_path: '/work/src/y.ts', content: 'z' })
    const out = await $.turn.complete(completeOf('r4', 'All done.'))
    expect(out.text).toMatch(/^UNVERIFIED · claimed done, no test\/build\/run after the last edit \(src\/y\.ts at \d\d:\d\d\)$/)
  })

  test('not claiming done: no line, even with an unverified edit', async ($, on) => {
    worldOf(on, { claimsDone: false })
    await $.turn.start({ text: 'fix x', turnId: 'r5' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    const out = await $.turn.complete(completeOf('r5', 'I changed x; want me to run the tests?'))
    expect(out.text).toBe('')
  })

  test('a failing verify after the last edit is reported as it ran', async ($, on) => {
    const world = worldOf(on, {
      tools: { Bash: { result: { stdout: ' 150 pass\n 2 fail\n', stderr: '', interrupted: false }, isError: true, text: 'Exit code 1\n 150 pass\n 2 fail' } },
    })
    await $.turn.start({ text: 'fix x', turnId: 'r6' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await world.clock.advance(5_000)
    const out = await $.turn.complete(completeOf('r6', 'Done.'))
    expect(out.text).toBe('receipt · bun test ✗ exit 1 · 150 pass · 2 fail · 5s ago')
  })
})

describe('ledger', () => {
  test('the verify pattern matches the spec list and not look-alikes', () => {
    for (const cmd of ['bun test', 'npm test', 'npm run build', 'pnpm lint', 'cargo clippy', 'go test ./...', 'pytest -q', 'tsc -p .', 'make check', 'claude plugin test', 'cd a && vitest run']) {
      expect(isVerifyCommand(cmd), cmd).toBe(true)
    }
    for (const cmd of ['ls', 'git status', 'cat latest.txt', 'echo contest']) {
      expect(isVerifyCommand(cmd), cmd).toBe(false)
    }
  })

  test('exit codes and test counts are read from what the tool returned', () => {
    expect(exitCodeOf({ result: {} })).toBe(0)
    expect(exitCodeOf({ result: {}, isError: true, text: 'Exit code 2\nboom' })).toBe(2)
    expect(exitCodeOf({ result: {}, isError: true, text: 'boom' })).toBe(1)
    expect(testCountsOf('Tests: 3 failed, 40 passed, 43 total')).toEqual({ pass: 40, fail: 3 })
    expect(testCountsOf('test result: ok. 12 passed; 0 failed')).toEqual({ pass: 12, fail: 0 })
    expect(testCountsOf('nothing here')).toBeUndefined()
  })

  test('the receipt line is pure over the ledger', () => {
    let ledger = emptyLedger()
    expect(receiptLine(ledger, true, 0, '/work')).toBeNull()
    ledger = recordEdit(ledger, '/work/a.ts', 0)
    ledger = recordVerify(ledger, 'tsc --noEmit', 0, '', 1_000)
    expect(receiptLine(ledger, true, 4 * 60_000, '/work')).toBe('receipt · tsc --noEmit ✓ · 3m ago')
    expect(receiptLine(ledger, false, 4 * 60_000, '/work')).toBeNull()
  })
})
