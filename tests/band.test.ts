import { describe, expect, test } from 'claude-code/testing'

import { BAND, linesOf, STEP_ANSWERS, step, worldOf } from './fixtures'

const LONG = 'Rewrite the configuration loader so that every nested include resolves relative to its own file and not the working directory, with a test for each of the eleven edge cases'

describe('band fallback', () => {
  test('at 100 cols with no pane: at most 3 rows, none wider than the columns', async ($, on) => {
    const world = worldOf(on, { isWide: false, plan: [LONG, 'Fix the bug', 'Run the tests'] })
    STEP_ANSWERS.set('band1:0', 'Looking.')
    await $.turn.start({ text: 'fix the loader', turnId: 'band1' })
    await step($ as never, 'band1', 0)
    await world.clock.settle()
    await world.clock.advance(95_000)
    expect(world.opens).toHaveLength(1)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const lines = linesOf(await ui.drawn())
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(3)
    for (const line of lines) {
      expect([...line].length, line).toBeLessThanOrEqual(BAND.props.bodyColumns)
      expect([...line].length, line).toBeLessThanOrEqual(BAND.viewport.columns)
    }
  })

  test('the band stays out of the way while the pane is placed, and while a survey holds it', async ($, on) => {
    const world = worldOf(on, { isWide: true })
    await $.turn.start({ text: 'fix', turnId: 'band2' })
    await world.clock.settle()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(linesOf(await ui.drawn())).toEqual(['drawn by Claude Code'])
    await ui.unmount()
  })
})
