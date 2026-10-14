/**
 * The adversarial cross-check (SPEC-0.3 section 4) and the plan instruction
 * (section 1): pure text in and out, no `$`.
 *
 * Invariant 12: the cross-check is independent. A separate agent, read-only,
 * that may re-run the gate; its verdict is displayed verbatim and never
 * softened. Scar: "a subagent's 'it works' is a hypothesis" — the same holds
 * for the main loop's own "done", which is why something else re-checks it.
 */

/**
 * Attached beside a build, debug, config or refactor prompt. Byte-stable, so
 * the prompt cache sees the same text every time.
 */
export const PLAN_INSTRUCTION =
  'Before non-trivial work, record your plan with TaskCreate as 2 to 8 short steps, mark each in_progress and completed with TaskUpdate as you go, and keep the list current if the plan changes.'

export const DIFF_MAX_LINES = 400
export const CROSS_CHECK_CAP_MS = 90_000
export const CROSS_CHECK_AGENT = 'Explore'
/** Above this share of the five-hour window, no cross-check is spawned. */
export const USAGE_GUARD_PERCENT = 85
const CLIP = 800
const REASON_MAX = 120

export type Verdict = {
  verdict: 'confirmed' | 'refuted' | 'unclear'
  reason: string
  reran: boolean
  exit: number | null
}

export type CrossCheck =
  | { state: 'running'; model: string }
  | {
      state: 'confirmed' | 'refuted' | 'unclear'
      model: string
      reason: string
      reran: boolean
      exit: number | null
      /** The verify command it could have re-run, for the row. */
      command?: string
      ms: number
    }

function clip(text: string, max = CLIP): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/**
 * The diff the agent reads: whole up to DIFF_MAX_LINES, else its stat and a
 * note that it was too large, so the agent knows it read a summary.
 */
export function diffForCheck(diff: string, stat: string): string {
  const lines = diff.replace(/\n+$/, '').split('\n')
  if (lines.length <= DIFF_MAX_LINES) return diff
  return `diff too large to read in full (${lines.length} lines); git diff --stat:\n${stat}`
}

export function crossCheckPromptOf(args: { ask: string; claim: string; ledger: readonly string[]; diff: string; files: readonly string[] }): string {
  return [
    'Try to refute the claim that this work is done and verified. Re-run the verify command if one exists (read-only otherwise). Default to refuted if uncertain.',
    'Do not edit any file. Answer with JSON only:',
    '{"verdict": "confirmed" | "refuted" | "unclear", "reason": "at most 120 characters", "reran": true | false, "exit": <exit code of your re-run, or null>}',
    '',
    'The request:',
    clip(args.ask),
    '',
    'The claim:',
    clip(args.claim),
    '',
    'What ran (command · exit code · summary line):',
    ...(args.ledger.length > 0 ? args.ledger : ['(nothing that looks like a test, build or check)']),
    '',
    'Files edited:',
    ...args.files,
    '',
    'The diff:',
    args.diff.trim() || '(empty: the files may be new and untracked; read them)',
  ].join('\n')
}

/**
 * The agent's JSON, in a fence or bare. Anything that does not parse into a
 * verdict is `unclear`, never a guess at what it meant.
 */
export function parseVerdict(answer: string): Verdict {
  const unclear: Verdict = { verdict: 'unclear', reason: '', reran: false, exit: null }
  const body = /\{[\s\S]*\}/.exec(answer)?.[0]
  if (!body) return unclear
  try {
    const raw = JSON.parse(body) as Record<string, unknown>
    const verdict = raw.verdict
    if (verdict !== 'confirmed' && verdict !== 'refuted' && verdict !== 'unclear') return unclear
    return {
      verdict,
      reason: typeof raw.reason === 'string' ? clip(raw.reason.replace(/\s+/g, ' ').trim(), REASON_MAX) : '',
      reran: raw.reran === true,
      exit: typeof raw.exit === 'number' ? raw.exit : null,
    }
  } catch {
    return unclear
  }
}

function secondsOf(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The card's cross-check row, the agent's reason verbatim. */
export function crossCheckRowOf(check: CrossCheck): string {
  if (check.state === 'running') return `cross-check · running (${check.model})…`
  if (check.state === 'refuted') return `cross-check · ✗ refuted: ${check.reason || 'no reason given'}`
  if (check.state === 'unclear') return `cross-check · ? unclear${check.reason ? `: ${check.reason}` : ''}`
  const how = check.reran ? `reran ${check.command ?? 'the gate'} exit ${check.exit ?? '?'}` : 'did not re-run'
  return `cross-check · ✓ confirmed (${check.model}, ${how}) · ${secondsOf(check.ms)}`
}
