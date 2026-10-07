import { describe, expect, test } from 'claude-code/testing'

import {
  derivedPlan,
  emptyPlan,
  onTaskCreate,
  onTaskUpdate,
  onTodoWrite,
  parseDerivedSteps,
} from '../src/milestones'
import { linesOf, PANE, STEP_ANSWERS, step, worldOf } from './fixtures'

describe('milestones from task tools', () => {
  test('a TaskCreate / TaskUpdate sequence yields the right list and states', () => {
    let plan = emptyPlan()
    plan = onTaskCreate(plan, '1', 'Read the code', 10)
    plan = onTaskCreate(plan, '2', 'Fix the bug', 11)
    plan = onTaskCreate(plan, '3', 'Run the tests', 12)
    expect(plan.source).toBe('tasks')
    expect(plan.items.map(m => [m.label, m.state])).toEqual([
      ['Read the code', 'pending'],
      ['Fix the bug', 'pending'],
      ['Run the tests', 'pending'],
    ])

    plan = onTaskUpdate(plan, { taskId: '1', status: 'in_progress' }, 20)
    plan = onTaskUpdate(plan, { taskId: '1', status: 'completed' }, 30)
    plan = onTaskUpdate(plan, { taskId: '2', status: 'in_progress' }, 31)
    plan = onTaskUpdate(plan, { taskId: '3', subject: 'Run bun test' }, 32)
    expect(plan.items.map(m => [m.label, m.state])).toEqual([
      ['Read the code', 'done'],
      ['Fix the bug', 'current'],
      ['Run bun test', 'pending'],
    ])
    expect(plan.items[0]).toMatchObject({ startedAt: 20, doneAt: 30 })

    plan = onTaskUpdate(plan, { taskId: '3', status: 'deleted' }, 40)
    expect(plan.items.map(m => m.label)).toEqual(['Read the code', 'Fix the bug'])

    // An update for a task this turn never saw is ignored, not invented
    expect(onTaskUpdate(plan, { taskId: '99', status: 'completed' }, 50)).toEqual(plan)
  })

  test('TodoWrite replaces the list wholesale', () => {
    const plan = onTodoWrite(emptyPlan(), [
      { content: 'one', status: 'completed', activeForm: 'Doing one' },
      { content: 'two', status: 'in_progress', activeForm: 'Doing two' },
      { content: 'three', status: 'pending', activeForm: 'Doing three' },
    ], 5)
    expect(plan.source).toBe('tasks')
    expect(plan.items.map(m => m.state)).toEqual(['done', 'current', 'pending'])
  })

  test('a derived plan is labelled derived and holds 2..8 steps', () => {
    const plan = derivedPlan(['a', 'b', 'c'], 0)
    expect(plan.source).toBe('derived')
    expect(plan.items.map(m => m.state)).toEqual(['current', 'pending', 'pending'])
    expect(parseDerivedSteps('1. Read the code\n2) Fix it\n- Run tests\n\n')).toEqual(['Read the code', 'Fix it', 'Run tests'])
    expect(parseDerivedSteps('just one line')).toEqual([])
    expect(parseDerivedSteps(Array.from({ length: 12 }, (_, i) => `${i}. s${i}`).join('\n'))).toHaveLength(8)
  })
})

describe('milestones in the pane', () => {
  test('task tools drive the list: done, current, pending', async ($, on) => {
    worldOf(on)
    await $.turn.start({ text: 'fix the parser', turnId: 'm1' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Read the code', description: 'x' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Fix the bug', description: 'x' })
    await $.tool.call({ tool: 'TaskCreate', subject: 'Run the tests', description: 'x' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
    await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = linesOf(await ui.drawn())
    expect(lines).toContain('✓ Read the code')
    expect(lines).toContain('▸ Fix the bug')
    expect(lines).toContain('· Run the tests')
    expect(lines.join('\n')).not.toMatch(/derived/)
  })

  test('with no task tools by the first step, the derived plan shows labelled derived', async ($, on) => {
    const world = worldOf(on, { plan: ['Read the code', 'Fix the bug', 'Run the tests'] })
    STEP_ANSWERS.set('m2:0', 'Let me look at the parser first.')
    await $.turn.start({ text: 'fix the parser', turnId: 'm2' })
    await step($ as never, 'm2', 0)
    await world.clock.settle()

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const lines = linesOf(await ui.drawn())
    expect(lines.some(line => /derived/.test(line))).toBe(true)
    expect(lines).toContain('▸ Read the code')
    expect(lines).toContain('· Run the tests')
    expect(world.completes).toHaveLength(1)
  })
})
