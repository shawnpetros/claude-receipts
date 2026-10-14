import { describe, expect, test } from 'claude-code/testing'

import { bandOf, BAND_WIDE, linesOf, PANE, step, STEP_ANSWERS, worldOf } from './fixtures'

async function band($: { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }): Promise<{ text: string; border?: string }> {
  const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' } as never)
  const drawn = (await ui.drawn()) as { props: { borderColor?: string } }
  const text = linesOf(drawn).join('')
  await ui.unmount()
  return { text, border: bandOf(drawn).props.borderColor }
}

// 0.3.0: four tests here were deleted with plan derivation (SPEC-0.3
// invariant 10): "a build prompt still derives a 2..8 step plan", "a chat
// prompt that then calls a tool re-derives once", "zero tool calls end
// Answered even when the judgement pass times out", and "a judgement pass
// that marks every step: All done, with the basis named". Their 0.3.0
// counterparts are in v030.test.ts.
describe('answer-shaped turns', () => {
  test('a chat prompt with no tools: a one-step "answer" band, and it ends Answered', async ($, on) => {
    const world = worldOf(on, { taskType: 'chat' })
    STEP_ANSWERS.set('a1:0', 'Yes: invite them to the org by email.')
    await $.turn.start({ text: 'they may not have a github username, so can we invite by email?', turnId: 'a1' })
    await step($ as never, 'a1', 0)
    await world.clock.settle()

    const working = await band($ as never)
    expect(working.text).toMatch(/Step 1 of 1 · answer/)
    expect(working.text).toMatch(/answer the question/)
    expect(working.text).not.toMatch(/derived/)
    expect(world.completes).toHaveLength(0)

    await world.clock.advance(25_000)
    await $.turn.complete({ turnId: 'a1', answer: 'Yes: invite them to the org by email.', durationMs: 25_000, isAborted: false, reason: 'answer' })
    const ended = await band($ as never)
    expect(ended.border).toBe('success')
    expect(ended.text).toMatch(/✓ Answered · 25s/)
    expect(ended.text).not.toMatch(/Not reached|Turn ended/)
  })

  test('the pane names an answer plan for what it is', async ($, on) => {
    const world = worldOf(on, { taskType: 'research' })
    STEP_ANSWERS.set('a6:0', 'Short answer: yes.')
    await $.turn.start({ text: 'is bun faster here?', turnId: 'a6' })
    await step($ as never, 'a6', 0)
    await world.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(linesOf(await ui.drawn()).join('\n')).toMatch(/plan · answer/)
  })
})
