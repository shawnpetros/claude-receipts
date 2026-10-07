/**
 * Milestones: what the turn is working on, what is finished, what is left
 * (SPEC 2), and which tool rows count as milestone events.
 *
 * Sources, in order of preference: the task tools the assistant called
 * (TaskCreate / TaskUpdate, or TodoWrite), a plan derived by a model call
 * (labelled `derived`, invariant 9: the mod never passes its own guess off as
 * the assistant's plan), or a single fallback milestone, "the task".
 */

import { isVerifyCommand } from './ledger'

export type MilestoneState = 'done' | 'current' | 'pending'

export type Milestone = {
  id: string
  label: string
  state: MilestoneState
  startedAt?: number
  doneAt?: number
}

export type PlanSource = 'none' | 'tasks' | 'derived' | 'fallback'

export type Plan = {
  source: PlanSource
  items: readonly Milestone[]
}

export type TaskUpdateArgs = {
  taskId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'deleted'
  subject?: string
}

export type Todo = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export const FALLBACK_LABEL = 'the task'
const MIN_DERIVED = 2
const MAX_DERIVED = 8
const MAX_LABEL = 80

export function emptyPlan(): Plan {
  return { source: 'none', items: [] }
}

/**
 * A task tool beats a derived or fallback plan: the first TaskCreate drops
 * the mod's guess and starts the assistant's own list.
 */
export function onTaskCreate(plan: Plan, id: string, subject: string, now: number): Plan {
  const kept = plan.source === 'tasks' ? plan.items : []
  if (kept.some(item => item.id === id)) return plan
  return { source: 'tasks', items: [...kept, { id, label: labelOf(subject), state: 'pending' }] }
}

export function onTaskUpdate(plan: Plan, args: TaskUpdateArgs, now: number): Plan {
  const index = plan.items.findIndex(item => item.id === args.taskId)
  if (plan.source !== 'tasks' || index === -1) return plan
  if (args.status === 'deleted') {
    return { ...plan, items: plan.items.filter((_, i) => i !== index) }
  }
  const items = plan.items.map((item, i): Milestone => {
    if (i !== index) return item
    const label = args.subject === undefined ? item.label : labelOf(args.subject)
    switch (args.status) {
      case 'in_progress':
        return { ...item, label, state: 'current', startedAt: item.startedAt ?? now, doneAt: undefined }
      case 'completed':
        return { ...item, label, state: 'done', startedAt: item.startedAt ?? startOf(plan.items, i, now), doneAt: now }
      case 'pending':
        return { ...item, label, state: 'pending', doneAt: undefined }
      default:
        return { ...item, label }
    }
  })
  return { ...plan, items }
}

/**
 * TodoWrite sends the whole list each time: replace it, keeping the times of
 * items whose text did not change.
 */
export function onTodoWrite(plan: Plan, todos: readonly Todo[], now: number): Plan {
  const before = new Map(plan.items.map(item => [item.label, item]))
  const items = todos.map((todo, i): Milestone => {
    const label = labelOf(todo.content)
    const was = before.get(label)
    const state: MilestoneState = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'current' : 'pending'
    const startedAt = state === 'pending' ? was?.startedAt : (was?.startedAt ?? now)
    const doneAt = state === 'done' ? (was?.doneAt ?? now) : undefined
    return { id: `todo-${i}`, label, state, startedAt, doneAt }
  })
  return { source: 'tasks', items }
}

export function derivedPlan(labels: readonly string[], now: number): Plan {
  return {
    source: 'derived',
    items: labels.map((label, i) => ({
      id: `derived-${i}`,
      label: labelOf(label),
      state: i === 0 ? 'current' : 'pending',
      ...(i === 0 ? { startedAt: now } : {}),
    })),
  }
}

export function fallbackPlan(now: number): Plan {
  return { source: 'fallback', items: [{ id: 'task', label: FALLBACK_LABEL, state: 'current', startedAt: now }] }
}

/**
 * Marks the first current milestone done and starts the next pending one; a
 * derived step the classifier called done, or the fallback at turn end.
 */
export function completeCurrent(plan: Plan, now: number): Plan {
  let index = plan.items.findIndex(item => item.state === 'current')
  if (index === -1) index = plan.items.findIndex(item => item.state === 'pending')
  if (index === -1) return plan
  const items = plan.items.map((item, i): Milestone => {
    if (i === index) return { ...item, state: 'done', startedAt: item.startedAt ?? startOf(plan.items, i, now), doneAt: now }
    if (i === index + 1 && item.state === 'pending') return { ...item, state: 'current', startedAt: now }
    return item
  })
  return { ...plan, items }
}

/**
 * The turn ended: whatever is under way is done now. Steps never started stay
 * pending and are not learned from.
 */
export function finishPlan(plan: Plan, now: number): Plan {
  const items = plan.items.map((item, i): Milestone =>
    item.state === 'current' ? { ...item, state: 'done', startedAt: item.startedAt ?? startOf(plan.items, i, now), doneAt: now } : item,
  )
  return { ...plan, items }
}

/**
 * Whether the plan finished: every milestone done.
 */
export function isComplete(plan: Plan): boolean {
  return plan.items.length > 0 && plan.items.every(item => item.state === 'done')
}

export function hasCompleted(plan: Plan): boolean {
  return plan.items.some(item => item.state === 'done')
}

/**
 * How long each finished step took, in plan order, measured from its own
 * start or, failing that, from the previous step's end or the task's start.
 */
export function stepDurations(plan: Plan, startedAt: number): number[] {
  const durations: number[] = []
  let previousEnd = startedAt
  for (const item of plan.items) {
    if (item.state !== 'done' || item.doneAt === undefined) continue
    const start = item.startedAt ?? previousEnd
    durations.push(Math.max(0, item.doneAt - start))
    previousEnd = item.doneAt
  }
  return durations
}

/**
 * Lines of a model's plan reply, numbering and bullets stripped; 2..8 steps
 * or none at all.
 */
export function parseDerivedSteps(text: string): string[] {
  const steps = text
    .split('\n')
    .map(line => line.replace(/^\s*(?:\d+\s*[.):]|[-*•])\s*/, '').trim())
    .filter(line => line.length > 0)
    .slice(0, MAX_DERIVED)
    .map(labelOf)
  return steps.length >= MIN_DERIVED ? steps : []
}

export function glyphOf(state: MilestoneState): string {
  return state === 'done' ? '✓' : state === 'current' ? '▸' : '·'
}

function labelOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LABEL ? flat.slice(0, MAX_LABEL - 1) + '…' : flat
}

function startOf(items: readonly Milestone[], index: number, now: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const doneAt = items[i]?.doneAt
    if (doneAt !== undefined) return doneAt
  }
  return now
}

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

export function isEditTool(tool: string): boolean {
  return (EDIT_TOOLS as readonly string[]).includes(tool)
}

/**
 * The file an edit tool call changes, or undefined for any other call.
 */
export function editedPathOf(tool: string, input: unknown): string | undefined {
  if (!isEditTool(tool) || typeof input !== 'object' || input === null) return undefined
  const fields = input as { file_path?: unknown; notebook_path?: unknown }
  const path = fields.file_path ?? fields.notebook_path
  return typeof path === 'string' ? path : undefined
}

export function isCommitCommand(command: string): boolean {
  return /\bgit\s+(?:-\S+\s+)*commit\b/.test(command)
}

export function isPrCreateCommand(command: string): boolean {
  return /\bgh\s+pr\s+create\b/.test(command)
}

/**
 * A shell command whose row always draws in full: a verify run (its exit code
 * and test counts), a commit, or a pull request (invariant 5).
 */
export function isMilestoneCommand(command: string): boolean {
  return isVerifyCommand(command) || isCommitCommand(command) || isPrCreateCommand(command)
}

export function isSubagentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}
