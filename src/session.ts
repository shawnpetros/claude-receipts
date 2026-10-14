/**
 * One session's receipts: the task under way, the history it learns into,
 * and the view model the pane and band draw. Hooks call in through a Host,
 * never `$` (see host.ts).
 *
 * Invariant 6, hooks return fast: every model call here starts unawaited
 * (the spike, the cross-check) except two labels with deadlines: the task
 * type at prompt.submit (SUBMIT_DEADLINE_MS, cached for the turn) and the
 * claims-done label on turn.complete (CLAIMS_DEADLINE_MS, then plain words).
 *
 * Invariant 10: the mod never invents plan steps (milestones.ts).
 * Invariant 13: All done needs every step, a receipt and no refutation (band.ts).
 */

import {
  CROSS_CHECK_AGENT,
  CROSS_CHECK_CAP_MS,
  crossCheckPromptOf,
  diffForCheck,
  parseVerdict,
  USAGE_GUARD_PERCENT,
  type CrossCheck,
} from './crosscheck'
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
  commandLabelOf,
  emptyLedger,
  exitCodeOf,
  isGrepForError,
  isVerifyCommand,
  ledgerStateOf,
  looksDone,
  receiptLine,
  receiptVerifyOf,
  recordEdit,
  recordGrep,
  recordVerify,
  type Ledger,
  type LedgerState,
  type ToolOutcome,
} from './ledger'
import {
  answerPlan,
  editedPathOf,
  emptyPlan,
  isComplete,
  isEditTool,
  isMilestoneCommand,
  isSubagentTool,
  onTaskCreate,
  onTaskUpdate,
  onTodoWrite,
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
/** Task types that are jobs: asked to record a plan, and the only ones spiked. */
export const BUILD_TYPES: readonly string[] = ['build', 'debug', 'config', 'refactor']
/** Task types whose turns are usually one answer: one step, unless work starts. */
export const ANSWER_TYPES: readonly string[] = ['chat', 'research', 'writing']
export const AUDIT_KEY = 'audit'
/** The task-type label holds a submitted prompt at most this long. */
export const SUBMIT_DEADLINE_MS = 1_000
/**
 * A Bash that only looks around is not work starting. Scar: a single Read
 * promoted an answer into a fake six-step plan.
 */
const LOOKING = /^\s*(git\s+(status|log|diff|show|branch|remote)|ls|cat|head|tail|pwd|echo|which|wc|find|tree|grep|rg)\b/

export type SessionOptions = {
  spike: boolean
  /** The adversarial cross-check at turn end; on unless set false. */
  crossCheck?: boolean
  crossCheckModel?: string
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
  isSpiked: boolean
  spike?: readonly number[]
  seenEdits: Set<string>
  /** An edit, or a Bash that does more than look around. A Read is not work. */
  hasWork: boolean
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
  confirmed: number
  refuted: number
  unclear: number
}

type Last = {
  turnId: string
  plan: Plan
  prompt: string
  totalMs: number
  receipt: string | null
  isAborted: boolean
  ledger: LedgerState
  claimsDone: boolean
  hasWork: boolean
  crossCheck: CrossCheck | null
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
  private last: Last | null = null
  private isInteractive = true
  private isCheckOn: boolean
  private readonly checkModel: string
  private readonly typeCache = new Map<string, Promise<TaskType>>()
  private readonly checkWaiters = new Map<string, { turnId: string; startedAt: number; command?: string }>()
  /** Agents the main loop started that were still running when its turn ended. */
  private waiting = new Set<string>()
  /** Shapes already spiked this session: one guess per shape is enough. */
  private readonly spikedShapes = new Set<string>()
  private readonly toolStarts = new Map<string, number>()
  private readonly toolEnds = new Map<string, number>()
  private readonly toolRuns = new Map<string, number>()
  private lastTickAt = 0
  private audit: Audit = { shown: 0, wrong: 0, confirmed: 0, refuted: 0, unclear: 0 }
  private lastReceipt: { turnId: string; isMarked: boolean } | null = null
  private readonly milestoneIds = new Set<string>()
  private readonly spikeWaiters = new Map<string, TaskState>()
  private ticker: { cancel: () => void } | null = null
  private isPaneOpen = false
  private isPaneShown = false
  private showBasis = false
  private cwd = ''
  private effort: string | undefined

  constructor(private readonly options: SessionOptions) {
    this.isCheckOn = options.crossCheck !== false
    this.checkModel = options.crossCheckModel?.trim() || 'opus'
  }

  /**
   * The task-type label for a prompt, asked once per text and shared by
   * prompt.submit (which decides the plan instruction) and turn.start.
   */
  classifyPrompt(host: Host, text: string): Promise<TaskType> {
    const key = text.slice(0, 4_000)
    let typed = this.typeCache.get(key)
    if (!typed) {
      typed = text.trim()
        ? host
            .classify(key, TASK_TYPES)
            .then(label => ((TASK_TYPES as readonly string[]).includes(label ?? '') ? (label as TaskType) : 'unknown'))
            .catch(() => 'unknown' as const)
        : Promise.resolve('unknown' as const)
      this.typeCache.set(key, typed)
      if (this.typeCache.size > 20) this.typeCache.delete(this.typeCache.keys().next().value!)
    }
    return typed
  }

  /** The type in time for prompt.submit, or undefined past SUBMIT_DEADLINE_MS. */
  submitType(host: Host, text: string): Promise<TaskType | undefined> {
    return this.withDeadline(host, this.classifyPrompt(host, text), SUBMIT_DEADLINE_MS)
  }

  setInteractive(isInteractive: boolean): void {
    this.isInteractive = isInteractive
  }

  setCrossCheck(isOn: boolean): void {
    this.isCheckOn = isOn
  }

  get isCrossCheckOn(): boolean {
    return this.isCheckOn
  }

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
      isSpiked: false,
      seenEdits: new Set(),
      hasWork: false,
      pauses: [],
    }
    this.task = task
    this.last = null
    // /receipts wrong is about the current turn's receipt, never an older one
    this.lastReceipt = null
    // The fallback for an agent whose end never reached us: the next prompt
    this.waiting.clear()
    task.typed = this.classifyPrompt(host, text).then(type => {
      task.taskType = type
      // An answer-shaped prompt gets one step, unless work has started
      if (this.task === task && task.plan.source === 'none' && !task.hasWork && ANSWER_TYPES.includes(type)) {
        task.plan = answerPlan(task.startedAt)
        host.redraw()
      }
    })
    this.startTicker(host, now)
    const usage = await host.usage().catch(() => null)
    if (usage?.cost) task.usdAtStart = usage.cost.usd
    // No pane opens unasked: the band above the prompt is the surface, and
    // `/receipts` opens the pane for the long view. Scar: the auto-opened
    // dock took a third of a fullscreen terminal to show four lines.
    host.redraw()
  }

  /**
   * After each model request: start the claims-done label as soon as the
   * final answer exists. No plan is derived here or anywhere (invariant 10).
   */
  stepResult(host: Host, e: StepEvent, result: StepResult): void {
    const task = this.task
    if (!task || e.agentId !== undefined || e.turnId !== task.turnId) return
    const answer = result.answer.trim()
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
      this.workStarted(task)
    } else if (e.tool === 'Bash' && outcome.deny === undefined && typeof fields.command === 'string') {
      const interrupted = (result as { interrupted?: unknown } | undefined)?.interrupted === true
      if (isGrepForError(fields.command)) {
        task.ledger = recordGrep(task.ledger, fields.command, now)
      } else if (!LOOKING.test(fields.command)) {
        this.workStarted(task)
      }
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
   * Work started: an answer plan no longer fits. The plan comes from the
   * task tools, or the band says "working"; never a made-up list.
   */
  private workStarted(task: TaskState): void {
    task.hasWork = true
    if (task.plan.source === 'answer') task.plan = emptyPlan()
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

    const hasEdits = task.ledger.edits.length > 0 && !e.isAborted
    const claims = hasEdits ? await this.withDeadline(host, task.claims ?? this.claimsDone(host, e.answer), CLAIMS_DEADLINE_MS) : undefined
    const claimsDone = hasEdits ? (claims ?? looksDone(e.answer)) : false
    const line = hasEdits ? receiptLine(task.ledger, claimsDone, now, task.cwd) : null

    // Steps come only from the task tools: they stand as Claude left them.
    // A turn with no work and a reply was an answer, whatever else ran
    const isAnswer = !task.hasWork && task.plan.source !== 'tasks' && e.answer.trim() !== '' && !e.isAborted
    const plan = isAnswer ? answerPlan(task.startedAt, now) : task.plan.source === 'answer' ? emptyPlan() : task.plan
    const totalMs = Math.max(0, now - task.startedAt)
    const usage = await host.usage().catch(() => null)
    const isCrossChecked =
      hasEdits &&
      claimsDone &&
      this.isCheckOn &&
      this.isInteractive &&
      !(usage?.rateLimits.some(limit => limit.kind === 'five_hour' && limit.percentUsed > USAGE_GUARD_PERCENT) ?? false)
    this.last = {
      turnId: task.turnId,
      plan,
      prompt: task.prompt,
      totalMs,
      receipt: line,
      isAborted: e.isAborted,
      ledger: e.isAborted ? 'none' : ledgerStateOf(task.ledger),
      claimsDone,
      hasWork: task.hasWork,
      crossCheck: isCrossChecked ? { state: 'running', model: this.checkModel } : null,
    }
    if (isCrossChecked) void this.crossCheck(host, task, e.answer, now)
    let shown = line
    if (line) {
      this.audit = { ...this.audit, shown: this.audit.shown + 1 }
      this.lastReceipt = { turnId: task.turnId, isMarked: false }
      await host.storeSet(AUDIT_KEY, this.audit).catch(() => undefined)
      const cost = this.costOf(usage, task)
      if (cost) shown = `${line} · ${cost}`
    }

    // A task-tool plan finished only when every item did; an answer, or work
    // with no task list, finished when the turn answered
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
   * What the turn cost, for the receipt line: a plan user's five-hour window
   * and its reset, an API user's dollars this turn, or nothing when neither
   * is known. Never a guess.
   */
  private costOf(usage: Awaited<ReturnType<Host['usage']>> | null, task: TaskState): string | null {
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

  /** The person says this turn's receipt was wrong: one mark per receipt. */
  async markWrong(host: Host): Promise<string> {
    if (!this.lastReceipt) return 'no receipt this session to mark'
    if (this.lastReceipt.isMarked) return 'already marked wrong'
    this.lastReceipt.isMarked = true
    this.audit = { ...this.audit, wrong: this.audit.wrong + 1 }
    await host.storeSet(AUDIT_KEY, this.audit).catch(() => undefined)
    return `marked wrong · ${this.auditLine()}`
  }

  /**
   * The adversarial cross-check (invariant 12): one read-only agent per
   * turn, handed the ask, the claim, what ran and the diff, told to refute.
   * Its verdict lands on the card when its turn ends; silence past
   * CROSS_CHECK_CAP_MS is unclear. Never blocks the turn.
   */
  private async crossCheck(host: Host, task: TaskState, claim: string, now: number): Promise<void> {
    const files = [...new Set(task.ledger.edits.map(edit => edit.path))]
    const ledgerLines = [
      ...task.ledger.verifies.map(run => [commandLabelOf(run.command), `exit ${run.exitCode}`, ...(run.summary ? [run.summary] : [])].join(' · ')),
      ...task.ledger.greps.map(grep => `${grep.command} · grep-for-error, not a receipt`),
    ]
    const diffOf = async (argv: string[]) => (await host.run(argv, task.cwd).catch(() => null))?.stdout ?? ''
    const diff = await diffOf(['git', 'diff', '--', ...files])
    const body = diff.split('\n').length > 400 ? diffForCheck(diff, await diffOf(['git', 'diff', '--stat', '--', ...files])) : diff
    const command = receiptVerifyOf(task.ledger)?.command
    const turnId = task.turnId
    // The verdict lands at once; its elapsed time follows when the clock answers
    const settle = (verdict: ReturnType<typeof parseVerdict>, at?: number) => {
      if (this.last?.turnId !== turnId || this.last.crossCheck?.state !== 'running') return
      const last = this.last
      if (at === undefined) {
        void host.now().then(later => {
          if (last.crossCheck && last.crossCheck.state !== 'running') last.crossCheck = { ...last.crossCheck, ms: Math.max(0, later - now) }
          host.redraw()
        })
      }
      last.crossCheck = {
        state: verdict.verdict,
        model: this.checkModel,
        reason: verdict.reason,
        reran: verdict.reran,
        exit: verdict.exit,
        ...(command ? { command: commandLabelOf(command) } : {}),
        ms: at === undefined ? 0 : Math.max(0, at - now),
      }
      this.audit = { ...this.audit, [verdict.verdict]: this.audit[verdict.verdict] + 1 }
      void host.storeSet(AUDIT_KEY, this.audit).catch(() => undefined)
      host.redraw()
    }
    host.after(CROSS_CHECK_CAP_MS, () => settle({ verdict: 'unclear', reason: 'no verdict within 90s', reran: false, exit: null }, now + CROSS_CHECK_CAP_MS))
    try {
      const spawned = await host.spawn({
        prompt: crossCheckPromptOf({ ask: task.prompt, claim, ledger: ledgerLines, diff: body, files }),
        description: 'receipts: cross-check',
        subagentType: CROSS_CHECK_AGENT,
        model: this.checkModel,
      })
      if (spawned.deny !== undefined) {
        settle({ verdict: 'unclear', reason: `not started: ${spawned.deny}`, reran: false, exit: null }, await host.now())
        return
      }
      if (spawned.agentId !== undefined) this.checkWaiters.set(spawned.agentId, { turnId, startedAt: now, ...(command ? { command } : {}) })
      this.checkSettlers.set(turnId, settle)
    } catch {
      settle({ verdict: 'unclear', reason: 'could not start', reran: false, exit: null }, await host.now())
    }
  }

  private readonly checkSettlers = new Map<string, (verdict: ReturnType<typeof parseVerdict>, at?: number) => void>()

  private auditLine(): string {
    const { shown, wrong } = this.audit
    const percent = shown === 0 ? 0 : Math.round((wrong / shown) * 100)
    return `claims-done false positives: ${wrong} of ${shown} ${shown === 1 ? 'receipt' : 'receipts'} (${percent}%)`
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
    const check = this.checkWaiters.get(agentId)
    if (check) {
      this.checkWaiters.delete(agentId)
      const settle = this.checkSettlers.get(check.turnId)
      this.checkSettlers.delete(check.turnId)
      settle?.(parseVerdict(answer))
      return
    }
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
        ? {
            totalMs: this.last.totalMs,
            receipt: this.last.receipt,
            isAborted: this.last.isAborted,
            waitingAgents: this.waiting.size,
            ledger: this.last.ledger,
            claimsDone: this.last.claimsDone,
            hasWork: this.last.hasWork,
            crossCheck: this.last.crossCheck,
          }
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
    const { confirmed, refuted, unclear } = this.audit
    const audit = [
      `${this.auditLine()}; mark a wrong one with /receipts wrong`,
      `cross-checks: ${confirmed} confirmed, ${refuted} refuted, ${unclear} unclear`,
    ].join('\n')
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
    if (typeof audit?.shown === 'number' && typeof audit.wrong === 'number') {
      const count = (n: unknown) => (typeof n === 'number' ? n : 0)
      this.audit = { shown: audit.shown, wrong: audit.wrong, confirmed: count(audit.confirmed), refuted: count(audit.refuted), unclear: count(audit.unclear) }
    }
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

  private claimsDone(host: Host, answer: string): Promise<boolean | undefined> {
    return host
      .classify(`The final message of a coding assistant to its user:\n${answer.slice(0, 4_000)}`, CLAIMS_LABELS)
      .then(label => (label === 'claims-done' ? true : label === 'not-claiming-done' ? false : undefined))
      .catch(() => undefined)
  }

  /**
   * Once per shape per session, for a build-type task whose recorded plan has
   * SPIKE_MIN_STEPS or more and no history, unless the user turned it off.
   */
  private async maybeSpike(host: Host, task: TaskState): Promise<void> {
    if (!this.options.spike || task.isSpiked) return
    if (task.plan.items.length < SPIKE_MIN_STEPS) return
    if (task.plan.source !== 'tasks') return
    task.isSpiked = true
    await Promise.all([this.probing, task.typed])
    if (bucketSamples(this.stats, this.shapeOf(task)) >= 3) return
    // Once per shape per session, and never for cheap task types. Scar: a
    // cheap subagent per prompt in an unfamiliar repo (the 0.2.0 live run)
    if (!BUILD_TYPES.includes(task.taskType)) return
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
