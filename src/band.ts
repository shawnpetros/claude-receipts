/**
 * The band above the prompt and the tools panel, as rows of styled
 * segments, each row exactly the width it is given. Pure: no `$`, no
 * elements. `hooks/register.ts` turns a segment into a Text (or a Button
 * when it carries one) and a row into a Box; tests and `scripts/mock-band.ts`
 * read the same rows as plain text.
 *
 * Laying out to exact widths here, instead of trusting flex to right-align,
 * keeps the right-hand column (elapsed, percent, the estimate) where the
 * tests say it is at every width, and nothing ever wraps the band taller.
 */

import type { Color } from 'claude-code'

import { crossCheckRowOf, type CrossCheck } from './crosscheck'
import { basisLines, durationOf, estimateRow, type Estimate } from './estimator'
import type { Milestone, Plan } from './milestones'
import type { Switch } from './switches'
import { truncate, type ViewModel } from './view'

export const ACCENT: Color = 'claude'
export const DONE: Color = 'success'
export const WARN: Color = 'warning'
/** Over the range: the bar and border go grey, never red. Running long is not an error. */
export const OVER: Color = 'inactive'

/**
 * Below this many band body columns the per-step bars drop. The band's body
 * is the terminal less the engine's five cells for its own `[-]`, so 105 is
 * a 110-column terminal.
 */
export const NARROW_BODY = 105
/** The round border and one cell of padding each side. */
export const FRAME = 4
export const MINI_BAR = 16
/** The step labels' column, as a share of the band's width (frames 20, 26). */
const LABEL_SHARE = 0.3
/** The ask in the title row is cut here, room or not (frame 18). */
export const TITLE_MAX = 39
export const MAX_STEP_ROWS = 6
const MIN_TAIL = 12

export type SegButton = {
  key: string
  label: string
  hotkey?: string
}

export type Seg = {
  text: string
  color?: Color
  dim?: boolean
  bold?: boolean
  inverse?: boolean
  /** Shrinks first when the row is too wide. */
  grow?: boolean
  /** Drawn as a plain Button; `text` is what the terminal draws for it. */
  button?: SegButton
}

export type Row = {
  key: string
  segs: Seg[]
}

export type BandTone = 'working' | 'over' | 'done' | 'answered' | 'ended' | 'unverified' | 'refuted' | 'stopped'

export type BandView = {
  tone: BandTone
  border: Color
  rows: Row[]
}

export type BandOptions = {
  collapsed: boolean
  showBasis: boolean
}

export function innerWidthOf(columns: number): number {
  return Math.max(1, columns - FRAME)
}

export function rowText(row: Row): string {
  return row.segs.map(seg => seg.text).join('')
}

function widthOf(segs: readonly Seg[]): number {
  return segs.reduce((sum, seg) => sum + [...seg.text].length, 0)
}

function space(n: number): Seg {
  return { text: ' '.repeat(Math.max(0, n)) }
}

/**
 * A plain Button as a segment: `b: basis` with a hotkey, the label alone without.
 */
function buttonSeg(key: string, label: string, hotkey?: string, dim = true): Seg {
  return {
    text: hotkey ? `${hotkey}: ${label}` : label,
    ...(dim ? { dim: true } : {}),
    button: { key, label, ...(hotkey ? { hotkey } : {}) },
  }
}

/**
 * Cuts segments to `width` cells from the right, keeping each one's style;
 * a Button that no longer fits whole is dropped, never drawn half.
 */
function clip(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = []
  let left = width
  for (const seg of segs) {
    const length = [...seg.text].length
    if (length <= left) {
      out.push(seg)
      left -= length
      continue
    }
    if (left > 0 && !seg.button) out.push({ ...seg, text: truncate(seg.text, left) })
    else if (left > 0) out.push(space(left))
    left = 0
    break
  }
  return out
}

/**
 * One row of exactly `width` cells: `left` at the start, `right` at the end,
 * at least `gap` spaces between. The `grow` segment of `left` gives way first.
 */
function line(width: number, left: readonly Seg[], right: readonly Seg[] = [], gap = 2): Seg[] {
  const rightWidth = widthOf(right)
  const room = width - rightWidth - (right.length > 0 ? gap : 0)
  let segs = [...left]
  const over = widthOf(segs) - room
  if (over > 0) {
    const i = segs.findIndex(seg => seg.grow)
    if (i !== -1) {
      const seg = segs[i]!
      const keep = Math.max(0, [...seg.text].length - over)
      segs[i] = { ...seg, text: keep === 0 ? '' : truncate(seg.text, keep) }
    }
    if (widthOf(segs) > Math.max(0, room)) segs = clip(segs, Math.max(0, room))
  }
  if (rightWidth > width) return clip([...right], width)
  const pad = width - widthOf(segs) - rightWidth
  return [...segs, space(pad), ...right]
}

function barSegs(progress: number, width: number, color: Color, isDim = false, full = '━', empty = '─'): Seg[] {
  const filled = Math.max(0, Math.min(width, Math.round(progress * width)))
  return [
    { text: full.repeat(filled), color, ...(isDim ? { dim: true } : {}) },
    { text: empty.repeat(width - filled), dim: true },
  ]
}

// ---- the band ---------------------------------------------------------------

function currentIndexOf(plan: Plan): number {
  return plan.items.findIndex(item => item.state === 'current')
}

function reachedOf(plan: Plan | null): { done: number; total: number } {
  const items = plan?.items ?? []
  return { done: items.filter(item => item.state === 'done').length, total: items.length }
}

function hasSteps(plan: Plan | null): plan is Plan {
  return plan !== null && plan.items.length > 0
}

function stepCounterOf(plan: Plan): string {
  const n = plan.items.length
  const current = currentIndexOf(plan)
  const done = plan.items.filter(item => item.state === 'done').length
  const i = current === -1 ? Math.min(done + 1, n) : current + 1
  return `Step ${i} of ${n}` + (plan.source === 'answer' ? ' · answer' : '')
}

/**
 * The ask as the title row shows it: one line, cut at TITLE_MAX with an
 * ellipsis even when there is room, as the reference band does (frame 18).
 */
function askOf(title: string): string {
  return truncate(title.replace(/\s+/g, ' ').trim() || 'continuing', TITLE_MAX)
}

function titleRow(model: ViewModel, width: number, tone: BandTone): Row {
  const title = askOf(model.title)
  if (tone === 'working' || tone === 'over') {
    // The estimate keeps its place here, dim and with its basis (honesty
    // contract), where the reference band leaves the row empty
    const est = model.estimate ? estimateRow(model.estimate) : ''
    const left: Seg[] = [{ text: '✶ ', color: ACCENT, bold: true }, { text: title, color: ACCENT, bold: true }]
    const right: Seg[] = [...(est ? [{ text: est, dim: true, grow: true }, space(2)] : []), { text: durationOf(model.elapsedMs) }]
    return { key: 'title', segs: lineRight(width, left, right) }
  }
  const finished = model.finished
  const totalMs = finished?.totalMs ?? model.elapsedMs
  const waiting = finished?.waitingAgents ?? 0
  const tail: Seg[] = waiting > 0 ? [{ text: `waiting on ${waiting} ${waiting === 1 ? 'agent' : 'agents'}`, color: WARN }] : []
  const took: Seg[] = [...(tail.length ? [...tail, space(2)] : []), { text: `took ${durationOf(totalMs)}` }]
  const badgeOf = (text: string, color: Color): Seg => ({ text: ` ${text} `, color, inverse: true, bold: true })
  let badge: Seg
  let text: Seg = { text: title, grow: true }
  let right = took
  switch (tone) {
    case 'stopped':
      badge = badgeOf('■ Stopped', OVER)
      text = { text: title, dim: true, grow: true }
      break
    case 'refuted':
      // The cross-check's reason, verbatim (invariant 12)
      badge = badgeOf('✗ Done, refuted', WARN)
      text = { text: finished?.crossCheck && 'reason' in finished.crossCheck ? finished.crossCheck.reason || title : title, color: WARN, grow: true }
      break
    case 'unverified':
      badge = finished?.ledger === 'failed' ? badgeOf('✗ Done, checks failed', WARN) : badgeOf('⚠ Done, unverified', WARN)
      text = { text: title, color: WARN, grow: true }
      break
    case 'ended': {
      // Steps left, or work with no claim of done: say how far it got.
      // Scar: a green card over three steps that never ran, read as finished
      const { done, total } = reachedOf(model.plan)
      badge = badgeOf(hasSteps(model.plan) && model.plan.source === 'tasks' ? `■ Turn ended · ${done} of ${total} ${total === 1 ? 'step' : 'steps'} reached` : '■ Turn ended', OVER)
      break
    }
    case 'answered':
      // An answer, not a job: the badge carries the time
      badge = badgeOf(`✓ Answered · ${durationOf(totalMs)}`, DONE)
      text = { text: title, color: DONE, grow: true }
      right = tail
      break
    default:
      badge = badgeOf('✓ All done', DONE)
      text = { text: title, color: DONE, grow: true }
  }
  return { key: 'title', segs: line(width, [badge, space(1), text], right) }
}

/**
 * A row whose right side may give way: `right`'s grow segment shrinks first,
 * so the elapsed time at the end is never cut.
 */
function lineRight(width: number, left: readonly Seg[], right: readonly Seg[]): Seg[] {
  const room = width - widthOf(left) - 2
  let segs = [...right]
  const over = widthOf(segs) - room
  if (over > 0) {
    const i = segs.findIndex(seg => seg.grow)
    if (i !== -1) {
      const keep = Math.max(0, [...segs[i]!.text].length - over)
      segs = keep < MIN_TAIL ? segs.filter((_, j) => j !== i && j !== i + 1) : segs.map((seg, j) => (j === i ? { ...seg, text: truncate(seg.text, keep) } : seg))
    }
  }
  return line(width, left, segs)
}

/** A bar of cells, filled then empty, as the reference band draws its bars. */
function cellsOf(progress: number, width: number, color: Color): Seg[] {
  return barSegs(progress, width, color, false, '█', '░')
}

function summaryRow(model: ViewModel, width: number, tone: BandTone): Row {
  const plan = model.plan
  const barRow = (label: string, progress: number, color: Color, percentSeg: (text: string) => Seg): Row => {
    const percent = `${Math.round(progress * 100)}%`
    const barWidth = Math.max(1, width - [...label].length - 2 - percent.length)
    return { key: 'summary', segs: line(width, [{ text: label }, space(1), ...cellsOf(progress, barWidth, color), space(1), percentSeg(percent)], [], 0) }
  }
  if (!model.isWorking) {
    if (!hasSteps(plan)) return { key: 'summary', segs: line(width, [{ text: 'no steps recorded (Claude made no task list)', dim: true }], [], 0) }
    const { done, total } = reachedOf(plan)
    const label = `${done} of ${total} ${total === 1 ? 'step' : 'steps'}` + (plan.source === 'answer' ? ' · answer' : '')
    const color = tone === 'done' || tone === 'answered' ? DONE : tone === 'stopped' || tone === 'ended' ? OVER : WARN
    return barRow(label, done / total, color, text => ({ text, color, bold: true }))
  }
  if (!hasSteps(plan)) {
    // No task list: no steps and no percent, only the clock
    return { key: 'summary', segs: line(width, [{ text: `working · ${durationOf(model.elapsedMs)}`, color: ACCENT }], [], 0) }
  }
  const est: Estimate = model.estimate ?? { kind: 'indeterminate' }
  const isOver = est.kind === 'range' && est.isOver
  const progress = est.kind === 'range' ? est.progress : 0
  return barRow(stepCounterOf(plan), progress, isOver ? OVER : ACCENT, text => (isOver ? { text, dim: true } : { text, color: ACCENT, bold: true }))
}

/**
 * The word after a step's bar, as the reference draws them: Done; the step
 * under way's own percent once it has any, else Working; Next for the step
 * after it, Up next for the rest.
 */
function stateWordOf(item: Milestone, index: number, firstPending: number, isWorking: boolean, progress: number): Seg {
  if (item.state === 'done') return { text: 'Done', ...(isWorking ? { dim: true } : {}) }
  if (!isWorking) return { text: 'Not reached', dim: true }
  if (item.state === 'current') return { text: progress > 0 ? `${Math.round(progress * 100)}%` : 'Working', color: ACCENT, bold: true }
  return { text: index === firstPending ? 'Next' : 'Up next', dim: true }
}

function stepRows(model: ViewModel, width: number, tone: BandTone): Row[] {
  const plan = model.plan
  if (!plan || plan.items.length === 0) return []
  const items = plan.items
  const current = currentIndexOf(plan)
  const firstPending = items.findIndex((item, i) => item.state === 'pending' && i > current)
  const start = items.length <= MAX_STEP_ROWS ? 0 : Math.max(0, Math.min(current - 1, items.length - MAX_STEP_ROWS))
  const shown = items.slice(start, start + MAX_STEP_ROWS)
  const isWide = width + FRAME >= NARROW_BODY
  const wordWidth = 'Not reached'.length
  // The bars sit in one column, a fixed share of the width, whatever the
  // labels' lengths (frames 20 and 26); a longer label is cut
  const labelWidth = isWide
    ? Math.max(8, Math.min(Math.floor(width * LABEL_SHARE), width - 2 - 2 - MINI_BAR - 2 - wordWidth))
    : Math.max(4, Math.min(Math.max(...shown.map(item => [...item.label].length)), width - 2 - 2 - wordWidth))
  const stepProgress = model.estimate?.kind === 'range' ? model.estimate.stepProgress : []

  const rows = shown.map((item, offset): Row => {
    const i = start + offset
    const glyph: Seg =
      item.state === 'done'
        ? { text: '✓', color: DONE }
        : item.state === 'current' && model.isWorking
          ? { text: '●', color: ACCENT }
          : { text: '○', dim: true }
    const label = truncate(item.label, labelWidth).padEnd(labelWidth)
    const labelSeg: Seg =
      item.state === 'current' && model.isWorking ? { text: label, bold: true } : item.state === 'pending' ? { text: label, dim: true } : { text: label }
    const progress = item.state === 'current' ? (stepProgress[i] ?? 0) : 0
    const word = stateWordOf(item, i, firstPending, model.isWorking, progress)
    let bar: Seg[] = []
    if (isWide) {
      const doneColor = tone === 'working' || tone === 'over' || tone === 'done' || tone === 'answered' ? DONE : OVER
      bar =
        item.state === 'done'
          ? cellsOf(1, MINI_BAR, doneColor)
          : item.state === 'current' && model.isWorking
            ? cellsOf(progress, MINI_BAR, tone === 'over' ? OVER : ACCENT)
            : cellsOf(0, MINI_BAR, OVER)
      bar = [...bar, space(2)]
    }
    return { key: `step-${i}`, segs: line(width, [glyph, space(1), labelSeg, space(2), ...bar, word], [], 0) }
  })
  if (items.length > MAX_STEP_ROWS) {
    rows.push({ key: 'more', segs: line(width, [{ text: `+${items.length - MAX_STEP_ROWS} more`, dim: true }], [], 0) })
  }
  return rows
}

/**
 * The rule the reference draws just above the prompt with the view's name at
 * its right end: `──────── Clean View ─`, the band's full width.
 */
export function dividerRow(columns: number, label: string): Row {
  const tail = ` ${label} ─`
  return { key: 'divider', segs: [{ text: '─'.repeat(Math.max(0, columns - [...tail].length)), dim: true }, { text: tail, dim: true }] }
}

/**
 * The card a finished turn earns. Invariant 13: All done needs all three:
 * every recorded step completed, a receipt after the last edit, and no
 * refutation from the cross-check. Scar: green "All done" over 2 of 5 steps.
 */
function toneOf(model: ViewModel): BandTone {
  if (model.isWorking) return model.estimate?.kind === 'range' && model.estimate.isOver ? 'over' : 'working'
  const finished = model.finished
  if (!finished) return 'done'
  if (finished.isAborted) return 'stopped'
  if (finished.crossCheck?.state === 'refuted') return 'refuted'
  if (finished.ledger === 'failed') return 'unverified'
  const plan = model.plan
  if (plan && plan.source === 'tasks' && plan.items.some(item => item.state !== 'done')) return 'ended'
  if (!finished.hasWork) return 'answered'
  if (finished.ledger === 'unverified') return finished.claimsDone ? 'unverified' : 'ended'
  return 'done'
}

const BORDER: Record<BandTone, Color> = {
  working: ACCENT,
  over: OVER,
  done: DONE,
  answered: DONE,
  ended: OVER,
  unverified: WARN,
  refuted: WARN,
  stopped: OVER,
}

/** The receipt row: the line under the answer, coloured by what it says. */
function receiptRow(receipt: string, width: number): Row {
  const color = receipt.startsWith('receipt') ? DONE : WARN
  return { key: 'receipt', segs: line(width, [{ text: receipt, color, grow: true }], [], 0) }
}

function crossCheckRow(check: CrossCheck, width: number): Row {
  const seg: Seg =
    check.state === 'confirmed'
      ? { text: crossCheckRowOf(check), color: DONE, grow: true }
      : check.state === 'refuted'
        ? { text: crossCheckRowOf(check), color: WARN, grow: true }
        : { text: crossCheckRowOf(check), dim: true, grow: true }
  return { key: 'cross-check', segs: line(width, [seg], [], 0) }
}

/**
 * The band: title, summary, one row per step (six at most, then `+n more`),
 * the receipt row and the cross-check row once the turn ended, the basis
 * tooltip when asked, and a failing calibration score, which is never folded
 * away (invariant 3). Collapsed, the title row alone. `columns` is the
 * band's body width.
 */
export function bandView(model: ViewModel, columns: number, options: BandOptions): BandView {
  const width = innerWidthOf(columns)
  const tone = toneOf(model)
  const rows: Row[] = [titleRow(model, width, tone)]
  if (!options.collapsed) {
    rows.push(summaryRow(model, width, tone), ...stepRows(model, width, tone))
    const finished = model.isWorking ? null : model.finished
    if (finished?.receipt) rows.push(receiptRow(finished.receipt, width))
    if (finished?.crossCheck) rows.push(crossCheckRow(finished.crossCheck, width))
    if (options.showBasis) {
      const basis = model.isWorking && model.estimate ? (basisLines(model.estimate)[0] ?? '') : ''
      const text = [basis, model.calibration[0] ?? ''].filter(Boolean).join(' · ')
      rows.push({ key: 'basis', segs: line(width, [{ text, dim: true, grow: true }], [], 0) })
    }
    const warning = model.calibration[1]
    if (warning) rows.push({ key: 'calibration', segs: line(width, [{ text: warning, color: WARN, grow: true }], [], 0) })
  }
  return { tone, border: BORDER[tone], rows }
}

// ---- the tools panel ------------------------------------------------------

/** The model chips, labelled as the reference panel labels them (frame 14). */
export const MODEL_CHOICES = [
  { value: 'haiku', label: 'Haiku 4.5' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'fable', label: 'Fable 5.1' },
] as const

export const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
] as const

/** The panel's widest, border and padding included (frame 14: about 67 columns). */
export const TOOLS_COLUMNS = 67

/**
 * How much of the transcript the mod draws away. `off`: every row as Claude
 * Code draws it. `clean`: tool rows one dim line, milestones in full.
 * `quiet`: tool rows nothing, milestones one dim line, and the chrome a turn
 * scatters (spinner, progress, notices, hand-backs, interim text) folded.
 */
export type RowsLevel = 'off' | 'clean' | 'quiet'
export const ROWS_LEVELS: readonly RowsLevel[] = ['off', 'clean', 'quiet']
const ROWS_LABEL: Record<RowsLevel, string> = { off: 'Off', clean: 'Clean', quiet: 'Quiet' }

export type ToolsModel = {
  /** What `$.session.model()` answered. */
  model: string
  /** The effort level last seen on a model request, if any. */
  effort?: string
  rows: RowsLevel
  crossCheck: boolean
  spike: boolean
  /** Fold subagent hand-backs and peer messages at the quiet level. */
  chatter: boolean
  /** Every mod's published switches, receipts first. */
  mods: readonly Switch[]
}

/**
 * The alias a model name answers to: `claude-opus-5-5[1m]` is `opus`.
 */
export function aliasOf(model: string): string | undefined {
  const name = model.toLowerCase()
  return MODEL_CHOICES.find(choice => name.includes(choice.value))?.value
}

function spaced(text: string): string {
  return [...text.toUpperCase()].join(' ')
}

function chipRow(key: string, header: string, choices: readonly { value: string; label: string }[], current: string | undefined, color: Color, width: number): Row {
  const segs: Seg[] = [{ text: header.padEnd(10), dim: true }]
  choices.forEach((choice, i) => {
    if (i > 0) segs.push(space(2))
    if (choice.value === current) segs.push({ text: ` ${choice.label} `, color, inverse: true, bold: true })
    else segs.push(buttonSeg(`${key}-${choice.value}`, choice.label, undefined, false))
  })
  return { key, segs: line(width, segs, [], 0) }
}

/** A dot, a name, a dim description, and the toggle at the right end. */
function settingRow(key: string, rowKey: string, name: string, help: string, isOn: boolean, toggle: string, width: number): Row {
  const left: Seg[] = [isOn ? { text: '●', color: DONE } : { text: '○', dim: true }, space(1), { text: name, bold: true }, space(2), { text: help, dim: true, grow: true }]
  return { key: rowKey, segs: line(width, left, [buttonSeg(key, toggle, undefined, !isOn)]) }
}

function ruleOf(title: string, width: number): Row {
  const head = `──  ${spaced(title)}  `
  return { key: `rule-${title}`, segs: [{ text: truncate(head, width), dim: true }, { text: '─'.repeat(Math.max(0, width - [...head].length)), dim: true }] }
}

function blank(key: string, width: number): Row {
  return { key, segs: [space(width)] }
}

/**
 * The tools panel, laid out as the reference panel (frame 14): a
 * letter-spaced title with the model and effort at the right, MODEL and
 * EFFORT chips with the current one highlighted and not pressable, SETTINGS
 * rows, the MODS switches other mods publish, and LAUNCH actions.
 * `width` is the panel's inner width.
 */
export function toolsView(model: ToolsModel, width: number): Row[] {
  const alias = aliasOf(model.model)
  const modelLabel = MODEL_CHOICES.find(choice => choice.value === alias)?.label ?? (model.model || 'model unknown')
  const effort = model.effort?.toLowerCase()
  const effortLabel = effort ? (EFFORT_CHOICES.find(choice => choice.value === effort)?.label ?? effort) : null
  const status = [modelLabel, effortLabel].filter(Boolean).join(' · ')
  const onOff = (isOn: boolean) => (isOn ? 'On' : 'Off')
  const rows: Row[] = [
    {
      key: 'tools-head',
      segs: lineRight(width, [{ text: '◆ ', color: ACCENT }, { text: `${spaced("Shawn's")}   ${spaced('tools')}`, color: ACCENT, bold: true }], [{ text: status, dim: true, grow: true }]),
    },
    blank('tools-gap-1', width),
    chipRow('model', 'MODEL', MODEL_CHOICES, alias, ACCENT, width),
    chipRow('effort', 'EFFORT', EFFORT_CHOICES, effort, 'autoAccept', width),
    blank('tools-gap-2', width),
    ruleOf('settings', width),
    blank('tools-gap-3', width),
    settingRow('set-rows', 'set-rows-row', 'Clean View', 'simple checklist', model.rows !== 'off', ROWS_LABEL[model.rows], width),
    settingRow('set-crosscheck', 'set-crosscheck-row', 'Receipts cross-check', 'a second agent re-checks done', model.crossCheck, onOff(model.crossCheck), width),
    settingRow('set-spike', 'set-spike-row', 'Spike', 'sizing agent for new tasks', model.spike, onOff(model.spike), width),
    settingRow('set-chatter', 'set-chatter-row', 'Suppress agent chatter', 'fold subagent hand-backs', model.chatter, onOff(model.chatter), width),
    blank('tools-gap-4', width),
    ruleOf('mods', width),
    blank('tools-gap-5', width),
    ...(model.mods.length > 0
      ? model.mods.map(entry => settingRow(`mod-${entry.id}`, `mod-${entry.id}-row`, entry.label, entry.description, entry.value, onOff(entry.value), width))
      : [{ key: 'mods-none', segs: line(width, [{ text: 'no switches registered', dim: true }], [], 0) }]),
    blank('tools-gap-6', width),
    ruleOf('launch', width),
    blank('tools-gap-7', width),
    {
      key: 'launch',
      segs: line(
        width,
        [
          { text: '✦ ', color: ACCENT },
          buttonSeg('launch-stats', 'Receipts stats', undefined, false),
          space(6),
          { text: '◆ ', color: 'autoAccept' },
          buttonSeg('launch-wrong', 'Mark receipt wrong', undefined, false),
        ],
        [],
        0,
      ),
    },
  ]
  return rows
}

/**
 * Rows inside a round border, as the terminal draws them, for mocks and
 * docs. Plain text has no fill, so an inverted ` cell ` shows as `[cell]`,
 * the same width.
 */
export function framedText(rows: readonly Row[], width: number): string[] {
  const plain = (row: Row) =>
    row.segs.map(seg => (seg.inverse && /^ .* $/.test(seg.text) ? `[${seg.text.slice(1, -1)}]` : seg.text)).join('')
  return [`╭${'─'.repeat(width + 2)}╮`, ...rows.map(row => `│ ${plain(row)} │`), `╰${'─'.repeat(width + 2)}╯`]
}
