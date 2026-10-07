import { describe, expect, test } from 'claude-code/testing'

import { flip, linesOf, siteOf, worldOf } from './fixtures'

const ENGINE = 'drawn by Claude Code'
type Level = 'off' | 'clean' | 'quiet'
const LEVELS: Level[] = ['off', 'clean', 'quiet']

const SPINNER = { word: 'Ebbing', message: null, suffix: '…', mode: 'thinking' }
const HANDBACK = { text: 'Found 3 mods that draw a band.\nMore detail.', origin: { kind: 'peer' }, isExpanded: false, from: { name: 'Explore' } }
const PROMPT = { text: 'fix the parser', origin: { kind: 'composer' }, isExpanded: false }
const PROGRESS = { tool_use_id: 't1', kind: 'background_hint', hint: '(ctrl+b to run in background)' }
const DURATION = { word: 'Baked', durationMs: 3_000 }
const NOTICE = { text: 'Using model from settings', command: null }
const OUTPUT = (command: string) => ({ command, args: '', text: 'printed', isErrored: false })

async function levelOf($: unknown, level: Level): Promise<void> {
  await flip($ as never, `rows-${level}`)
}

async function drawnLines($: { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }, site: never): Promise<string[]> {
  const ui = await $.ui.mount(site)
  const lines = linesOf(await ui.drawn())
  await ui.unmount()
  return lines
}

describe('rows level: chrome sites while a turn runs', () => {
  for (const level of LEVELS) {
    test(`${level}: spinner, progress, duration, notices, command output`, async ($, on) => {
      worldOf(on)
      await levelOf($, level)
      await $.turn.start({ text: 'x', turnId: `q-${level}` })
      const hidden = level === 'quiet' ? [] : [ENGINE]
      expect(await drawnLines($ as never, siteOf('Spinner', SPINNER))).toEqual(hidden)
      expect(await drawnLines($ as never, siteOf('ToolProgress', PROGRESS))).toEqual(hidden)
      expect(await drawnLines($ as never, siteOf('TurnDuration', DURATION))).toEqual(hidden)
      expect(await drawnLines($ as never, siteOf('InfoNotice', NOTICE))).toEqual(hidden)
      expect(await drawnLines($ as never, siteOf('CommandOutput', OUTPUT('compact')))).toEqual(hidden)
      // The mod's own output and an error line always show
      expect(await drawnLines($ as never, siteOf('CommandOutput', OUTPUT('receipts')))).toEqual([ENGINE])
      expect(await drawnLines($ as never, siteOf('CommandOutput', { ...OUTPUT('compact'), isErrored: true }))).toEqual([ENGINE])
      // Never touched: the question dialog
      expect(await drawnLines($ as never, siteOf('AskUserQuestion', { tool: 'AskUserQuestion', questions: [] }))).toEqual([ENGINE])
    })
  }

  test('quiet, idle: the chrome is Claude Code\'s again', async ($, on) => {
    worldOf(on)
    expect(await drawnLines($ as never, siteOf('TurnDuration', DURATION))).toEqual([ENGINE])
    expect(await drawnLines($ as never, siteOf('InfoNotice', NOTICE))).toEqual([ENGINE])
    expect(await drawnLines($ as never, siteOf('CommandOutput', OUTPUT('compact')))).toEqual([ENGINE])
  })
})

describe('rows level: messages', () => {
  for (const level of ['off', 'clean'] as const) {
    test(`${level}: hand-backs and assistant text draw as Claude Code draws them`, async ($, on) => {
      worldOf(on)
      await levelOf($, level)
      await $.turn.start({ text: 'x', turnId: `m-${level}` })
      expect(await drawnLines($ as never, siteOf('UserMessage', HANDBACK))).toEqual([ENGINE])
      expect(await drawnLines($ as never, siteOf('AssistantMessage', { text: 'Interim.\nMore.', isFirstOfReply: true }, 'am-1'))).toEqual([ENGINE])
    })
  }

  test('quiet: a hand-back draws nothing mid-turn and one dim line after; prompts and ctrl+o untouched', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'x', turnId: 'mq1' })
    expect(await drawnLines($ as never, siteOf('UserMessage', HANDBACK))).toEqual([])
    expect(await drawnLines($ as never, siteOf('UserMessage', PROMPT))).toEqual([ENGINE])
    expect(await drawnLines($ as never, siteOf('UserMessage', { ...HANDBACK, isExpanded: true }))).toEqual([ENGINE])
    await $.turn.complete({ turnId: 'mq1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer' })
    const ui = await $.ui.mount(siteOf('UserMessage', HANDBACK))
    const drawn = (await ui.drawn()) as { props: { dimColor?: boolean } }
    expect(drawn.props.dimColor).toBe(true)
    expect(linesOf(drawn)).toEqual(['↳ message from @Explore: Found 3 mods that draw a band.'])
  })

  test('quiet: interim assistant text is its first line, dim; the final answer redraws in full on turn.complete', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'x', turnId: 'mq2' })
    const interim = await $.ui.mount(siteOf('AssistantMessage', { text: 'Checking how this session loaded it.\nThen the cache.', isFirstOfReply: true }, 'am-interim'))
    const interimDrawn = (await interim.drawn()) as { props: { dimColor?: boolean } }
    expect(interimDrawn.props.dimColor).toBe(true)
    expect(linesOf(interimDrawn)).toEqual(['Checking how this session loaded it.'])

    const final = await $.ui.mount(siteOf('AssistantMessage', { text: 'Yes, the newest version is installed.\n\nDetails follow.', isFirstOfReply: true }, 'am-final'))
    expect(linesOf(await final.drawn())).toEqual(['Yes, the newest version is installed.'])

    await $.turn.complete({ turnId: 'mq2', answer: 'Yes, the newest version is installed.\n\nDetails follow.', durationMs: 1, isAborted: false, reason: 'answer' })
    expect(linesOf(await final.drawn())).toEqual([ENGINE])
    expect(linesOf(await interim.drawn())).toEqual(['Checking how this session loaded it.'])

    // A message from before the mod saw any turn is left alone
    expect(await drawnLines($ as never, siteOf('AssistantMessage', { text: 'old\nreply', isFirstOfReply: true }, 'am-old'))).toEqual([ENGINE])
  })
})

describe('command mirrors', () => {
  test('/receipts rows sets the level, /receipts clean toggles off and back, /receipts basis toggles the tooltip', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'x', turnId: 'cm1' })
    const spinner = async () => drawnLines($ as never, siteOf('Spinner', SPINNER))
    expect(await spinner()).toEqual([])
    await $.command.run({ command: 'receipts', args: 'rows clean' } as never)
    expect(await spinner()).toEqual([ENGINE])
    await $.command.run({ command: 'receipts', args: 'rows quiet' } as never)
    await $.command.run({ command: 'receipts', args: 'clean' } as never)
    expect(await spinner()).toEqual([ENGINE])
    await $.command.run({ command: 'receipts', args: 'clean' } as never)
    expect(await spinner()).toEqual([])
    const result = (await $.command.run({ command: 'receipts', args: 'rows loud' } as never)) as { text?: string }
    expect(result.text).toMatch(/usage/)
    const basis = (await $.command.run({ command: 'receipts', args: 'basis' } as never)) as { text?: string }
    expect(basis.text).toMatch(/basis/)
  })
})
