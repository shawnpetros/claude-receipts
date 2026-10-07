import { describe, expect, test } from 'claude-code/testing'

import { approxRangeOf } from '../src/estimator'
import { worldOf } from './fixtures'

describe('rolled-in fixes', () => {
  test('a range never starts at zero: "~0 to 10 min" says nothing', () => {
    for (const [low, high] of [[0, 600_000], [20_000, 600_000], [0, 30_000], [0, 4_000], [59_000, 61_000]] as const) {
      expect(approxRangeOf(low, high), `${low}..${high}`).not.toMatch(/~0 to/)
    }
    expect(approxRangeOf(0, 600_000)).toBe('~1 to 10 min')
    expect(approxRangeOf(0, 30_000)).toBe('~5 to 30 sec')
  })

  test('/receipts opens the pane asking for rows, so inline it is not cut to a third', async ($, on) => {
    const world = worldOf(on)
    await $.command.run({ command: 'receipts', args: '' } as never)
    expect(world.opens).toHaveLength(1)
    expect((world.opens[0] as { rows?: number }).rows).toBeGreaterThan(0)
  })
})
