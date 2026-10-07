/**
 * The band above the prompt and the settings popover, as rows of styled
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

import { basisLines, durationOf, estimateRow, type Estimate } from './estimator'
import type { Milestone, Plan } from './milestones'
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
export const MINI_BAR = 12
export const MAX_STEP_ROWS = 6
const MIN_BAR = 8
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

export type BandTone = 'working' | 'over' | 'done' | 'ended' | 'unverified' | 'stopped'

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

// ---- receipts on the card ---------------------------------------------------

type Verdict =
  | { kind: 'none' }
  | { kind: 'verified'; label: string }
  | { kind: 'failed'; text: string }
  | { kind: 'unverified'; text: string; short: string }

/**
 * Reads the receipt line `ledger.receiptLine` wrote back into what the card
 * needs: `receipt · bun test ✓ 152 pass · 1m ago` is verified, labelled
 * `bun test 152 pass`; a ✗ is a failed check; UNVERIFIED is unverified.
 */
export function verdictOf(receipt: string | null): Verdict {
  if (!receipt) return { kind: 'none' }
  if (receipt.startsWith('UNVERIFIED')) {
    const text = receipt.replace(/^UNVERIFIED · /, '')
    const where = /\((.+) at (\d{1,2}:\d{2})\)$/.exec(text)
    return { kind: 'unverified', text, short: where ? `${where[1]} at ${where[2]}, no check after` : text }
  }
  const body = receipt.replace(/^receipt · /, '').replace(/ · \d+[smh] ago$/, '')
  if (body.includes('✗')) return { kind: 'failed', text: body }
  return { kind: 'verified', label: body.replace(' ✓', '').replace(/\s+/g, ' ').trim() }
}

// ---- the band ---------------------------------------------------------------

function currentIndexOf(plan: Plan): number {
  return plan.items.findIndex(item => item.state === 'current')
}

function reachedOf(plan: Plan | null): { done: number; total: number } {
  const items = plan?.items ?? []
  return { done: items.filter(item => item.state === 'done').length, total: items.length }
}

/** Every step done, or no steps at all to fall short of. */
function isAllDone(plan: Plan | null): boolean {
  const { done, total } = reachedOf(plan)
  return done === total
}

function stepCounterOf(plan: Plan | null): string {
  if (!plan || plan.items.length === 0) return 'Planning'
  const n = plan.items.length
  const current = currentIndexOf(plan)
  const done = plan.items.filter(item => item.state === 'done').length
  const i = current === -1 ? Math.min(done + 1, n) : current + 1
  return `Step ${i} of ${n}` + (plan.source === 'derived' ? ' · derived' : '')
}

function titleRow(model: ViewModel, width: number, options: BandOptions, tone: BandTone, verdict: Verdict): Row {
  const title = model.title.replace(/\s+/g, ' ').trim() || 'continuing'
  const buttons = [buttonSeg('basis', 'basis', 'b'), space(2), buttonSeg('tools-toggle', 'tools', 't'), space(2)]
  // Not [-]: Claude Code draws its own [-] beside the band, which hides it
  // whole; this one folds to the title row
  const collapse = buttonSeg('collapse', options.collapsed ? '[▸]' : '[▾]', undefined, false)
  if (tone === 'working' || tone === 'over') {
    const left: Seg[] = [{ text: '✶ ', color: ACCENT, bold: true }, { text: title, bold: true, grow: true }]
    return { key: 'title', segs: line(width, left, [...buttons, { text: durationOf(model.elapsedMs) }, space(1), collapse]) }
  }
  const waiting = model.finished?.waitingAgents ?? 0
  const took = `took ${durationOf(model.finished?.totalMs ?? model.elapsedMs)}`
  const tail: Seg[] = waiting > 0 ? [{ text: `waiting on ${waiting} ${waiting === 1 ? 'agent' : 'agents'}`, color: WARN }, space(2)] : []
  let badge: Seg
  let text: Seg
  switch (verdict.kind) {
    case 'unverified': {
      // The file is the point: when the whole receipt does not fit, the
      // path-first form does, so the cut never lands on the path
      badge = { text: ' ⚠ Done, unverified ', color: WARN, inverse: true, bold: true }
      const room = width - [...badge.text].length - 1 - 2 - widthOf([...tail, ...buttons, { text: took }, space(1), collapse])
      text = { text: [...verdict.text].length <= room ? verdict.text : verdict.short, color: WARN, grow: true }
      break
    }
    case 'failed':
      badge = { text: ' ✗ Done, checks failed ', color: WARN, inverse: true, bold: true }
      text = { text: verdict.text, color: WARN, grow: true }
      break
    case 'verified':
      badge = { text: ` ✓ All done · ${verdict.label} `, color: DONE, inverse: true, bold: true }
      text = { text: title, color: DONE, grow: true }
      break
    default:
      if (tone === 'stopped') {
        badge = { text: ' ■ Stopped ', color: OVER, inverse: true, bold: true }
        text = { text: title, dim: true, grow: true }
      } else if (tone === 'ended') {
        // Steps left when the turn ended: say how far it got, never "done".
        // Scar: a green card over three steps that never ran, read as finished
        const { done, total } = reachedOf(model.plan)
        badge = { text: ` ■ Turn ended · ${done} of ${total} ${total === 1 ? 'step' : 'steps'} reached `, color: OVER, inverse: true, bold: true }
        text = { text: title, grow: true }
      } else {
        badge = { text: ' ✓ All done ', color: DONE, inverse: true, bold: true }
        text = { text: title, color: DONE, grow: true }
      }
  }
  return { key: 'title', segs: line(width, [badge, space(1), text], [...tail, ...buttons, { text: took }, space(1), collapse]) }
}

function summaryRow(model: ViewModel, width: number, tone: BandTone): Row {
  const plan = model.plan
  if (!model.isWorking) {
    const n = plan?.items.length ?? 0
    const done = plan?.items.filter(item => item.state === 'done').length ?? 0
    const label = `${done} of ${n} ${n === 1 ? 'step' : 'steps'}` + (plan?.source === 'derived' ? ' · derived' : '')
    const progress = n === 0 ? 1 : done / n
    const percent = `${Math.round(progress * 100)}%`.padStart(4)
    const color = tone === 'done' ? DONE : tone === 'stopped' || tone === 'ended' ? OVER : WARN
    const barWidth = Math.max(1, width - [...label].length - 2 - percent.length)
    return {
      key: 'summary',
      segs: line(width, [{ text: label }, space(1), ...barSegs(progress, barWidth, color), space(1), { text: percent, color, bold: true }], [], 0),
    }
  }
  const est: Estimate = model.estimate ?? { kind: 'indeterminate' }
  const isOver = est.kind === 'range' && est.isOver
  const progress = est.kind === 'range' ? est.progress : 0
  const label = stepCounterOf(plan)
  const percent = `${Math.round(progress * 100)}%`.padStart(4)
  let tail = estimateRow(est)
  const fixed = [...label].length + 1 + 1 + percent.length
  let barWidth = width - fixed - 2 - [...tail].length
  if (barWidth < MIN_BAR) {
    const tailRoom = width - fixed - 2 - MIN_BAR
    tail = tailRoom >= MIN_TAIL ? truncate(tail, tailRoom) : ''
    barWidth = width - fixed - (tail ? 2 + [...tail].length : 0)
  }
  const barColor = isOver ? OVER : ACCENT
  const segs: Seg[] = [
    { text: label },
    space(1),
    ...barSegs(progress, Math.max(1, barWidth), barColor),
    space(1),
    isOver ? { text: percent, dim: true } : { text: percent, color: ACCENT, bold: true },
    ...(tail ? [space(2), { text: tail, dim: true }] : []),
  ]
  return { key: 'summary', segs: line(width, segs, [], 0) }
}

function stateWordOf(item: Milestone, index: number, firstPending: number, isWorking: boolean): Seg {
  if (item.state === 'done') return { text: 'Done', ...(isWorking ? { dim: true } : {}) }
  if (!isWorking) return { text: 'Not reached', dim: true }
  if (item.state === 'current') return { text: 'Working', color: ACCENT, bold: true }
  return { text: index === firstPending ? 'Next' : 'Later', dim: true }
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
  const longest = Math.max(...shown.map(item => [...item.label].length))
  const wordWidth = 'Not reached'.length
  const labelWidth = isWide
    ? Math.max(8, Math.min(longest, Math.floor(width * 0.4), width - 2 - 2 - MINI_BAR - 2 - wordWidth))
    : Math.max(4, Math.min(longest, width - 2 - 2 - wordWidth))
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
    const word = stateWordOf(item, i, firstPending, model.isWorking)
    let bar: Seg[] = []
    if (isWide) {
      const doneColor = tone === 'working' || tone === 'over' || tone === 'done' ? DONE : OVER
      bar =
        item.state === 'done'
          ? barSegs(1, MINI_BAR, doneColor, false, '█', '░')
          : item.state === 'current' && model.isWorking
            ? barSegs(stepProgress[i] ?? 0, MINI_BAR, tone === 'over' ? OVER : ACCENT, false, '█', '░')
            : barSegs(0, MINI_BAR, OVER, false, '█', '░')
      bar = [...bar, space(2)]
    }
    return { key: `step-${i}`, segs: line(width, [glyph, space(1), labelSeg, space(2), ...bar, word], [], 0) }
  })
  if (items.length > MAX_STEP_ROWS) {
    rows.push({ key: 'more', segs: line(width, [{ text: `+${items.length - MAX_STEP_ROWS} more`, dim: true }], [], 0) })
  }
  return rows
}

function toneOf(model: ViewModel, verdict: Verdict): BandTone {
  if (model.isWorking) return model.estimate?.kind === 'range' && model.estimate.isOver ? 'over' : 'working'
  if (model.finished?.isAborted) return 'stopped'
  if (verdict.kind === 'unverified' || verdict.kind === 'failed') return 'unverified'
  return isAllDone(model.plan) ? 'done' : 'ended'
}

const BORDER: Record<BandTone, Color> = {
  working: ACCENT,
  over: OVER,
  done: DONE,
  ended: OVER,
  unverified: WARN,
  stopped: OVER,
}

/**
 * The band: title, summary, one row per step (six at most, then `+n more`),
 * the basis tooltip when asked, and a failing calibration score, which is
 * never folded away (invariant 3: a bad score is displayed, not hidden).
 * Collapsed, the title row alone. `columns` is the band's body width.
 */
export function bandView(model: ViewModel, columns: number, options: BandOptions): BandView {
  const width = innerWidthOf(columns)
  const verdict = model.isWorking ? ({ kind: 'none' } as const) : verdictOf(model.finished?.receipt ?? null)
  const tone = toneOf(model, verdict)
  const rows: Row[] = [titleRow(model, width, options, tone, verdict)]
  if (!options.collapsed) {
    rows.push(summaryRow(model, width, tone), ...stepRows(model, width, tone))
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

// ---- the settings popover ---------------------------------------------------

export const MODEL_CHOICES = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'fable', label: 'Fable' },
] as const

export const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
] as const

/** The popover's widest, border and padding included. */
export const TOOLS_COLUMNS = 64

/**
 * How much of the transcript the mod draws away. `off`: every row as Claude
 * Code draws it. `clean`: tool rows one dim line, milestones in full.
 * `quiet`: tool rows nothing, milestones one dim line, and the chrome a turn
 * scatters (spinner, progress, notices, hand-backs, interim text) folded.
 */
export type RowsLevel = 'off' | 'clean' | 'quiet'
export const ROWS_LEVELS: readonly RowsLevel[] = ['off', 'clean', 'quiet']

export const ROWS_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'clean', label: 'Clean' },
  { value: 'quiet', label: 'Quiet' },
] as const

export type ToolsModel = {
  /** What `$.session.model()` answered. */
  model: string
  /** The effort level last seen on a model request, if any. */
  effort?: string
  rows: RowsLevel
  spike: boolean
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

function chipRow(key: string, header: string, choices: readonly { value: string; label: string }[], current: string | undefined, width: number): Row {
  const segs: Seg[] = [{ text: spaced(header).padEnd(13), dim: true }]
  choices.forEach((choice, i) => {
    if (i > 0) segs.push(space(1))
    if (choice.value === current) segs.push({ text: ` ${choice.label} `, color: ACCENT, inverse: true, bold: true })
    else segs.push(space(1), buttonSeg(`${key}-${choice.value}`, choice.label, undefined, false), space(1))
  })
  return { key, segs: line(width, segs, [], 0) }
}

function settingRow(key: string, name: string, help: string, isOn: boolean, width: number): Row {
  const left: Seg[] = [
    isOn ? { text: '●', color: DONE } : { text: '○', dim: true },
    space(1),
    { text: name.padEnd(19), bold: true },
    { text: help, dim: true, grow: true },
  ]
  return { key: `${key}-row`, segs: line(width, left, [buttonSeg(key, isOn ? 'On' : 'Off', undefined, !isOn)]) }
}

function ruleOf(prefix: string, width: number): Seg[] {
  const head = truncate(prefix, width)
  return [{ text: head, dim: true }, { text: '─'.repeat(Math.max(0, width - [...head].length)), dim: true }]
}

/**
 * The settings popover: model and effort chips (the current one inverted and
 * not pressable), letter-spaced headers, and the mod's three switches.
 * `width` is the popover's inner width.
 */
export function toolsView(model: ToolsModel, width: number): Row[] {
  const alias = aliasOf(model.model)
  const effort = model.effort?.toLowerCase()
  const status = [model.model || 'model unknown', effort ? (EFFORT_CHOICES.find(c => c.value === effort)?.label ?? effort) : null].filter(Boolean).join(' · ')
  return [
    {
      key: 'tools-head',
      segs: line(
        width,
        [{ text: '◆ ', color: ACCENT }, { text: spaced('receipts'), color: ACCENT, bold: true }],
        [{ text: truncate(status, Math.max(4, width - 26)), dim: true }, space(1), buttonSeg('tools-close', '[-]', undefined, false)],
      ),
    },
    chipRow('model', 'model', MODEL_CHOICES, alias, width),
    chipRow('effort', 'effort', EFFORT_CHOICES, effort, width),
    chipRow('rows', 'rows', ROWS_CHOICES, model.rows, width),
    { key: 'tools-rule', segs: ruleOf(`── ${spaced('settings')} `, width) },
    settingRow('set-spike', 'Spike', 'sizing subagent, new tasks', model.spike, width),
  ]
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
