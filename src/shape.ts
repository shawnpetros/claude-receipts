/**
 * Task shape: the key the estimator learns under (SPEC 3).
 *
 * `{ task_type, step_count_bucket, repo, has_tests, tool_mix_bucket }`, plus
 * the ladder of coarser keys the estimator falls back through when the exact
 * shape has too few samples. No `$` here: plain data in, plain data out.
 */

export const TASK_TYPES = ['build', 'debug', 'research', 'writing', 'config', 'refactor', 'chat'] as const

export type TaskType = (typeof TASK_TYPES)[number] | 'unknown'

export type StepBucket = '1' | '2-3' | '4-6' | '7+'

/**
 * What kind of tools dominated the task. Known only as the task runs, so the
 * plan-time lookups skip it (see `planKeyOf`).
 */
export type ToolMix = 'none' | 'edit' | 'read' | 'shell' | 'mixed'

export type Shape = {
  taskType: TaskType
  steps: StepBucket
  /** A short hash of the repository root or working directory, never the path. */
  repo: string
  hasTests: boolean
  mix: ToolMix
}

export type ToolCounts = {
  edit: number
  read: number
  shell: number
  other: number
}

export const NO_TOOLS: ToolCounts = { edit: 0, read: 0, shell: 0, other: 0 }

/**
 * The key every task shares: the global prior's bucket.
 */
export const GLOBAL_KEY = '*'

export function stepBucketOf(count: number): StepBucket {
  if (count <= 1) return '1'
  if (count <= 3) return '2-3'
  if (count <= 6) return '4-6'
  return '7+'
}

/**
 * The dominant kind of tool, when one kind is at least 60% of the calls.
 */
export function toolMixOf(counts: ToolCounts): ToolMix {
  const total = counts.edit + counts.read + counts.shell + counts.other
  if (total === 0) return 'none'
  const kinds: [ToolMix, number][] = [
    ['edit', counts.edit],
    ['read', counts.read],
    ['shell', counts.shell],
  ]
  for (const [kind, count] of kinds) {
    if (count / total >= 0.6) return kind
  }
  return 'mixed'
}

export function countTool(counts: ToolCounts, tool: string): ToolCounts {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return { ...counts, edit: counts.edit + 1 }
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch)$/.test(tool)) return { ...counts, read: counts.read + 1 }
  if (tool === 'Bash') return { ...counts, shell: counts.shell + 1 }
  return { ...counts, other: counts.other + 1 }
}

/**
 * FNV-1a over the text, as 8 hex digits: enough to tell repos apart in one
 * person's history without writing their paths into the store.
 */
export function repoHashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The shape's keys from most to least specific, the global key not included:
 * full shape, shape without tool mix, type and steps, type alone.
 */
export function levelKeysOf(shape: Shape): string[] {
  const tests = shape.hasTests ? 't' : 'n'
  return [
    `${shape.taskType}|${shape.steps}|${shape.repo}|${tests}|${shape.mix}`,
    planKeyOf(shape),
    `${shape.taskType}|${shape.steps}`,
    `${shape.taskType}`,
  ]
}

/**
 * The most specific key known when the plan is: every field but the tool
 * mix, which only the finished task can say. The spike gate reads this one.
 */
export function planKeyOf(shape: Shape): string {
  return `${shape.taskType}|${shape.steps}|${shape.repo}|${shape.hasTests ? 't' : 'n'}`
}

/**
 * The keys that do not depend on a step count, for a task with no plan yet.
 */
export function planlessKeysOf(shape: Shape): string[] {
  return [`${shape.taskType}`]
}
