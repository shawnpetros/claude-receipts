import { describe, expect, test } from 'claude-code/testing'

import { emptyPlan, onTaskCreate, onTaskUpdate, onTodoWrite } from '../src/milestones'
import { linesOf, PANE, worldOf } from './fixtures'

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

  // 0.3.0: "a derived plan is labelled derived and holds 2..8 steps" was
  // deleted with plan derivation (SPEC-0.3 invariant 10)
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

  // 0.3.0: "with no task tools by the first step, the derived plan shows
  // labelled derived" was deleted with plan derivation (SPEC-0.3 invariant 10)
})
