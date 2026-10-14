/**
 * The per-turn ledger behind the receipt: every edit, every verify run with
 * its command, exit code and summary line, and every grep for "error".
 *
 * Invariant 11: a receipt is a command, an exit code and a verbatim summary
 * line. Nothing less is called a receipt. Scar: a regex mirror that called a
 * `grep -i error build.log` a check; Prettier reports as a warning and
 * jest's summary can be swallowed by a pipe, so a grep for "error" proves
 * nothing passed.
 *
 * Order is by sequence number, not clock: "a verify after the last edit"
 * must hold even when two calls land in the same millisecond.
 *
 * A mirror, not a gate: nothing here blocks or aborts a turn.
 */

/**
 * The verify list, with word boundaries so `latest` or `contest` do not read
 * as `test`. A grep is never a verify, whatever words its arguments hold.
 */
export const VERIFY_PATTERN =
  /(?<![\w-])(test|spec|jest|vitest|pytest|cargo (test|check|clippy|build)|go (test|build|vet)|bun test|npm (test|run (test|build|lint|check))|pnpm|tsc|eslint|ruff|mypy|make|build)(?![\w-])/

/** A search for the word "error", which reads as a check and is not one. */
const GREP_ERROR = /\b(grep|rg|ag)\b[^|;&]*\berrors?\b/i

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
  /** The runner's summary line, verbatim, when one of the known shapes printed. */
  summary?: string
}

export type GrepEntry = {
  seq: number
  at: number
  command: string
}

export type Ledger = {
  seq: number
  edits: readonly EditEntry[]
  verifies: readonly VerifyEntry[]
  greps: readonly GrepEntry[]
}

/** Where the work stands: no edits, a passing or failing verify after the last edit, or neither. */
export type LedgerState = 'none' | 'verified' | 'failed' | 'unverified'

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
  return { seq: 0, edits: [], verifies: [], greps: [] }
}

export function isGrepForError(command: string): boolean {
  return GREP_ERROR.test(command)
}

export function isVerifyCommand(command: string): boolean {
  return !isGrepForError(command) && !/^\s*(grep|rg|ag)\b/.test(command) && VERIFY_PATTERN.test(command)
}

export function recordEdit(ledger: Ledger, path: string, at: number): Ledger {
  const seq = ledger.seq + 1
  return { ...ledger, seq, edits: [...ledger.edits, { seq, at, path }] }
}

export function recordVerify(ledger: Ledger, command: string, exitCode: number, output: string, at: number): Ledger {
  const seq = ledger.seq + 1
  const summary = summaryLineOf(output)
  const entry: VerifyEntry = { seq, at, command, exitCode, ...(summary ? { summary } : {}) }
  return { ...ledger, seq, verifies: [...ledger.verifies, entry] }
}

export function recordGrep(ledger: Ledger, command: string, at: number): Ledger {
  const seq = ledger.seq + 1
  return { ...ledger, seq, greps: [...ledger.greps, { seq, at, command }] }
}

export function exitCodeOf(outcome: ToolOutcome): number {
  if (!outcome.isError) return 0
  const match = /Exit code (\d+)/.exec(outcome.text ?? '')
  return match ? Number(match[1]) : 1
}

/**
 * Known summary shapes, most specific first. Each finds the last matching
 * line, since runners print their summary at the end.
 */
const SUMMARY_SHAPES: readonly RegExp[] = [
  /^test result: .*$/, // cargo test
  /^=+ .*\b(passed|failed|error|errors|skipped)\b.* in [\d.]+s.* =+$/, // pytest
  /^Tests:\s+.*\btotal$/, // jest
  /^Tests\s+\d+ .*$/, // vitest
  /^make: \*\*\* .*Error \d+.*$/, // make
  /^error(\[E\d+\])?: .*$/, // rustc, tsc-like
  /^(ok|FAIL)\s+\S+\s+[\d.]+s$/, // go, per package
  /^Ran \d+ tests? in [\d.]+s$/, // unittest
  /^(OK|FAILED)( \(.*\))?$/, // unittest verdict
  /^FAIL\b.*$/, // generic
]

/**
 * The runner's summary line, verbatim, or undefined when nothing known
 * printed: no line is invented. bun prints pass and fail on two lines;
 * they are joined as `105 pass, 0 fail`, each half verbatim.
 */
export function summaryLineOf(output: string): string | undefined {
  const lines = output.split('\n').map(line => line.replace(/\s+$/, ''))
  const bunPass = lines.filter(line => /^\s*\d+ pass$/.test(line)).pop()
  const bunFail = lines.filter(line => /^\s*\d+ fail$/.test(line)).pop()
  if (bunPass || bunFail) return [bunPass, bunFail].filter(Boolean).map(line => line!.trim()).join(', ')
  for (const shape of SUMMARY_SHAPES) {
    const found = lines.filter(line => shape.test(line.trim())).pop()
    if (found) return found.trim()
  }
  return undefined
}

function lastEditOf(ledger: Ledger): EditEntry | undefined {
  return ledger.edits.length === 0 ? undefined : ledger.edits.reduce((a, b) => (b.seq > a.seq ? b : a))
}

/** The last verify after the last edit, if any. */
export function receiptVerifyOf(ledger: Ledger): VerifyEntry | undefined {
  const lastEdit = lastEditOf(ledger)
  if (!lastEdit) return undefined
  const after = ledger.verifies.filter(run => run.seq > lastEdit.seq)
  return after[after.length - 1]
}

export function ledgerStateOf(ledger: Ledger): LedgerState {
  if (!lastEditOf(ledger)) return 'none'
  const verify = receiptVerifyOf(ledger)
  if (!verify) return 'unverified'
  return verify.exitCode === 0 ? 'verified' : 'failed'
}

/**
 * The line under the answer, or null when there is nothing to say: no edits
 * this turn, or the answer does not claim done.
 *
 * - `receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago`
 * - `FAILED · cargo test · exit 101 · test result: FAILED. 3 passed; 2 failed; …`
 * - `UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since`
 */
export function receiptLine(ledger: Ledger, claimsDone: boolean, now: number, cwd: string): string | null {
  const lastEdit = lastEditOf(ledger)
  if (!lastEdit || !claimsDone) return null
  const verify = receiptVerifyOf(ledger)
  if (!verify) {
    const grepped = ledger.greps.some(grep => grep.seq > lastEdit.seq)
    return (
      `UNVERIFIED · claims done · last edit ${relativeOf(lastEdit.path, cwd)} ${clockOf(lastEdit.at)} · no verify since` +
      (grepped ? ' (grep-for-error, not a receipt)' : '')
    )
  }
  const parts = [commandLabelOf(verify.command), `exit ${verify.exitCode}`, ...(verify.summary ? [verify.summary] : [])]
  if (verify.exitCode !== 0) return `FAILED · ${parts.join(' · ')}`
  return `receipt · ${parts.join(' · ')} · ${agoOf(now - verify.at)}`
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
