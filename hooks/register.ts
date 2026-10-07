import type { ConfigRow, EngineInterface, On, PluginOptions, RenderElement } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { ACCENT, bandView, EFFORT_CHOICES, MODEL_CHOICES, TOOLS_COLUMNS, toolsView, type Row, type Seg } from '../src/band'
import type { Host } from '../src/host'
import { PANE_ID, PANE_TITLE, ReceiptsSession } from '../src/session'
import { paneLines, toolGroupText, toolResultText, toolRowText, type Line } from '../src/view'

/**
 * Clean view: tool rows draw as one dim line. Invariant 4, clean view hides
 * rendering only: these hooks return a drawing and never touch the
 * transcript, so toggling it off shows every row as it was. Scar: the
 * /buddy main-model leak; a mod rewriting content is a different and riskier
 * thing than a mod redrawing it.
 */
const cleanView = atom({ plugin: 'receipts', key: 'cleanView' }, true)

/**
 * Suppression, on top of clean view: plain tool rows draw nothing and
 * milestone rows one dim line each, during the turn and after it, so the
 * transcript keeps the assistant's text and the band carries the rest.
 * Drawing only, as clean view (invariant 4). Milestones still show
 * (invariant 5), folded to a line with their outcome.
 */
const suppress = atom({ plugin: 'receipts', key: 'suppress' }, true)

/** The band folded to its title row by its own `[▾]` (`[▸]` folded). */
const collapsed = atom({ plugin: 'receipts', key: 'collapsed' }, false)

/** The settings popover, drawn in the band. */
const toolsOpen = atom({ plugin: 'receipts', key: 'toolsOpen' }, false)

/**
 * The spike switch as the person last set it. userConfig is read-only at
 * runtime, so this state overrides it for the session; it starts from it.
 */
const spike = atom({ plugin: 'receipts', key: 'spike' }, true)

/**
 * Read by the pane and band only, so bumping it once a second redraws those
 * two and not every tool row in the transcript.
 */
const tick = atom({ plugin: 'receipts', key: 'tick' }, 0)

const USAGE = 'usage: /receipts (toggle the pane), /receipts tools, /receipts stats, /receipts reset-history'

/**
 * The mods API as the session logic sees it. Top level and handed `$`, so
 * `claude plugin validate` lists every call through it.
 */
function hostOf($: EngineInterface): Host {
  return {
    now: () => $.clock.now(),
    every: (ms, fn) => $.clock.every(ms, fn),
    after: (ms, fn) => $.clock.after(ms, fn),
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: key => $.store.delete(key),
    redraw: () => {
      update($, tick, n => n + 1).catch(() => $.ui.invalidate('ui.render'))
    },
    classify: (text, labels) => $.model.classify(text, labels),
    complete: request => $.model.complete(request),
    spawn: args => $.agent.spawn(args),
    cwd: () => $.session.cwd(),
    repo: () => $.session.repo(),
    list: path => $.fs.list(path),
  }
}

/**
 * Sets the model or effort the way the person would: the `/config` row when
 * the build has one that takes it, else the slash command. Top level and
 * handed `$`, so validate lists the calls.
 */
async function choose($: EngineInterface, key: 'model' | 'effort', value: string): Promise<void> {
  const rows: ConfigRow[] = await $.config.list().catch(() => [])
  const row = rows.find(candidate => candidate.key === key)
  if (row && !row.isLocked && row.kind !== 'boolean' && row.kind !== 'number') {
    const result = await $.config.set({ key, value }).catch(() => ({ deny: 'failed' }))
    if (result.deny === undefined) return
  }
  await $.command.run({ command: key, args: value })
}

/**
 * The userConfig defaults into state, where the band's switches change them.
 */
async function applyDefaults($: EngineInterface, session: ReceiptsSession, isClean: boolean, isSpike: boolean): Promise<void> {
  if (!isClean) await update($, cleanView, () => false)
  if (!isSpike) await update($, spike, () => false)
  session.setSpike(isSpike)
}

async function sessionModelOf($: EngineInterface): Promise<string> {
  return $.session.model().catch(() => '')
}

/**
 * A line of the pane as Text props, leaving out the styles it does not set.
 */
function textPropsOf(line: Line) {
  return {
    key: line.key,
    wrap: 'truncate-end' as const,
    children: [line.text],
    ...(line.dim ? { dimColor: true } : {}),
    ...(line.bold ? { bold: true } : {}),
    ...(line.color ? { color: line.color } : {}),
  }
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>
type Presses = Record<string, () => unknown>

/**
 * A row of the band as elements: a Text per segment, a plain Button where a
 * segment carries one. A Button whose key has no handler draws as text.
 */
function rowOf(el: Elements, row: Row, presses: Presses): RenderElement {
  const children = row.segs.map((seg: Seg): RenderElement => {
    const press = seg.button ? presses[seg.button.key] : undefined
    if (seg.button && press) {
      return el.Button({
        key: seg.button.key,
        label: seg.button.label,
        plain: true,
        ...(seg.button.hotkey ? { hotkey: seg.button.hotkey } : {}),
        ...(seg.dim ? { dimColor: true } : {}),
        onPress: () => press(),
      })
    }
    return el.Text({
      children: [seg.text],
      ...(seg.color ? { color: seg.color } : {}),
      ...(seg.dim ? { dimColor: true } : {}),
      ...(seg.bold ? { bold: true } : {}),
      ...(seg.inverse ? { inverse: true } : {}),
    })
  })
  return el.Box({ key: row.key, flexDirection: 'row', children })
}

/**
 * The one dim line a milestone row folds to while suppressed: the call and
 * how it ended. A verify run's exit shows as ✓ or ✗ (invariant 5).
 */
function outcomeMarkOf(props: { isRunning?: boolean; isErrored?: boolean; isInterrupted?: boolean }): string {
  if (props.isRunning) return ' …'
  if (props.isInterrupted) return ' ■'
  return props.isErrored ? ' ✗' : ' ✓'
}

export function register(on: On, options: PluginOptions): void {
  const isSpikeByDefault = options.spike !== false
  const session = new ReceiptsSession({ spike: isSpikeByDefault })
  const isCleanByDefault = options.cleanView !== false

  on('session.start', async ($, e, next) => {
    await session.start(hostOf($))
    const stored = await $.state.get({ plugin: 'receipts', key: 'cleanView' })
    if (stored.version === 0) await applyDefaults($, session, isCleanByDefault, isSpikeByDefault)
    try {
      await $.command.register({
        name: 'receipts',
        description: 'Toggle the receipts pane, open its settings, or show calibration stats',
        argumentHint: '[tools|stats|reset-history]',
        immediate: true,
      })
    } catch {
      // A name clash leaves the mod running without its command
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state: put the configured defaults back
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await applyDefaults($, session, isCleanByDefault, isSpikeByDefault)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await session.turnStart(hostOf($), e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) session.noteEffort(e.effort)
    const result = yield* next(e)
    session.stepResult(hostOf($), e, result)
    return result
  })

  on('tool.call', async ($, e, next) => {
    session.beforeTool(e, e)
    const outcome = await next(e)
    await session.afterTool(hostOf($), e, e, outcome).catch(() => undefined)
    return outcome
  }).catch(($, e, next) => next(e))

  // Under the answer: the receipt, or UNVERIFIED. A mirror, never a gate
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      session.subagentComplete(hostOf($), e.agentId, e.answer)
      return result
    }
    const line = await session.turnComplete(hostOf($), e)
    if (!line) return result
    const isOwnText = result.text !== '' && result.text !== e.answer
    return { ...result, text: isOwnText ? `${result.text}\n${line}` : line }
  })

  on('command.run', { command: 'receipts' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stats') return { text: session.statsText() }
    if (arg === 'tools') {
      await update($, toolsOpen, () => true)
      return {}
    }
    if (arg === 'reset-history') {
      const count = await session.resetHistory(hostOf($))
      return { text: `history cleared: ${count} ${count === 1 ? 'task' : 'tasks'} forgotten` }
    }
    if (arg !== '') return { text: USAGE }
    if (session.paneOpen) {
      await $.ui.close({ id: PANE_ID })
      session.paneClosed()
      return {}
    }
    const placed = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    session.paneOpened(placed.isPlaced)
    return {}
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    session.paneClosed()
    return next(e)
  }).catch(($, e, next) => next(e))

  // The pane: the long view, opened only by /receipts
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const isClean = await read($, cleanView)
    await read($, tick)
    const now = await $.clock.now()
    session.paneDrawn()
    const { Box, Text, Button } = $.ui.resolve(e)
    const lines = paneLines(session.viewModel(now))
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ bold: true, children: ['receipts'] }),
            Button({
              key: 'clean-toggle',
              label: isClean ? 'clean view on' : 'clean view off',
              hotkey: 'c',
              plain: true,
              onPress: () => update($, cleanView, value => !value),
            }),
            Button({
              key: 'basis',
              label: session.isBasisShown ? 'hide basis' : 'estimate basis',
              hotkey: 'b',
              plain: true,
              onPress: () => {
                session.toggleBasis()
                $.ui.invalidate('ui.render')
              },
            }),
          ],
        }),
        ...lines.map(line => Text(textPropsOf(line))),
      ],
    })
  })

  // The band: the primary surface. Progress while working, the completion
  // card after, the settings popover under it when asked
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isToolsOpen = await read($, toolsOpen)
    const isBandShown = session.isBandWanted()
    if (!isBandShown && !isToolsOpen) return next(e)
    await read($, tick)
    const isCollapsed = await read($, collapsed)
    const now = await $.clock.now()
    const el = $.ui.resolve(e)
    const presses: Presses = {
      collapse: () => update($, collapsed, value => !value),
      basis: () => {
        session.toggleBasis()
        $.ui.invalidate('ui.render')
      },
      'tools-toggle': () => update($, toolsOpen, value => !value),
      'tools-close': () => update($, toolsOpen, () => false),
      'set-clean': () => update($, cleanView, value => !value),
      'set-suppress': () => update($, suppress, value => !value),
      'set-spike': () =>
        update($, spike, value => {
          session.setSpike(!value)
          return !value
        }),
    }
    for (const choice of MODEL_CHOICES) {
      presses[`model-${choice.value}`] = async () => {
        await choose($, 'model', choice.value)
        $.ui.invalidate('ui.render')
      }
    }
    for (const choice of EFFORT_CHOICES) {
      presses[`effort-${choice.value}`] = async () => {
        await choose($, 'effort', choice.value)
        session.noteEffort(choice.value)
        $.ui.invalidate('ui.render')
      }
    }

    const columns = e.props.bodyColumns
    let band: RenderElement | null = null
    if (isBandShown) {
      const view = bandView(session.viewModel(now), columns, { collapsed: isCollapsed, showBasis: session.isBasisShown })
      band = el.Box({
        key: 'band',
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: view.border,
        paddingX: 1,
        width: columns,
        children: view.rows.map(row => rowOf(el, row, presses)),
      })
    }
    if (!isToolsOpen && band) return band

    const toolsWidth = Math.min(columns, TOOLS_COLUMNS)
    const rows = toolsView(
      {
        model: await sessionModelOf($),
        ...(session.effortLevel ? { effort: session.effortLevel } : {}),
        cleanView: await read($, cleanView),
        spike: await read($, spike),
        suppress: await read($, suppress),
      },
      toolsWidth - 4,
    )
    const tools = el.Box({
      key: 'tools',
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: ACCENT,
      paddingX: 1,
      width: toolsWidth,
      children: rows.map(row => rowOf(el, row, presses)),
    })
    return el.Box({
      flexDirection: 'column',
      width: columns,
      children: [...(band ? [band] : []), el.Box({ flexDirection: 'row', justifyContent: 'flex-end', children: [tools] })],
    })
  })

  // ctrl+o: a ToolGroup's props say when it is expanded, so an expanded group
  // draws in full. ToolUse and ToolResult props carry no such flag, so a
  // single row cannot be expanded past clean view; the toggle restores them
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, cleanView))) return next(e)
    const isMilestone = session.isMilestoneRow(e.props.tool_use_id, e.props.tool, e.props.input)
    const isSuppressed = await read($, suppress)
    const { Box, Text } = $.ui.resolve(e)
    if (isSuppressed) {
      if (!isMilestone) return Box({})
      const text = toolRowText(e.props.tool, e.props.input, session.workingDirectory) + outcomeMarkOf(e.props)
      return Text({ dimColor: true, wrap: 'truncate-end', children: [text] })
    }
    if (isMilestone) return next(e)
    return Text({ dimColor: true, wrap: 'truncate-end', children: [toolRowText(e.props.tool, e.props.input, session.workingDirectory)] })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, cleanView))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // Suppressed, a milestone's outcome is folded into its ToolUse line
    if (await read($, suppress)) return Box({})
    if (session.isMilestoneRow(e.props.tool_use_id, e.props.tool, undefined)) return next(e)
    return Text({ dimColor: true, wrap: 'truncate-end', children: [toolResultText(e.props.output, e.props.isErrored)] })
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !(await read($, cleanView))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (await read($, suppress)) return Box({})
    return Text({ dimColor: true, wrap: 'truncate-end', children: [toolGroupText(e.props.calls)] })
  })
}
