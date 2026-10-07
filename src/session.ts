/**
 * One session's receipts: the task under way, the history it learns into,
 * and the view model the pane and band draw. Hooks call in through a Host,
 * never `$` (see host.ts).
 *
 * Invariant 6, hooks return fast: every model call here starts unawaited
 * (plan derivation, task type, step-done, the spike) except the claims-done
 * label on turn.complete, which waits at most CLAIMS_DEADLINE_MS and then
 * falls back to plain words in the answer. Results are cached per step per
 * turn, so a long turn costs one classify per model step at most.
 */

import { estimate, type Estimate } from './estimator'
import {
  addTask,
  bucketSamples,
  calibrationLines,
  calibrationOf,
  emptyHistory,
  HISTORY_KEY,
  parseHistory,
  statsOf,
  type History,
  type Stats,
} from './history'
import type { Host } from './host'
import {
  emptyLedger,
  exitCodeOf,
  isVerifyCommand,
  looksDone,
  receiptLine,
  recordEdit,
  recordVerify,
  type Ledger,
  type ToolOutcome,
} from './ledger'
import {
  completeAtEnd,
  completeCurrent,
  derivedPlan,
  editedPathOf,
  emptyPlan,
  fallbackPlan,
  finishPlan,
  isComplete,
  isEditTool,
  isMilestoneCommand,
  isSubagentTool,
  onTaskCreate,
  onTaskUpdate,
  onTodoWrite,
  parseDerivedSteps,
  stepDurations,
  type Pause,
  type Plan,
  type TaskUpdateArgs,
  type Todo,
} from './milestones'
import {
  countTool,
  NO_TOOLS,
  repoHashOf,
  stepBucketOf,
  TASK_TYPES,
  toolMixOf,
  type Shape,
  type TaskType,
  type ToolCounts,
} from './shape'
import { parseSpike, SPIKE_AGENT, SPIKE_MIN_STEPS, SPIKE_MODEL, SPIKE_TIMEOUT_MS, spikePromptOf } from './spike'
import type { ViewModel } from './view'

export const PANE_ID = 'receipts'
export const PANE_TITLE = 'receipts'
export const CLAIMS_DEADLINE_MS = 1_500
export const TICK_MS = 1_000
export const CLAIMS_LABELS = ['claims-done', 'not-claiming-done'] as const
export const STEP_LABELS = ['step-done', 'step-not-done'] as const
/** Task types whose steps are cheap: a spike would cost more than it tells. */
export const NO_SPIKE_TYPES: readonly string[] = ['research', 'writing', 'chat']
export const AUDIT_KEY = 'audit'
const STEPS_DONE_SYSTEM =
  'You read the final message of a coding assistant and a list of planned steps not yet marked done. ' +
  'Answer with the numbers of the steps the message shows were completed, comma separated, or "none". No other text.'
const PLAN_MODEL = 'haiku'
const PLAN_TIMEOUT_MS = 20_000
const PLAN_SYSTEM =
  'You read a request to a coding assistant and its first message, and list the plan it is following ' +
  'as 2 to 8 steps, one per line, each a short noun phrase of at most 8 words. No other text.'

export type SessionOptions = {
  spike: boolean
}

type Snapshot = {
  low: number
  high: number
}

type TaskState = {
  turnId: string
  startedAt: number
  prompt: string
  cwd: string
  plan: Plan
  counts: ToolCounts
  ledger: Ledger
  taskType: TaskType
  /** Settles once the task-type label is in (or failed). */
  typed: Promise<void>
  isDeriving: boolean
  isSpiked: boolean
  spike?: readonly number[]
  checkedSteps: Set<number>
  seenEdits: Set<string>
  claims?: Promise<boolean | undefined>
  /** The last range shown while 2 or more steps were left. */
  beforeFinal?: Snapshot
  firstRange?: Snapshot
  /** Permission waits inside the task, subtracted from what is learned. */
  pauses: Pause[]
  /** The session's cost when the task started, for the turn's share. */
  usdAtStart?: number
}

type Audit = {
  /** Receipt lines shown under an answer that claimed done. */
  shown: number
  /** Of those, the ones the person marked wrong with /receipts wrong. */
  wrong: number
}

type StepEvent = {
  turnId: string
  index: number
  agentId?: string
}

type StepResult = {
  answer: string
  toolUses: readonly { name: string }[]
  stopReason: string | null
}

type ToolEvent = {
  tool: string
  tool_use_id: string
}

type CompleteEvent = {
  turnId: string
  answer: string
  isAborted: boolean
  reason: string
}

export class ReceiptsSession {
  private history: History = emptyHistory()
  private stats: Stats = statsOf(this.history)
  private isLoaded = false
  private probing: Promise<void> | null = null
  private repoKey = 'unknown'
  private hasTests = false
  private repoEntries: string[] = []
  private task: TaskState | null = null
  private last: { plan: Plan; prompt: string; totalMs: number; receipt: string | null; isAborted: boolean } | null = null
  /** Agents the main loop started that were still running when its turn ended. */
  private waiting = new Set<string>()
  /** Shapes already spiked this session: one guess per shape is enough. */
  private readonly spikedShapes = new Set<string>()
  private readonly toolStarts = new Map<string, number>()
  private readonly toolEnds = new Map<string, number>()
  private readonly toolRuns = new Map<string, number>()
  private lastTickAt = 0
  private audit: Audit = { shown: 0, wrong: 0 }
  private lastReceipt: { turnId: string; isMarked: boolean } | null = null
  private readonly milestoneIds = new Set<string>()
  private readonly spikeWaiters = new Map<string, TaskState>()
  private ticker: { cancel: () => void } | null = null
  private isPaneOpen = false
  private isPaneShown = false
  private showBasis = false
  private cwd = ''
  private effort: string | undefined

  constructor(private readonly options: SessionOptions) {}

  async start(host: Host): Promise<void> {
    await this.load(host)
    this.probing ??= this.probe(host)
  }

  async turnStart(host: Host, turnId: string, text: string): Promise<void> {
    await this.load(host)
    this.probing ??= this.probe(host)
    const now = await host.now()
    this.cwd = await host.cwd().catch(() => this.cwd)
    const task: TaskState = {
      turnId,
      startedAt: now,
      prompt: text,
      cwd: this.cwd,
      plan: emptyPlan(),
      counts: NO_TOOLS,
      ledger: emptyLedger(),
      taskType: 'unknown',
      typed: Promise.resolve(),
      isDeriving: false,
      isSpiked: false,
      checkedSteps: new Set(),
      seenEdits: new Set(),
      pauses: [],
    }
    this.task = task
    this.last = null
    // The fallback for an agent whose end never reached us: the next prompt
    this.waiting.clear()
    if (text.trim()) {
      task.typed = host
        .classify(text.slice(0, 4_000), TASK_TYPES)
        .then(label => {
          task.taskType = (TASK_TYPES as readonly string[]).includes(label ?? '') ? (label as TaskType) : 'unknown'
        })
        .catch(() => undefined)
    }
    this.startTicker(host, now)
    const usage = await host.usage().catch(() => null)
    if (usage?.cost) task.usdAtStart = usage.cost.usd
    // No pane opens unasked: the band above the prompt is the surface, and
    // `/receipts` opens the pane for the long view. Scar: the auto-opened
    // dock took a third of a fullscreen terminal to show four lines.
    host.redraw()
  }

  /**
   * After each model request: derive a plan if the first step brought no
   * task tools, ask whether the current derived step is done, and start the
   * claims-done label as soon as the final answer exists.
   */
  stepResult(host: Host, e: StepEvent, result: StepResult): void {
    const task = this.task
    if (!task || e.agentId !== undefined || e.turnId !== task.turnId) return
    const usesTaskTools = result.toolUses.some(use => use.name === 'TaskCreate' || use.name === 'TodoWrite')
    if (task.plan.source === 'none' && !task.isDeriving && !usesTaskTools) {
      task.isDeriving = true
      void this.derive(host, task, result.answer)
    }
    const answer = result.answer.trim()
    if (task.plan.source === 'derived' && answer && !task.checkedSteps.has(e.index)) {
      task.checkedSteps.add(e.index)
      void this.checkStep(host, task, answer)
    }
    if (result.stopReason === 'end_turn' && answer && task.ledger.edits.length > 0) {
      task.claims = this.claimsDone(host, answer)
    }
  }

  /**
   * Before a tool runs, decide whether its rows are milestone rows, so they
   * draw in full while running and their result rows (which carry no input)
   * can be told by id: the first edit of each file this turn, a verify run,
   * a commit, a pull request, a subagent.
   */
  beforeTool(e: ToolEvent, input: unknown): void {
    if (this.isMilestoneRow(e.tool_use_id, e.tool, input) && !isEditTool(e.tool)) {
      this.milestoneIds.add(e.tool_use_id)
      return
    }
    const task = this.task
    if (!task || !isEditTool(e.tool)) return
    const path = editedPathOf(e.tool, input)
    if (path === undefined || task.seenEdits.has(path)) return
    task.seenEdits.add(path)
    this.milestoneIds.add(e.tool_use_id)
  }

  async afterTool(host: Host, e: ToolEvent, input: unknown, outcome: ToolOutcome): Promise<void> {
    const task = this.task
    if (!task) return
    const now = await host.now()
    if (this.toolStarts.has(e.tool_use_id)) {
      this.toolEnds.set(e.tool_use_id, now)
      this.settlePause(e.tool_use_id)
    }
    task.counts = countTool(task.counts, e.tool)
    const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    const result = outcome.result as Record<string, unknown> | undefined
    const isOk = outcome.deny === undefined && !outcome.isError
    let isPlanChanged = false

    if (e.tool === 'TaskCreate' && isOk) {
      const created = result?.task as { id?: unknown } | undefined
      if (typeof created?.id === 'string' && typeof fields.subject === 'string') {
        task.plan = onTaskCreate(task.plan, created.id, fields.subject, now)
        isPlanChanged = true
      }
    } else if (e.tool === 'TaskUpdate' && isOk && typeof fields.taskId === 'string') {
      task.plan = onTaskUpdate(task.plan, fields as unknown as TaskUpdateArgs, now)
      isPlanChanged = true
    } else if (e.tool === 'TodoWrite' && isOk && Array.isArray(fields.todos)) {
      task.plan = onTodoWrite(task.plan, fields.todos as Todo[], now)
      isPlanChanged = true
    } else if (isEditTool(e.tool) && isOk) {
      const path = editedPathOf(e.tool, input)
      if (path !== undefined) task.ledger = recordEdit(task.ledger, path, now)
    } else if (e.tool === 'Bash' && outcome.deny === undefined && typeof fields.command === 'string') {
      const interrupted = (result as { interrupted?: unknown } | undefined)?.interrupted === true
      if (isVerifyCommand(fields.command) && !interrupted) {
        const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
        const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
        const output = outcome.text ?? [stdout, stderr].join('\n')
        task.ledger = recordVerify(task.ledger, fields.command, exitCodeOf(outcome), output, now)
      }
    }

    if (isPlanChanged) {
      this.observe(now)
      void this.maybeSpike(host, task)
      host.redraw()
    }
  }

  /**
   * The turn ended: the receipt line, if any, then learning. Never blocks or
   * aborts the turn; at worst it waits CLAIMS_DEADLINE_MS for a label.
   */
  async turnComplete(host: Host, e: CompleteEvent): Promise<string | null> {
    const task = this.task
    if (!task) return null
    // Any main-loop turn.complete ends the task the band shows, even one whose
    // id the band never saw start (a reload, a second copy of the mod). Scar:
    // a band left in Working after the turn had ended. Only a matching id is
    // learned from.
    const isOwn = task.turnId === e.turnId
    this.task = null
    this.ticker?.cancel()
    this.ticker = null
    const now = await host.now()

    // Both labels run at once, under one deadline: the claims-done label, and
    // for a derived plan which of its open steps the final answer completed
    const hasEdits = task.ledger.edits.length > 0 && !e.isAborted
    const [claims, finishedSteps] = await Promise.all([
      hasEdits ? this.withDeadline(host, task.claims ?? this.claimsDone(host, e.answer), CLAIMS_DEADLINE_MS) : Promise.resolve(undefined),
      e.isAborted ? Promise.resolve(undefined) : this.withDeadline(host, this.stepsDoneBy(host, task, e.answer), CLAIMS_DEADLINE_MS),
    ])
    let line: string | null = null
    if (hasEdits) line = receiptLine(task.ledger, claims ?? looksDone(e.answer), now, task.cwd)

    const answered = finishedSteps && finishedSteps.length > 0 ? completeAtEnd(task.plan, finishedSteps, now, task.startedAt) : task.plan
    const plan = finishPlan(answered.source === 'none' ? fallbackPlan(task.startedAt) : answered, now)
    const totalMs = Math.max(0, now - task.startedAt)
    this.last = { plan, prompt: task.prompt, totalMs, receipt: line, isAborted: e.isAborted }
    let shown = line
    if (line) {
      this.audit = { ...this.audit, shown: this.audit.shown + 1 }
      this.lastReceipt = { turnId: task.turnId, isMarked: false }
      await host.storeSet(AUDIT_KEY, this.audit).catch(() => undefined)
      const cost = await this.costOf(host, task)
      if (cost) shown = `${line} · ${cost}`
    }

    // A task-tool plan finished only when every item did; a derived or
    // fallback plan finished when the turn answered.
    const isFinished = plan.source === 'tasks' ? isComplete(plan) : true
    if (isOwn && !e.isAborted && e.reason === 'answer' && isFinished) {
      const range = task.beforeFinal ?? task.firstRange
      // Learned as work: permission waits come out of the steps and the total.
      // Calibration is scored on the wall clock, as the range was shown
      const steps = stepDurations(plan, task.startedAt, task.pauses)
      const paused = task.pauses.reduce((sum, pause) => sum + pause.ms, 0)
      this.history = addTask(this.history, {
        at: now,
        shape: { ...this.shapeOf(task), steps: stepBucketOf(Math.max(1, plan.items.length)) },
        steps,
        totalMs: Math.max(0, totalMs - paused),
        ...(range ? { inside: totalMs >= range.low && totalMs <= range.high } : {}),
      })
      this.stats = statsOf(this.history)
      await host.storeSet(HISTORY_KEY, this.history).catch(() => undefined)
    }
    await this.countWaiting(host)
    host.redraw()
    return shown
  }

  /**
   * One pass over the final answer for a derived plan: which of the steps not
   * yet done does it show were completed? Indexes into the plan; none for a
   * plan of another source, or when nothing is open.
   */
  private async stepsDoneBy(host: Host, task: TaskState, answer: string): Promise<number[]> {
    if (task.plan.source !== 'derived' || !answer.trim()) return []
    const open = task.plan.items.map((item, i) => ({ item, i })).filter(({ item }) => item.state === 'pending')
    if (open.length === 0) return []
    try {
      const reply = await host.complete({
        model: PLAN_MODEL,
        system: STEPS_DONE_SYSTEM,
        prompt: `Steps not yet marked done:\n${open.map(({ item, i }) => `${i + 1}. ${item.label}`).join('\n')}\n\nThe final message:\n${answer.slice(0, 4_000)}`,
        maxTokens: 40,
        timeoutMs: CLAIMS_DEADLINE_MS,
      })
      if (!reply.isAnswered) return []
      const wanted = new Set(open.map(({ i }) => i))
      return [...reply.text.matchAll(/\d+/g)].map(match => Number(match[0]) - 1).filter(i => wanted.has(i))
    } catch {
      return []
    }
  }

  /**
   * What the turn cost, for the receipt line: a plan user's five-hour window
   * and its reset, an API user's dollars this turn, or nothing when neither
   * is known. Never a guess.
   */
  private async costOf(host: Host, task: TaskState): Promise<string | null> {
    const usage = await host.usage().catch(() => null)
    if (!usage) return null
    const window = usage.rateLimits.find(limit => limit.kind === 'five_hour')
    if (window) {
      const resets = window.resetsAt ? new Date(window.resetsAt) : null
      const at = resets && !Number.isNaN(resets.getTime()) ? `, resets ${String(resets.getHours()).padStart(2, '0')}:${String(resets.getMinutes()).padStart(2, '0')}` : ''
      return `5h window ${window.percentUsed}% used${at}`
    }
    if (usage.rateLimits.length === 0 && usage.cost && task.usdAtStart !== undefined) {
      const spent = usage.cost.usd - task.usdAtStart
      if (spent > 0) return `$${spent.toFixed(2)} this turn`
    }
    return null
  }

  /** The person says the last receipt was wrong: one mark per receipt. */
  async markWrong(host: Host): Promise<string> {
    if (!this.lastReceipt) return 'no receipt this session to mark'
    if (this.lastReceipt.isMarked) return 'already marked wrong'
    this.lastReceipt.isMarked = true
    this.audit = { ...this.audit, wrong: this.audit.wrong + 1 }
    await host.storeSet(AUDIT_KEY, this.audit).catch(() => undefined)
    return `marked wrong: ${this.auditLine()}`
  }

  private auditLine(): string {
    const { shown, wrong } = this.audit
    const percent = shown === 0 ? 0 : Math.round((wrong / shown) * 100)
    return `${wrong} of ${shown} ${shown === 1 ? 'receipt' : 'receipts'} marked wrong (${percent}%)`
  }

  /** A tool call began: its start, for the permission wait. */
  toolStarted(toolUseId: string, at: number): void {
    this.toolStarts.set(toolUseId, at)
  }

  /** The tool's own run time, from classic PostToolUse (no prompt or hook time). */
  toolRan(toolUseId: string, ms: number | undefined): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return
    this.toolRuns.set(toolUseId, ms)
    this.settlePause(toolUseId)
  }

  /**
   * Once a call's span and run time are both in: the rest is waiting. Only a
   * wait of a second or more counts, so hook overhead is never a pause.
   */
  private settlePause(toolUseId: string): void {
    const start = this.toolStarts.get(toolUseId)
    const end = this.toolEnds.get(toolUseId)
    const run = this.toolRuns.get(toolUseId)
    if (start === undefined || end === undefined || run === undefined) return
    this.toolStarts.delete(toolUseId)
    this.toolEnds.delete(toolUseId)
    this.toolRuns.delete(toolUseId)
    const wait = end - start - run
    if (wait >= 1_000 && this.task) this.task.pauses.push({ at: end, ms: wait })
  }

  /**
   * After a hot reload the module's timers die while a drawing stays up. A
   * render calls this: when a task is under way and nothing has ticked for
   * two intervals, the ticker starts again.
   */
  ensureTicking(host: Host, now: number): void {
    if (!this.task || now - this.lastTickAt <= 2 * TICK_MS) return
    this.startTicker(host, now)
  }

  private startTicker(host: Host, now: number): void {
    this.ticker?.cancel()
    this.lastTickAt = now
    this.ticker = host.every(TICK_MS, () => {
      void this.tick(host)
    })
  }

  /**
   * The main loop's agents still going: started by the model or the person
   * (not by this mod, so not the spike), not finished.
   */
  private async countWaiting(host: Host): Promise<void> {
    const agents = await host.agents().catch(() => [])
    this.waiting = new Set(
      agents
        .filter(agent => agent.parentId === undefined && agent.spawnedBy !== 'receipts')
        .filter(agent => agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting')
        .map(agent => agent.id),
    )
  }

  /**
   * A subagent's turn ended; if it was this mod's spike, read its guess.
   */
  subagentComplete(host: Host, agentId: string, answer: string): void {
    if (this.waiting.delete(agentId)) host.redraw()
    const task = this.spikeWaiters.get(agentId)
    if (!task) return
    this.spikeWaiters.delete(agentId)
    const guess = parseSpike(answer, task.plan.items.length)
    if (guess && this.task === task) {
      task.spike = guess.stepsMs
      host.redraw()
    }
  }

  // ---- views ---------------------------------------------------------------

  viewModel(now: number): ViewModel {
    const task = this.task
    const est = task ? this.observe(now) : null
    return {
      plan: task ? task.plan : (this.last?.plan ?? null),
      estimate: est,
      isWorking: task !== null,
      showBasis: this.showBasis,
      calibration: calibrationLines(calibrationOf(this.history)),
      title: task ? task.prompt : (this.last?.prompt ?? ''),
      elapsedMs: task ? Math.max(0, now - task.startedAt) : (this.last?.totalMs ?? 0),
      finished: this.last
        ? { totalMs: this.last.totalMs, receipt: this.last.receipt, isAborted: this.last.isAborted, waitingAgents: this.waiting.size }
        : null,
    }
  }

  isMilestoneRow(toolUseId: string, tool: string, input: unknown): boolean {
    if (this.milestoneIds.has(toolUseId)) return true
    if (isEditTool(tool)) return false
    if (isSubagentTool(tool)) return true
    if (tool === 'Bash') {
      const command = (input as { command?: unknown } | null | undefined)?.command
      return typeof command === 'string' && isMilestoneCommand(command)
    }
    return false
  }

  get workingDirectory(): string {
    return this.cwd
  }

  /**
   * The band shows while a task runs, and after it as the completion card
   * until the next prompt, whenever no pane is placed.
   */
  isBandWanted(): boolean {
    return (this.task !== null || this.last !== null) && !this.isPaneShown
  }

  get isWorking(): boolean {
    return this.task !== null
  }

  /** The user's switch for the spike, over the userConfig default. */
  setSpike(isOn: boolean): void {
    this.options.spike = isOn
  }

  get isSpikeOn(): boolean {
    return this.options.spike
  }

  /** The effort level the last main-loop model request carried. */
  noteEffort(effort: string | number | undefined): void {
    if (typeof effort === 'string') this.effort = effort
  }

  get effortLevel(): string | undefined {
    return this.effort
  }

  paneDrawn(): void {
    this.isPaneShown = true
    this.isPaneOpen = true
  }

  paneClosed(): void {
    this.isPaneShown = false
    this.isPaneOpen = false
  }

  get paneOpen(): boolean {
    return this.isPaneOpen
  }

  paneOpened(isPlaced: boolean): void {
    this.isPaneOpen = true
    this.isPaneShown = isPlaced
  }

  toggleBasis(): void {
    this.showBasis = !this.showBasis
  }

  get isBasisShown(): boolean {
    return this.showBasis
  }

  // ---- commands ------------------------------------------------------------

  statsText(): string {
    const tasks = this.history.tasks
    const audit = `receipts: ${this.auditLine()}; mark a wrong one with /receipts wrong`
    if (tasks.length === 0) return ['no finished tasks yet; the estimate runs on its prior until a few land', audit].join('\n')
    const byType = new Map<string, number[]>()
    for (const task of tasks) {
      const list = byType.get(task.shape.taskType) ?? []
      list.push(task.totalMs)
      byType.set(task.shape.taskType, list)
    }
    const rows = [...byType.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([type, list]) => `${type} ${list.length} (median ${minutesOf(medianOf(list))})`)
    return [
      `${tasks.length} finished ${tasks.length === 1 ? 'task' : 'tasks'} in history`,
      ...calibrationLines(calibrationOf(this.history)),
      `by type: ${rows.join(', ')}`,
      audit,
    ].join('\n')
  }

  async resetHistory(host: Host): Promise<number> {
    const count = this.history.tasks.length
    await host.storeDelete(HISTORY_KEY)
    this.history = emptyHistory()
    this.stats = statsOf(this.history)
    host.redraw()
    return count
  }

  // ---- internals -----------------------------------------------------------

  private async load(host: Host): Promise<void> {
    if (this.isLoaded) return
    this.isLoaded = true
    const raw = await host.storeGet(HISTORY_KEY).catch(() => undefined)
    this.history = parseHistory(raw)
    const audit = (await host.storeGet(AUDIT_KEY).catch(() => undefined)) as Partial<Audit> | undefined
    if (typeof audit?.shown === 'number' && typeof audit.wrong === 'number') this.audit = { shown: audit.shown, wrong: audit.wrong }
    this.stats = statsOf(this.history)
  }

  private async probe(host: Host): Promise<void> {
    try {
      const repo = await host.repo().catch(() => null)
      const root = repo?.root ?? (await host.cwd())
      this.repoKey = repoHashOf(root)
      const entries = await host.list(root).catch(() => [])
      const names = entries.map(entry => entry.name)
      this.repoEntries = names.slice(0, 40)
      this.hasTests = names.some(name => /^(tests?|__tests__|specs?)$/.test(name) || /\.(test|spec)\.\w+$/.test(name))
    } catch {
      // Unknown repo: the shape still works, it just learns under 'unknown'
    }
  }

  private shapeOf(task: TaskState): Shape {
    return {
      taskType: task.taskType,
      steps: stepBucketOf(Math.max(1, task.plan.items.length)),
      repo: this.repoKey,
      hasTests: this.hasTests,
      mix: toolMixOf(task.counts),
    }
  }

  private estimateOf(task: TaskState, now: number): Estimate {
    return estimate({
      now,
      startedAt: task.startedAt,
      plan: task.plan,
      stats: this.stats,
      shape: this.shapeOf(task),
      ...(task.spike ? { spike: task.spike } : {}),
    })
  }

  /**
   * Computes the estimate for now and keeps the ranges calibration is scored
   * against: the first one shown, and the last one shown before the final step.
   */
  private observe(now: number): Estimate | null {
    const task = this.task
    if (!task) return null
    const est = this.estimateOf(task, now)
    if (est.kind === 'range') {
      const snapshot = { low: est.totalLowMs, high: est.totalHighMs }
      task.firstRange ??= snapshot
      const left = task.plan.items.filter(item => item.state !== 'done').length
      if (left >= 2) task.beforeFinal = snapshot
    }
    return est
  }

  private async tick(host: Host): Promise<void> {
    if (!this.task) return
    const now = await host.now()
    this.lastTickAt = now
    this.observe(now)
    host.redraw()
  }

  private async derive(host: Host, task: TaskState, firstText: string): Promise<void> {
    let labels: string[] = []
    if (task.prompt.trim()) {
      try {
        const reply = await host.complete({
          model: PLAN_MODEL,
          system: PLAN_SYSTEM,
          prompt: `The request:\n${task.prompt.slice(0, 4_000)}\n\nThe assistant's first message:\n${firstText.slice(0, 2_000) || '(none yet)'}`,
          maxTokens: 300,
          timeoutMs: PLAN_TIMEOUT_MS,
        })
        if (reply.isAnswered) labels = parseDerivedSteps(reply.text)
      } catch {
        // No plan from the model: fall back to the single milestone
      }
    }
    // Task tools may have arrived meanwhile; they win
    if (this.task !== task || task.plan.source !== 'none') return
    task.plan = labels.length > 0 ? derivedPlan(labels, task.startedAt) : fallbackPlan(task.startedAt)
    this.observe(await host.now())
    void this.maybeSpike(host, task)
    host.redraw()
  }

  private async checkStep(host: Host, task: TaskState, answer: string): Promise<void> {
    const current = task.plan.items.find(item => item.state === 'current')
    if (!current) return
    const label = await host
      .classify(`Planned step: "${current.label}"\n\nThe assistant's latest message:\n${answer.slice(0, 3_000)}`, STEP_LABELS)
      .catch(() => undefined)
    if (label !== 'step-done' || this.task !== task) return
    if (task.plan.items.find(item => item.state === 'current')?.id !== current.id) return
    const now = await host.now()
    task.plan = completeCurrent(task.plan, now)
    this.observe(now)
    host.redraw()
  }

  private claimsDone(host: Host, answer: string): Promise<boolean | undefined> {
    return host
      .classify(`The final message of a coding assistant to its user:\n${answer.slice(0, 4_000)}`, CLAIMS_LABELS)
      .then(label => (label === 'claims-done' ? true : label === 'not-claiming-done' ? false : undefined))
      .catch(() => undefined)
  }

  /**
   * Once per task, for an unfamiliar shape with a plan of SPIKE_MIN_STEPS or
   * more, and only when the user has not turned the spike off.
   */
  private async maybeSpike(host: Host, task: TaskState): Promise<void> {
    if (!this.options.spike || task.isSpiked) return
    if (task.plan.items.length < SPIKE_MIN_STEPS) return
    if (task.plan.source === 'none' || task.plan.source === 'fallback') return
    task.isSpiked = true
    await Promise.all([this.probing, task.typed])
    if (bucketSamples(this.stats, this.shapeOf(task)) >= 3) return
    // Once per shape per session, and never for cheap task types. Scar: a
    // cheap subagent per prompt in an unfamiliar repo (the 0.2.0 live run)
    if (NO_SPIKE_TYPES.includes(task.taskType)) return
    const shape = this.shapeOf(task)
    const shapeKey = `${shape.taskType}|${shape.steps}|${shape.repo}`
    if (this.spikedShapes.has(shapeKey)) return
    this.spikedShapes.add(shapeKey)
    try {
      const spawned = await host.spawn({
        prompt: spikePromptOf(task.prompt, task.plan.items.map(item => item.label), this.repoEntries),
        description: 'receipts: size this task',
        model: SPIKE_MODEL,
        subagentType: SPIKE_AGENT,
      })
      if (spawned.deny !== undefined || spawned.agentId === undefined) return
      const agentId = spawned.agentId
      this.spikeWaiters.set(agentId, task)
      host.after(SPIKE_TIMEOUT_MS, () => {
        this.spikeWaiters.delete(agentId)
      })
    } catch {
      // A refused or failed spike leaves the prior in place
    }
  }

  private withDeadline<T>(host: Host, promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise(resolve => {
      const timer = host.after(ms, () => resolve(undefined))
      promise.then(
        value => {
          timer.cancel()
          resolve(value)
        },
        () => {
          timer.cancel()
          resolve(undefined)
        },
      )
    })
  }
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function minutesOf(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
