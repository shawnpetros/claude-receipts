/**
 * The per-turn ledger behind the receipt (SPEC 4): every edit, every verify
 * run with its exit code, and the one line printed under the answer.
 *
 * Order is by sequence number, not clock: "a verify after the last edit"
 * must hold even when two calls land in the same millisecond.
 *
 * This is a mirror, not a gate, in v1: nothing here blocks or aborts a turn.
 */

/**
 * SPEC 4's verify list, verbatim, with word boundaries added so `latest` or
 * `contest` do not read as `test`. `claude plugin test` matches on `test`.
 */
export const VERIFY_PATTERN =
  /(?<![\w-])(test|spec|jest|vitest|pytest|cargo (test|check|clippy)|go test|bun test|npm (test|run (test|build|lint))|pnpm|tsc|eslint|ruff|mypy|make (test|check)|build)(?![\w-])/

export type TestCounts = {
  pass?: number
  fail?: number
}

export type EditEntry = {
  seq: number
  at: number
  path: string
}

export type VerifyEntry = {
  seq: number
  at: number
  command: string
  exitCode: number
  counts?: TestCounts
}

export type Ledger = {
  seq: number
  edits: readonly EditEntry[]
  verifies: readonly VerifyEntry[]
}

/**
 * What a tool call resolved to, as far as the ledger reads it: Bash carries
 * no exit code field, so a failed run is `isError` with `Exit code N` text.
 */
export type ToolOutcome = {
  result?: unknown
  isError?: boolean
  text?: string
  deny?: string
}

export function emptyLedger(): Ledger {
  return { seq: 0, edits: [], verifies: [] }
}

export function isVerifyCommand(command: string): boolean {
  return VERIFY_PATTERN.test(command)
}

export function recordEdit(ledger: Ledger, path: string, at: number): Ledger {
  const seq = ledger.seq + 1
  return { ...ledger, seq, edits: [...ledger.edits, { seq, at, path }] }
}

export function recordVerify(ledger: Ledger, command: string, exitCode: number, output: string, at: number): Ledger {
  const seq = ledger.seq + 1
  const counts = testCountsOf(output)
  const entry: VerifyEntry = { seq, at, command, exitCode, ...(counts ? { counts } : {}) }
  return { ...ledger, seq, verifies: [...ledger.verifies, entry] }
}

export function exitCodeOf(outcome: ToolOutcome): number {
  if (!outcome.isError) return 0
  const match = /Exit code (\d+)/.exec(outcome.text ?? '')
  return match ? Number(match[1]) : 1
}

/**
 * Pass and fail counts from a test runner's output: bun, jest, vitest,
 * pytest, cargo and go all print `N pass(ed)` and `N fail(ed)` somewhere.
 */
export function testCountsOf(text: string): TestCounts | undefined {
  const pass = /(\d+) (?:pass|passed|passing)\b/.exec(text)
  const fail = /(\d+) (?:fail|failed|failing)\b/.exec(text)
  if (!pass && !fail) return undefined
  return {
    ...(pass ? { pass: Number(pass[1]) } : {}),
    ...(fail ? { fail: Number(fail[1]) } : {}),
  }
}

/**
 * The receipt line, or null when there is nothing to say: no edits this
 * turn, or the answer does not claim done.
 */
export function receiptLine(ledger: Ledger, claimsDone: boolean, now: number, cwd: string): string | null {
  if (ledger.edits.length === 0 || !claimsDone) return null
  const lastEdit = ledger.edits.reduce((a, b) => (b.seq > a.seq ? b : a))
  const after = ledger.verifies.filter(run => run.seq > lastEdit.seq)
  const verify = after[after.length - 1]
  if (!verify) {
    return `UNVERIFIED · claimed done, no test/build/run after the last edit (${relativeOf(lastEdit.path, cwd)} at ${clockOf(lastEdit.at)})`
  }
  return `receipt · ${commandLabelOf(verify.command)} ${outcomeOf(verify)} · ${agoOf(now - verify.at)}`
}

function outcomeOf(run: VerifyEntry): string {
  const pass = run.counts?.pass
  const fail = run.counts?.fail
  if (run.exitCode === 0) {
    return '✓' + (pass !== undefined ? ` ${pass} pass` : '') + (fail ? ` · ${fail} fail` : '')
  }
  return `✗ exit ${run.exitCode}` + (pass !== undefined ? ` · ${pass} pass` : '') + (fail ? ` · ${fail} fail` : '')
}

/**
 * The part of a compound command that matched, as the user would name it.
 */
export function commandLabelOf(command: string): string {
  const parts = command.split(/&&|\|\||;|\|/).map(part => part.trim())
  const label = parts.find(part => isVerifyCommand(part)) ?? command.trim()
  return label.length > 40 ? label.slice(0, 39) + '…' : label
}

export function relativeOf(path: string, cwd: string): string {
  const base = cwd.endsWith('/') ? cwd : cwd + '/'
  return path.startsWith(base) ? path.slice(base.length) : path
}

function clockOf(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function agoOf(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

/**
 * The fallback when the claims-done label is not back in time: plain words
 * of completion in the answer. Used only when the model call misses its
 * deadline or fails.
 */
export function looksDone(answer: string): boolean {
  return /\b(done|complete[ds]?|finished|fixed|implemented|all (?:\w+ )?(?:tests? )?pass(?:es|ing)?|ready|shipped)\b/i.test(answer)
}
