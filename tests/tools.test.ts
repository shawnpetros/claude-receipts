import { describe, expect, test } from 'claude-code/testing'

import { aliasOf } from '../src/band'
import { BAND_WIDE, worldOf } from './fixtures'

// 0.3.0: the settings popover became the tools panel of the reference video
// (frame 14). Its layout, sections and switches are covered in
// frames.test.ts. Deleted here, with the popover they encoded: "the pure
// view: letter-spaced headers..." (the panel's headers are not letter-spaced
// in frame 14), "t in the band toggles it while a task shows" (the band draws
// no buttons; the footer button and /receipts tools open it), and "the rows
// level is three chips" (Clean View is one setting row that steps through
// the levels).

async function openTools($: { command: { run: (e: never) => Promise<unknown> } }) {
  await $.command.run({ command: 'receipts', args: 'tools' } as never)
}

describe('tools panel', () => {
  test('model names map to the aliases the chips use', () => {
    expect(aliasOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(aliasOf('Fable 5.1')).toBe('fable')
    expect(aliasOf('sonnet')).toBe('sonnet')
    expect(aliasOf('some-other-model')).toBeUndefined()
  })

  test('/receipts tools opens it in the band with the current model highlighted, and closes it again', async ($, on) => {
    worldOf(on, { model: 'claude-opus-5-5[1m]' })
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    expect(await ui.find({ key: 'tools' })).toBeDefined()
    const current = await ui.findAll({ type: 'Text', text: /Opus 5\.5/ })
    expect(current.some(element => element.props.inverse === true)).toBe(true)
    expect(await ui.find({ key: 'model-haiku' })).toBeDefined()
    await openTools($ as never)
    expect(await ui.find({ key: 'tools' })).toBeUndefined()
  })

  test('picking a model uses $.config.set when the model row exists', async ($, on) => {
    const world = worldOf(on, { configRows: [{ key: 'model', label: 'Model', kind: 'text', value: 'opus', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] })
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    await ui.press({ key: 'model-sonnet' })
    expect(world.configSets).toEqual([['model', 'sonnet']])
    expect(world.commandRuns).toEqual([])
  })

  test('with no settable row, model and effort go through /model and /effort', async ($, on) => {
    const world = worldOf(on)
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    await ui.press({ key: 'model-fable' })
    await ui.press({ key: 'effort-xhigh' })
    expect(world.commandRuns).toEqual(['/model fable', '/effort xhigh'])
  })

  test('Clean View steps through the rows levels; the switches flip', async ($, on) => {
    worldOf(on)
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const label = async (key: string) => (await ui.find({ key }))?.props.label
    expect(await label('set-rows')).toBe('Quiet')
    await ui.press({ key: 'set-rows' })
    expect(await label('set-rows')).toBe('Off')
    await ui.press({ key: 'set-rows' })
    expect(await label('set-rows')).toBe('Clean')
    for (const key of ['set-spike', 'set-chatter', 'set-crosscheck']) {
      const before = await label(key)
      await ui.press({ key })
      expect(await label(key), key).not.toBe(before)
    }
  })

  test('LAUNCH shows the stats and marks the receipt wrong, answered by this mod, not a command run', async ($, on) => {
    const world = worldOf(on)
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    await ui.press({ key: 'launch-stats' })
    await ui.press({ key: 'launch-wrong' })
    // $.command.run skips the calling plugin's own hooks, so /receipts from
    // here would go unanswered; the presses must not go through it
    expect(world.commandRuns).toEqual([])
    expect(toasts[0]).toMatch(/claims-done false positives/)
    expect(toasts[1]).toMatch(/no receipt/)
  })
})
