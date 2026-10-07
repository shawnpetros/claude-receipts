import { describe, expect, test } from 'claude-code/testing'

import { aliasOf, toolsView } from '../src/band'
import { BAND_WIDE, linesOf, worldOf } from './fixtures'

async function openTools($: { command: { run: (e: never) => Promise<unknown> } }) {
  await $.command.run({ command: 'receipts', args: 'tools' } as never)
}

describe('settings popover', () => {
  test('model names map to the aliases the chips use', () => {
    expect(aliasOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(aliasOf('Fable 5.1')).toBe('fable')
    expect(aliasOf('sonnet')).toBe('sonnet')
    expect(aliasOf('some-other-model')).toBeUndefined()
  })

  test('the pure view: letter-spaced headers, the current model and effort highlighted, rows fit', () => {
    const rows = toolsView({ model: 'claude-opus-5-5', effort: 'high', cleanView: true, spike: false, suppress: true }, 60)
    for (const row of rows) expect([...row.segs.map(seg => seg.text).join('')].length).toBeLessThanOrEqual(60)
    const text = rows.map(row => row.segs.map(seg => seg.text).join(''))
    expect(text.some(line => line.startsWith('M O D E L'))).toBe(true)
    expect(text.some(line => line.startsWith('E F F O R T'))).toBe(true)
    expect(text.some(line => /S E T T I N G S/.test(line))).toBe(true)
    const chips = rows.flatMap(row => row.segs)
    expect(chips.find(seg => seg.inverse && seg.text.trim() === 'Opus')).toBeDefined()
    expect(chips.find(seg => seg.inverse && seg.text.trim() === 'High')).toBeDefined()
    expect(chips.find(seg => seg.button?.key === 'model-sonnet')).toBeDefined()
    expect(chips.find(seg => seg.button?.key === 'model-opus')).toBeUndefined()
  })

  test('/receipts tools opens it in the band with the current model highlighted; [-] closes it', async ($, on) => {
    worldOf(on, { model: 'claude-opus-5-5[1m]' })
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const panel = await ui.find({ key: 'tools' })
    expect(panel).toBeDefined()
    const current = await ui.findAll({ type: 'Text', text: /Opus/ })
    expect(current.some(element => element.props.inverse === true)).toBe(true)
    expect(await ui.find({ key: 'model-haiku' })).toBeDefined()
    await ui.press({ key: 'tools-close' })
    expect(await ui.find({ key: 'tools' })).toBeUndefined()
  })

  test('t in the band toggles it while a task shows', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'fix', turnId: 't1' })
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const toggle = await ui.find({ key: 'tools-toggle' })
    expect(toggle?.props.hotkey).toBe('t')
    await ui.press({ key: 'tools-toggle' })
    expect(await ui.find({ key: 'tools' })).toBeDefined()
    await ui.press({ key: 'tools-toggle' })
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

  test('the settings rows toggle clean view, the spike and tool-row suppression', async ($, on) => {
    worldOf(on)
    await openTools($ as never)
    const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' })
    const state = async (key: 'cleanView' | 'spike' | 'suppress') => (await $.state.get({ plugin: 'receipts', key })).value
    expect(await state('spike')).toBe(true)
    await ui.press({ key: 'set-spike' })
    expect(await state('spike')).toBe(false)
    await ui.press({ key: 'set-suppress' })
    expect(await state('suppress')).toBe(false)
    await ui.press({ key: 'set-clean' })
    expect(await state('cleanView')).toBe(false)
    expect(linesOf(await ui.drawn()).join(' ')).toMatch(/Off/)
  })
})
