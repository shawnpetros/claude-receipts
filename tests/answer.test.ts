import { describe, expect, test } from 'claude-code/testing'

import { BAND_WIDE, linesOf, PANE, step, STEP_ANSWERS, worldOf } from './fixtures'

const PLAN_PROMPT = /The assistant's first message/

async function band($: { ui: { mount: (e: never) => Promise<{ drawn: () => Promise<unknown>; unmount: () => Promise<void> }> } }): Promise<{ text: string; border?: string }> {
  const ui = await $.ui.mount({ ...BAND_WIDE, surface: 'terminal' } as never)
  const drawn = (await ui.drawn()) as { props: { borderColor?: string } }
  const text = linesOf(drawn).join('')
  await ui.unmount()
  return { text, border: drawn.props.borderColor }
}

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
    expect(world.completes.filter(prompt => PLAN_PROMPT.test(prompt))).toHaveLength(0)

    await world.clock.advance(25_000)
    await $.turn.complete({ turnId: 'a1', answer: 'Yes: invite them to the org by email.', durationMs: 25_000, isAborted: false, reason: 'answer' })
    const ended = await band($ as never)
    expect(ended.border).toBe('success')
    expect(ended.text).toMatch(/✓ Answered · 25s/)
    expect(ended.text).not.toMatch(/Not reached|Turn ended/)
  })

  test('a build prompt still derives a 2..8 step plan', async ($, on) => {
    const world = worldOf(on, { taskType: 'build', plan: ['Read the code', 'Write the feature', 'Run the tests'] })
    STEP_ANSWERS.set('a2:0', 'Reading the loader first.')
    await $.turn.start({ text: 'add a retry to the loader', turnId: 'a2' })
    await step($ as never, 'a2', 0)
    await world.clock.settle()
    expect(world.completes.filter(prompt => PLAN_PROMPT.test(prompt))).toHaveLength(1)
    expect((await band($ as never)).text).toMatch(/Step 1 of 3 · derived/)
  })

  test('a chat prompt that then calls a tool re-derives once', async ($, on) => {
    const world = worldOf(on, { taskType: 'chat', plan: ['Find the config', 'Change the setting', 'Check it loads'] })
    STEP_ANSWERS.set('a3:0', 'Let me look.')
    await $.turn.start({ text: 'can you turn on the cache?', turnId: 'a3' })
    await step($ as never, 'a3', 0)
    await world.clock.settle()
    expect((await band($ as never)).text).toMatch(/Step 1 of 1 · answer/)

    await $.tool.call({ tool: 'Edit', file_path: '/work/config.ts', old_string: 'a', new_string: 'b' })
    await world.clock.settle()
    await $.tool.call({ tool: 'Edit', file_path: '/work/config.ts', old_string: 'b', new_string: 'c' })
    await world.clock.settle()
    expect(world.completes.filter(prompt => PLAN_PROMPT.test(prompt))).toHaveLength(1)
    expect((await band($ as never)).text).toMatch(/Step 1 of 3 · derived/)
  })

  test('zero tool calls end Answered even when the judgement pass times out', async ($, on) => {
    const world = worldOf(on, { plan: ['Look', 'Explain', 'Suggest'], stepsDone: '2, 3', modelMs: 5_000 })
    STEP_ANSWERS.set('a4:0', 'Here is how it works.')
    await $.turn.start({ text: 'how does the parser work?', turnId: 'a4' })
    await step($ as never, 'a4', 0)
    await world.clock.advance(6_000)
    expect((await band($ as never)).text).toMatch(/Step 1 of 3 · derived/)
    const done = $.turn.complete({ turnId: 'a4', answer: 'Here is how it works.', durationMs: 1, isAborted: false, reason: 'answer' })
    await world.clock.advance(1_600)
    await done
    const ended = await band($ as never)
    expect(ended.border).toBe('success')
    expect(ended.text).toMatch(/✓ Answered · /)
    expect(ended.text).not.toMatch(/Not reached/)
  })

  test('a judgement pass that marks every step: All done, with the basis named', async ($, on) => {
    const world = worldOf(on, { taskType: 'build', plan: ['Read', 'Edit', 'Report'], stepsDone: '2, 3' })
    STEP_ANSWERS.set('a5:0', 'Reading.')
    await $.turn.start({ text: 'fix it', turnId: 'a5' })
    await step($ as never, 'a5', 0)
    await world.clock.settle()
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
    await $.turn.complete({ turnId: 'a5', answer: 'Edited and reported.', durationMs: 1, isAborted: false, reason: 'answer' })
    const ended = await band($ as never)
    expect(ended.text).toMatch(/✓ All done/)
    expect(ended.text).toMatch(/steps judged from the answer/)
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
