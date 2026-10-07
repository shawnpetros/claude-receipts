/**
 * What the pane and the clean-view rows say, as plain text lines, and the
 * view model the band draws from (the band itself is band.ts).
 * `hooks/register.ts` turns each line into a Text element; nothing here knows
 * about elements or `$`.
 */

import { basisLines, estimateRow, type Estimate } from './estimator'
import { relativeOf } from './ledger'
import { glyphOf, type Plan } from './milestones'

export type Line = {
  key: string
  text: string
  dim?: boolean
  bold?: boolean
  color?: string
}

export type ViewModel = {
  /** The plan being worked, or the last finished one. */
  plan: Plan | null
  estimate: Estimate | null
  isWorking: boolean
  showBasis: boolean
  calibration: readonly string[]
  /** The user's prompt for the task shown, as typed. */
  title: string
  /** Time since the task shown started. */
  elapsedMs: number
  /** Set once a task finished: how long it took, its receipt line, and whether it was cut short. */
  finished: { totalMs: number; receipt: string | null; isAborted: boolean; waitingAgents: number } | null
}

export const BAR_WIDTH = 24

/**
 * Cut to `columns` code points, with an ellipsis when cut.
 */
export function truncate(text: string, columns: number): string {
  const points = [...text]
  if (points.length <= columns) return text
  if (columns <= 1) return points.slice(0, Math.max(0, columns)).join('')
  return points.slice(0, columns - 1).join('') + '…'
}

export function barOf(progress: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(progress * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function headerOf(plan: Plan): Line {
  switch (plan.source) {
    case 'derived':
      return { key: 'plan-header', text: 'plan · derived (the mod\'s guess, not the assistant\'s)', dim: true }
    case 'fallback':
      return { key: 'plan-header', text: 'plan · none given', dim: true }
    case 'none':
      return { key: 'plan-header', text: 'plan · waiting for the first step', dim: true }
    default:
      return { key: 'plan-header', text: 'plan', dim: true }
  }
}

function durationText(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * The pane, top to bottom under its title row: milestones, the progress bar,
 * the estimate, the basis detail when asked, the calibration line, and the
 * finished task's receipt.
 */
export function paneLines(model: ViewModel): Line[] {
  const lines: Line[] = []
  const { plan, estimate } = model
  if (!plan) {
    lines.push({ key: 'idle', text: 'no task yet', dim: true })
  } else {
    lines.push(headerOf(plan))
    plan.items.forEach((item, i) => {
      lines.push({
        key: `m-${i}`,
        text: `${glyphOf(item.state)} ${item.label}`,
        ...(item.state === 'done' ? { dim: true } : {}),
        ...(item.state === 'current' ? { bold: true } : {}),
      })
    })
  }
  if (model.isWorking && estimate) {
    const progress = estimate.kind === 'range' ? estimate.progress : 0
    const isOver = estimate.kind === 'range' && estimate.isOver
    lines.push({ key: 'bar', text: `${barOf(progress, BAR_WIDTH)} ${Math.round(progress * 100)}%`, ...(isOver ? { dim: true } : {}) })
    lines.push({ key: 'estimate', text: estimateRow(estimate), ...(isOver ? { color: 'yellow' } : {}) })
    if (model.showBasis) {
      basisLines(estimate).forEach((text, i) => lines.push({ key: `basis-${i}`, text, dim: true }))
    }
  }
  if (model.finished) {
    lines.push({ key: 'finished', text: `finished in ${durationText(model.finished.totalMs)}`, dim: true })
    if (model.finished.receipt) {
      const isBad = model.finished.receipt.startsWith('UNVERIFIED')
      lines.push({ key: 'receipt', text: model.finished.receipt, ...(isBad ? { color: 'yellow' } : { color: 'green' }) })
    }
  }
  model.calibration.forEach((text, i) =>
    lines.push({ key: `cal-${i}`, text, ...(i === 0 ? { dim: true } : { color: 'yellow' }) }),
  )
  return lines
}

function fieldOf(input: unknown, name: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The one dim line a tool call becomes in clean view: `● Edit src/x.ts`.
 */
export function toolRowText(tool: string, input: unknown, cwd: string): string {
  const path = fieldOf(input, 'file_path') ?? fieldOf(input, 'notebook_path') ?? fieldOf(input, 'path')
  const arg =
    (path !== undefined ? relativeOf(path, cwd) : undefined) ??
    fieldOf(input, 'command') ??
    fieldOf(input, 'pattern') ??
    fieldOf(input, 'url') ??
    fieldOf(input, 'query') ??
    fieldOf(input, 'description') ??
    fieldOf(input, 'subject') ??
    ''
  const flat = arg.replace(/\s+/g, ' ').trim()
  return truncate(flat ? `● ${tool} ${flat}` : `● ${tool}`, 160)
}

function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') return output
  if (typeof output !== 'object' || output === null) return undefined
  const fields = output as { stdout?: unknown; stderr?: unknown; file?: { content?: unknown }; content?: unknown }
  if (typeof fields.stdout === 'string') return [fields.stdout, typeof fields.stderr === 'string' ? fields.stderr : ''].filter(Boolean).join('\n')
  if (typeof fields.file?.content === 'string') return fields.file.content
  if (typeof fields.content === 'string') return fields.content
  return undefined
}

/**
 * The one dim line a tool result becomes in clean view: `⎿ 12 lines`.
 */
export function toolResultText(output: unknown, isErrored: boolean): string {
  if (isErrored) return '⎿ error'
  const text = textOf(output)
  if (text === undefined) return '⎿ done'
  const trimmed = text.replace(/\n+$/, '')
  if (trimmed.length === 0) return '⎿ no output'
  const count = trimmed.split('\n').length
  return `⎿ ${count} ${count === 1 ? 'line' : 'lines'}`
}

/**
 * A folded run of reads and searches, as one dim line.
 */
export function toolGroupText(calls: readonly { tool: string }[]): string {
  const tools = [...new Set(calls.map(call => call.tool))]
  return truncate(`● ${calls.length} ${calls.length === 1 ? 'call' : 'calls'}: ${tools.join(', ')}`, 160)
}
