import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'

/**
 * What a test reads back from the stubbed world: the calls the mod made that
 * matter to the assertions, and the clock that moves only when the test says.
 */
export type World = {
  clock: ReturnType<typeof mock.clock>
  spawns: string[]
  completes: string[]
  classifies: string[][]
  toolIds: string[]
  opens: unknown[]
  saved: Map<string, unknown>
  /** `$.config.set` calls the mod made, as [key, value]. */
  configSets: [string, unknown][]
  /** Slash commands the mod ran through `$.command.run`, as typed. */
  commandRuns: string[]
}

export type WorldOptions = {
  /** Lines the plan-derivation model call answers with; empty for none. */
  plan?: readonly string[]
  /** What the claims-done classify answers. */
  claimsDone?: boolean
  /** Model latency on the mock clock, in ms (0 answers at once). */
  modelMs?: number
  /** Whether a pane opened unasked is placed (a wide terminal). */
  isWide?: boolean
  /** The store's starting entries. */
  store?: Record<string, unknown>
  /** What each tool call resolves to, by tool name. */
  tools?: Record<string, unknown>
  /** What `$.session.model()` answers. */
  model?: string
  /** The rows `$.config.list()` answers. */
  configRows?: unknown[]
}

/**
 * Stubs every mods API call the receipts mod makes, so no hook is skipped
 * for a missing implementation, and records the ones tests assert on.
 */
export function worldOf(on: On, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  const saved = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const world: World = {
    clock,
    spawns: [],
    completes: [],
    classifies: [],
    toolIds: [],
    opens: [],
    saved,
    configSets: [],
    commandRuns: [],
  }
  const modelMs = options.modelMs ?? 0
  const plan = options.plan ?? ['Read the code', 'Fix the bug', 'Run the tests']

  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    world.opens.push(e)
    return { value: options.isWide === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.repo', () => ({ value: { root: '/work', remote: null, internal: false, name: null } }))
  on('fs.list', () => ({ value: [{ name: 'tests', kind: 'dir', size: 0, isLink: false, mtimeMs: 0 }] }))
  on('model.classify', async ($, e) => {
    world.classifies.push([...e.labels])
    if (modelMs > 0) await clock.sleep(modelMs)
    if (e.labels.includes('claims-done')) {
      return { value: options.claimsDone === false ? 'not-claiming-done' : 'claims-done' }
    }
    if (e.labels.includes('step-done')) return { value: 'step-not-done' }
    return { value: 'debug' }
  })
  on('model.complete', async ($, e) => {
    world.completes.push(e.prompt)
    if (modelMs > 0) await clock.sleep(modelMs)
    return {
      value: {
        isAnswered: true,
        text: plan.map((line, i) => `${i + 1}. ${line}`).join('\n'),
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('agent.spawn', ($, e) => {
    world.spawns.push(e.prompt)
    return { model: 'haiku', agentId: 'spike-' + world.spawns.length }
  })
  on('tool.call', ($, e) => {
    world.toolIds.push(e.tool_use_id)
    const answer = options.tools?.[e.tool]
    if (answer !== undefined) return answer as never
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(world.toolIds.length), subject: String((e as { subject?: string }).subject) } } }
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('config.list', () => ({ value: (options.configRows ?? []) as never }))
  on('config.set', ($, e) => {
    world.configSets.push([e.key, e.value])
    return { value: e.value }
  })
  on('command.run', ($, e) => {
    world.commandRuns.push(`/${e.command} ${e.args}`.trim())
    return { text: '' }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: STEP_ANSWERS.get(`${e.turnId}:${e.index}`) ?? '', toolUses: [], stopReason: 'tool_use', usage: null }
  })

  return world
}

/**
 * The visible text a test's turn.step stub answers with, by `turnId:index`.
 */
export const STEP_ANSWERS = new Map<string, string>()

/**
 * Drains one turn.step stream to its result, as the query loop does.
 */
export async function step($: { turn: { step: (e: never) => AsyncIterator<unknown, unknown> } }, turnId: string, index: number): Promise<unknown> {
  const stream = $.turn.step({ turnId, index, model: 'claude-test', messageCount: 1 } as never)
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
  return next.value
}

/**
 * The Pane envelope Claude Code hands a ui.render hook for the receipts pane.
 */
export const PANE = {
  plugin: 'receipts',
  component: 'Pane',
  requestId: 'receipts',
  viewport: { columns: 160, rows: 40, isFullscreen: true },
  props: {
    title: 'receipts',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/**
 * The band above the prompt at 100 columns, while a turn runs.
 */
export const BAND = {
  plugin: 'receipts',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 40, isFullscreen: false },
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 95,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

/**
 * The band above the prompt in a 160-column terminal.
 */
export const BAND_WIDE = {
  ...BAND,
  viewport: { columns: 160, rows: 40, isFullscreen: false },
  props: { ...BAND.props, bodyColumns: 155 },
} as const

/**
 * A finished tool row, keyed by the id the tool.call stub saw.
 */
export function toolRowOf(id: string, tool: string, input: unknown, output: unknown = { stdout: 'a\nb\nc', stderr: '', interrupted: false }) {
  return {
    plugin: 'receipts',
    component: 'ToolUse',
    requestId: id,
    props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false, output },
  } as const
}

/**
 * Every string a drawn tree shows, one per Text, in document order.
 */
export function linesOf(tree: unknown): string[] {
  const lines: string[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const element = node as { type?: string; props?: { children?: unknown }; children?: unknown }
    const children = (element.children ?? element.props?.children) as unknown
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children]
    if (element.type === 'Text') {
      lines.push(list.filter(child => typeof child === 'string').join(''))
      return
    }
    for (const child of list) walk(child)
  }
  walk(tree)
  return lines
}

type Switch = 'set-clean' | 'set-spike' | 'set-suppress'

/**
 * Flips one of the mod's switches as a person does: opens the settings with
 * `/receipts tools`, presses the row, closes it again. The test kit's `$`
 * has no `state` noun, so state is driven and read through the drawing.
 */
export async function flip($: { command: { run: (e: never) => Promise<unknown> }; ui: { mount: (e: never) => Promise<{ press: (t: { key: string }) => Promise<unknown>; unmount: () => Promise<void> }> } }, key: Switch): Promise<void> {
  await $.command.run({ command: 'receipts', args: 'tools' } as never)
  const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' } as never)
  await ui.press({ key })
  await ui.press({ key: 'tools-close' })
  await ui.unmount()
}
