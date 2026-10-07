import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { atom, read, update } from 'claude-code'

import type { Host } from '../src/host'
import { PANE_ID, PANE_TITLE, ReceiptsSession } from '../src/session'
import { bandLines, paneLines, toolGroupText, toolResultText, toolRowText, type Line } from '../src/view'

/**
 * Clean view: tool rows draw as one dim line. Invariant 4, clean view hides
 * rendering only: these hooks return a drawing and never touch the
 * transcript, so toggling it off shows every row as it was. Scar: the
 * /buddy main-model leak; a mod rewriting content is a different and riskier
 * thing than a mod redrawing it.
 */
const cleanView = atom({ plugin: 'receipts', key: 'cleanView' }, true)

/**
 * Read by the pane and band only, so bumping it once a second redraws those
 * two and not every tool row in the transcript.
 */
const tick = atom({ plugin: 'receipts', key: 'tick' }, 0)

const USAGE = 'usage: /receipts (toggle the pane), /receipts stats, /receipts reset-history'

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
    openPane: pane => $.ui.open(pane),
    classify: (text, labels) => $.model.classify(text, labels),
    complete: request => $.model.complete(request),
    spawn: args => $.agent.spawn(args),
    cwd: () => $.session.cwd(),
    repo: () => $.session.repo(),
    list: path => $.fs.list(path),
  }
}

/**
 * A line of the view as Text props, leaving out the styles it does not set.
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

export function register(on: On, options: PluginOptions): void {
  const session = new ReceiptsSession({ spike: options.spike !== false })
  const isCleanByDefault = options.cleanView !== false

  on('session.start', async ($, e, next) => {
    await session.start(hostOf($))
    const stored = await $.state.get({ plugin: 'receipts', key: 'cleanView' })
    if (stored.version === 0 && !isCleanByDefault) await update($, cleanView, () => false)
    try {
      await $.command.register({
        name: 'receipts',
        description: 'Toggle the receipts pane, or show calibration stats',
        argumentHint: '[stats|reset-history]',
        immediate: true,
      })
    } catch {
      // A name clash leaves the mod running without its command
    }
    return next(e)
  })

  // /clear, /resume and /branch reset $.state: put the configured default back
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (!isCleanByDefault) await update($, cleanView, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await session.turnStart(hostOf($), e.turnId, e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
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

  // The band: the pane's content in three rows, only while no pane is placed
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !session.isBandWanted()) return next(e)
    await read($, tick)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const lines = bandLines(session.viewModel(now), e.props.bodyColumns)
    return Box({ flexDirection: 'column', children: lines.map(line => Text(textPropsOf(line))) })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, cleanView))) return next(e)
    if (session.isMilestoneRow(e.props.tool_use_id, e.props.tool, e.props.input)) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ dimColor: true, wrap: 'truncate-end', children: [toolRowText(e.props.tool, e.props.input, session.workingDirectory)] })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, cleanView))) return next(e)
    if (session.isMilestoneRow(e.props.tool_use_id, e.props.tool, undefined)) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ dimColor: true, wrap: 'truncate-end', children: [toolResultText(e.props.output, e.props.isErrored)] })
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !(await read($, cleanView))) return next(e)
    const { Text } = $.ui.resolve(e)
    return Text({ dimColor: true, wrap: 'truncate-end', children: [toolGroupText(e.props.calls)] })
  })
}
