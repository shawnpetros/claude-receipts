/**
 * The spike (SPEC 3): when a task's shape is unfamiliar (under 3 samples) and
 * its plan has 3 or more steps, ask one cheap, read-only subagent for minutes
 * per step, once per task, capped at 60 seconds. Its answer counts as one
 * sample at weight 0.5, and the pane says "spike guess" while it is the only
 * basis.
 */

export const SPIKE_TIMEOUT_MS = 60_000
export const SPIKE_MIN_STEPS = 3
export const SPIKE_MODEL = 'haiku'
/** Read-only, so a sizing question can never edit the user's files. */
export const SPIKE_AGENT = 'Explore'

const MAX_MINUTES = 240
const MIN_MINUTES = 0.1

export function spikePromptOf(request: string, steps: readonly string[], repoEntries: readonly string[]): string {
  return [
    'Estimate how long a coding assistant will take for each step of this plan.',
    'Do not change any file. Do not run long commands. Answer within a minute.',
    '',
    'The request:',
    request.slice(0, 2_000),
    '',
    'The plan:',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    'Top level of the repository:',
    repoEntries.length > 0 ? repoEntries.join(', ') : '(unknown)',
    '',
    `Reply with JSON only, one number of minutes per step (${steps.length} numbers) and your confidence from 1 to 5:`,
    '{"minutes": [2, 5, 3], "confidence": 3}',
  ].join('\n')
}

export type SpikeGuess = {
  stepsMs: number[]
  confidence: number
}

/**
 * The guess in a subagent's reply, or null when it gave none that fits the
 * plan. Each step is clamped to 6 seconds .. 4 hours.
 */
export function parseSpike(answer: string, stepCount: number): SpikeGuess | null {
  const match = /\{[\s\S]*\}/.exec(answer)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const fields = parsed as { minutes?: unknown; confidence?: unknown }
  if (!Array.isArray(fields.minutes) || fields.minutes.length !== stepCount) return null
  if (!fields.minutes.every(m => typeof m === 'number' && Number.isFinite(m))) return null
  const stepsMs = (fields.minutes as number[]).map(m => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, m)) * 60_000)
  const confidence = typeof fields.confidence === 'number' ? Math.min(5, Math.max(1, fields.confidence)) : 1
  return { stepsMs, confidence }
}
