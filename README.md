# receipts

A Claude Code mod that replaces the wall of tool calls with a progress view that tells the truth, and puts a receipt under every answer that claims it's done.

It does three jobs:

1. **Milestones instead of tool walls.** A pane shows what the turn is working on, what's finished and what's left. Tool rows collapse to one dim line each. The rows that matter always draw in full: the first edit of each file, test and build runs with their exit codes, commits, pull requests, and finished subagents.
2. **An estimate that learns and doesn't lie.** It stays indeterminate until there's a basis. Then it shows a range, names where the range comes from, and shows how often its past ranges were right. The range narrows as steps finish.
3. **Receipts.** When the turn ends, if the answer claims done and nothing verified the work after the last edit, a line says so under the answer. If something did, the line shows what ran and how it went.

Tested with Claude Code 2.1.291. Mods need 2.1.287 or later.

## Install

```bash
claude --plugin-dir ~/projects/claude-receipts
```

That loads the mod for one session. The pane opens by itself on the first turn when the terminal is at least 144 columns wide. In a narrower terminal, the same content shows as a band of at most three rows above the prompt, or you can open the pane with `/receipts`.

## The honesty contract

These are the rules the estimate follows. Each one exists because some tool, somewhere, broke it.

- **Never a single number.** You always get a range such as `~4 to 9 min`. A countdown never freezes. When the range is too narrow to round to two values, it's widened until it shows two.
- **"Indeterminate" has a time limit.** You only see it while there's no plan and no history. It ends at the first finished milestone or after 90 seconds, whichever comes first. After that you get a range from the prior, labelled `prior only`.
- **The source is always named.** Every range says where it comes from: `from 7 similar tasks`, `spike guess`, `prior only`, and `derived plan` when the plan is the mod's own guess.
- **The mod reports its own score.** The pane always shows a line such as `calibration: 61% of 18 tasks ended inside the range`. After 10 or more tasks, if it falls below 50%, the pane says plainly that the ranges have been missing.
- **Countdown digits require confidence.** Digits such as `3:52 to 8:40 left` appear only when confidence is 0.5 or higher. Below that you get the rounded range and a bar.
- **Running over is reported.** When elapsed time passes the top of the range, the row reads `over by 2m 10s`, the bar dims, and the range widens with elapsed time as its floor. It never resets to indeterminate.
- **The progress bar is weighted by time.** It weights each step by how long that step is expected to take, not by the count of steps.
- **A derived plan is labelled.** When the assistant didn't make a task list, the mod asks a small model for one and marks it `derived`. The mod never passes its own guess off as the assistant's plan.
- **Clean view only changes drawing.** The transcript is never modified. Turn clean view off and every row is back exactly as it was.
- **The receipt reports and never blocks.** It never stops a turn or holds one back. The worst it does is wait up to 1.5 seconds for a label.

## How the estimate works

Each task is filed under a shape: task type (build, debug, research, writing, config or refactor), step count (1, 2-3, 4-6 or 7+), a hash of the repository, whether the repository has tests, and the tool mix. Remaining time is the sum of the expected time of each step not yet done. The expectation comes from the most specific shape with at least 3 past tasks. Failing that, it falls back to a coarser shape, and then to a global prior.

The spread counts only the steps that are left, so it shrinks as steps finish. When a shape is new and the plan has 3 or more steps, the mod asks one cheap, read-only subagent for minutes per step. It does this once per task, with a 60-second limit, and counts the answer as half of one past task.

History lives in the mod's own store. Only finished task records are saved, and the averages are rebuilt from them. The store keeps the newest 500 tasks and stays under 1 MiB.

## Receipts

Each turn keeps a ledger of edits and of shell commands that look like verification: test runners, `tsc`, linters, builds and `make check`. At the end of the turn:

| What happened | Line under the answer |
| :- | :- |
| Edited, claimed done, nothing verified after the last edit | `UNVERIFIED · claimed done, no test/build/run after the last edit (src/x.ts at 14:02)` |
| Edited, claimed done, a verify run after the last edit | `receipt · bun test ✓ 152 pass · 1m ago` |
| A verify run after the last edit that failed | `receipt · bun test ✗ exit 1 · 150 pass · 2 fail · 5s ago` |
| No edits, or the answer doesn't claim done | nothing |

A small model decides whether the answer claims done. If its label isn't back within 1.5 seconds, plain completion words in the answer decide instead.

## Commands

| Command | What it does |
| :- | :- |
| `/receipts` | Opens or closes the pane |
| `/receipts stats` | Shows the calibration history and task counts by type, with median durations |
| `/receipts reset-history` | Forgets every learned task |

In the pane, `c` toggles clean view and `b` shows where the estimate comes from.

## Configuration

Set these under `pluginConfigs` in your Claude Code settings. Use the key `receipts@inline` for a session started with `--plugin-dir`.

| Key | Default | What it does |
| :- | :- | :- |
| `spike` | `true` | Allows the sizing subagent for unfamiliar tasks. Set it to `false` and the mod never spawns one. |
| `cleanView` | `true` | Starts each session with tool rows collapsed. The pane button still toggles it. |

## What it reaches

The mod calls the model API for its labels and the derived plan, and spawns a subagent for the spike. It makes no other network calls and sends no telemetry of its own. The only thing it writes is its own store.

## Development

```bash
claude plugin validate .
claude plugin test
bun scripts/simulate.ts
```

`src/` holds the logic as plain modules with no mods API dependency. These are the estimator, history, milestones, ledger, shape, spike and view modules, plus a session that talks to Claude Code through a small host interface. `hooks/register.ts` builds that host from `$` and wires the hooks.
