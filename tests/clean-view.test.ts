import { describe, expect, test } from 'claude-code/testing'

import { linesOf, PANE, toolRowOf, worldOf } from './fixtures'

const ENGINE = 'drawn by Claude Code'

describe('clean view', () => {
  test('a plain tool row draws one dim line; milestone rows draw in full; the toggle restores', async ($, on) => {
    const world = worldOf(on)
    await $.turn.start({ text: 'fix x', turnId: 'c1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/a.ts' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/x.ts', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'bun test' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "fix x"' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await $.tool.call({ tool: 'Bash', command: 'ls -la' })
    const [readId, firstEditId, secondEditId, testId, commitId, prId, lsId] = world.toolIds

    // A Read: one dim row, no newline
    const read = await $.ui.mount({ ...toolRowOf(readId!, 'Read', { file_path: '/work/src/a.ts' }), surface: 'terminal' })
    const drawn = (await read.drawn()) as { type: string; props: { dimColor?: boolean } }
    expect(drawn.type).toBe('Text')
    expect(drawn.props.dimColor).toBe(true)
    expect(linesOf(drawn)).toEqual(['● Read src/a.ts'])

    // Its result: one dim row too
    const result = await $.ui.mount({
      plugin: 'receipts',
      component: 'ToolResult',
      requestId: readId!,
      surface: 'terminal',
      props: { tool_use_id: readId!, tool: 'Read', output: { type: 'text', file: { content: 'a\nb\nc' } }, isErrored: false },
    })
    expect(linesOf(await result.drawn())).toEqual(['⎿ 3 lines'])

    // First edit of a file this turn: a milestone, drawn by Claude Code
    const firstEdit = await $.ui.mount({ ...toolRowOf(firstEditId!, 'Edit', { file_path: '/work/src/x.ts' }), surface: 'terminal' })
    expect(linesOf(await firstEdit.drawn())).toEqual([ENGINE])

    // A second edit of the same file is not a new milestone
    const secondEdit = await $.ui.mount({ ...toolRowOf(secondEditId!, 'Edit', { file_path: '/work/src/x.ts' }), surface: 'terminal' })
    expect(linesOf(await secondEdit.drawn())).toEqual(['● Edit src/x.ts'])

    // Verify runs, commits and PRs: always in full
    for (const [id, command] of [[testId, 'bun test'], [commitId, 'git commit -m "fix x"'], [prId, 'gh pr create --fill']] as const) {
      const row = await $.ui.mount({ ...toolRowOf(id!, 'Bash', { command }), surface: 'terminal' })
      expect(linesOf(await row.drawn()), command).toEqual([ENGINE])
    }
    const ls = await $.ui.mount({ ...toolRowOf(lsId!, 'Bash', { command: 'ls -la' }), surface: 'terminal' })
    expect(linesOf(await ls.drawn())).toEqual(['● Bash ls -la'])

    // A subagent that finished is a milestone
    const agent = await $.ui.mount({ ...toolRowOf('agent-1', 'Agent', { description: 'scan', prompt: 'p' }), surface: 'terminal' })
    expect(linesOf(await agent.drawn())).toEqual([ENGINE])

    // A folded group: one dim line
    const group = await $.ui.mount({
      plugin: 'receipts',
      component: 'ToolGroup',
      requestId: 'g1',
      surface: 'terminal',
      props: {
        calls: [
          { tool_use_id: 'x1', tool: 'Read', input: { file_path: '/work/a' }, isRunning: false, isErrored: false, isInterrupted: false },
          { tool_use_id: 'x2', tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: false, isInterrupted: false },
        ],
        isActive: false,
        isExpanded: false,
      } as never,
    })
    expect(linesOf(await group.drawn())).toEqual(['● 2 calls: Read, Grep'])

    // Toggle off from the pane: every row is Claude Code's again
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await pane.find({ key: 'clean-toggle', text: 'clean view on' })).toBeDefined()
    await pane.press({ key: 'clean-toggle' })
    expect(await pane.find({ key: 'clean-toggle', text: 'clean view off' })).toBeDefined()
    const again = await $.ui.mount({ ...toolRowOf(readId!, 'Read', { file_path: '/work/src/a.ts' }), surface: 'terminal' })
    expect(linesOf(await again.drawn())).toEqual([ENGINE])

    // And back on
    await pane.press({ key: 'clean-toggle' })
    const third = await $.ui.mount({ ...toolRowOf(readId!, 'Read', { file_path: '/work/src/a.ts' }), surface: 'terminal' })
    expect(linesOf(await third.drawn())).toEqual(['● Read src/a.ts'])
  })

  test('clean view off in config starts with full rows', { options: { cleanView: false } }, async ($, on) => {
    const world = worldOf(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.turn.start({ text: 'x', turnId: 'c2' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/a.ts' })
    const row = await $.ui.mount({ ...toolRowOf(world.toolIds[0]!, 'Read', { file_path: '/work/src/a.ts' }), surface: 'terminal' })
    expect(linesOf(await row.drawn())).toEqual([ENGINE])
  })
})
