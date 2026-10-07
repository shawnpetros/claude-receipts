# receipts

A Claude Code mod that replaces the wall of tool calls with a progress view that tells the truth, and puts a receipt under every answer that claims it's done.

It does three jobs:

1. **Milestones instead of tool walls.** A bordered band directly above the prompt shows what the turn is working on, what's finished and what's left. Ordinary tool rows draw nothing at all, during the turn and after it. The rows that matter still show, one dim line each with how they ended: the first edit of each file, test and build runs, commits, pull requests, and finished subagents.
2. **An estimate that learns and doesn't lie.** It stays indeterminate until there's a basis. Then it shows a range, names where the range comes from, and shows how often its past ranges were right. The range narrows as steps finish.
3. **Receipts.** When the turn ends, if the answer claims done and nothing verified the work after the last edit, a line says so under the answer. If something did, the line shows what ran and how it went.

Tested with Claude Code 2.1.291. Mods need 2.1.287 or later.

## Install

```bash
claude --plugin-dir ~/projects/claude-receipts
```

That loads the mod for one session. Nothing opens by itself: the band appears above the prompt when you send a prompt. `/receipts` opens a pane with the long view if you want it.

## The band

While a turn runs, the band has an orange border and these rows:

- **Title.** A ✶, your prompt cut to fit, and the elapsed time on the right.
- **Summary.** `Step 2 of 4`, a full-width bar, the percent done, then the estimate in dim text with its basis, such as `~4 to 9 min · from 3 similar tasks`. The percent is weighted by how long each step is expected to take.
- **One row per step.** A 12-cell bar for the step and a word: `Working`, `Next`, `Later` or `Done`. At most six steps show, around the current one, then `+n more`.

When the turn ends, the band turns into a completion card and stays until your next prompt:

- **Verified.** A green border and a `✓ All done · bun test 152 pass` badge, every step ticked with a full bar, and `took 1m 47s` on the right.
- **Unverified.** A yellow border and a `⚠ Done, unverified` badge. The title row shows the receipt, such as `claimed done, no test/build/run after the last edit (src/x.ts at 14:02)`. When that doesn't fit, it shortens to the file and time first.
- **A failed check.** A yellow `✗ Done, checks failed` badge and the run that failed.
- **Stopped.** A grey `■ Stopped` badge when you interrupt the turn.

When the elapsed time passes the top of the range, the border and bar turn grey and the summary reads `over by 2m 10s · ~1 to 4 min more`. Running long isn't an error, so it's never red.

Below 110 columns the per-step bars drop and each step keeps its word. Nothing in the band is ever wider than the terminal.

`[▾]` on the title row folds the band to that one row, and `[▸]` opens it again. Claude Code draws its own `[-]` just outside the border, and that one hides the whole band.

### Keys

Click the band, or press ctrl+x then tab, to give it the keyboard. Then:

| Key | What it does |
| :- | :- |
| `b` | Shows a one-line tooltip with the estimate's basis and the calibration score. Press again to hide it. |
| `t` | Opens or closes the settings popover |

### Settings popover

`t` or `/receipts tools` opens a small bordered panel at the right of the band. It has three sections:

- **M O D E L.** Haiku, Sonnet, Opus and Fable. The current model is highlighted. Picking one sets the `/config` model row when this build has one that takes it, and otherwise runs `/model <name>`.
- **E F F O R T.** Low, Medium, High, XHigh and Max, the same way, through `/effort`. The current level is highlighted once a model request has carried it.
- **S E T T I N G S.** On and Off switches for clean view, the spike and suppressing tool rows. Your plugin settings can't change while a session runs, so these switches override them for the rest of the session. `/clear` puts your settings back.

The `[-]` at the top right closes it, as does `t` again. Escape only hands the keyboard back to the prompt, because Claude Code tells a mod nothing when you press it.

## The honesty contract

These are the rules the estimate follows. Each one exists because some tool, somewhere, broke it.

- **Never a single number.** You always get a range such as `~4 to 9 min`. A countdown never freezes. When the range is too narrow to round to two values, it's widened until it shows two.
- **"Indeterminate" has a time limit.** You only see it while there's no plan and no history. It ends at the first finished milestone or after 90 seconds, whichever comes first. After that you get a range from the prior, labelled `prior only`.
- **The source is always named.** Every range says where it comes from: `from 7 similar tasks`, `spike guess`, `prior only`, and `derived plan` when the plan is the mod's own guess.
- **The mod reports its own score.** `b` in the band, the pane and `/receipts stats` show a line such as `calibration: 61% of 18 tasks ended inside the range`. After 10 or more tasks, if the score falls below 50%, the band says plainly that the ranges have been missing. That warning stays on the band and can't be hidden.
- **Countdown digits require confidence.** Digits such as `3:52 to 8:40 left` appear only when confidence is 0.5 or higher. Below that you get the rounded range and a bar.
- **Running over is reported.** When elapsed time passes the top of the range, the row reads `over by 2m 10s`, the bar dims, and the range widens with elapsed time as its floor. It never resets to indeterminate.
- **The progress bar is weighted by time.** It weights each step by how long that step is expected to take, not by the count of steps.
- **A derived plan is labelled.** When the assistant didn't make a task list, the mod asks a small model for one and marks it `derived`. The mod never passes its own guess off as the assistant's plan.
- **Clean view and suppression only change drawing.** The transcript is never modified. Turn clean view off and every row is back exactly as it was.
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
| `/receipts` | Opens or closes the pane, the long view with the calibration line |
| `/receipts tools` | Opens the settings popover in the band |
| `/receipts stats` | Shows the calibration history and task counts by type, with median durations |
| `/receipts reset-history` | Forgets every learned task |

In the pane, `c` toggles clean view and `b` shows where the estimate comes from.

## Clean view and suppression

Clean view is on by default. Tool rows draw as one dim line each, such as `● Edit src/x.ts`, and milestone rows draw in full.

Suppression is also on by default and goes further. Ordinary tool rows, their results and folded groups draw nothing, during the turn and after it. Each milestone becomes one dim line with how it ended, such as `● Bash bun test ✓`. Your messages and the assistant's text always draw. A finished turn leaves your prompt, the assistant's answer and the completion card.

Turn suppression off and the rows show as clean view's dim lines instead.

Turn either one off in the settings popover. With clean view off, every row draws exactly as Claude Code draws it.

ctrl+o still expands a folded group of reads and searches, because a group's drawing says when it's expanded. It can't expand a single tool row past clean view, because Claude Code doesn't tell a mod when one is expanded. Turn clean view off to see those rows in full.

## Configuration

Set these under `pluginConfigs` in your Claude Code settings. Use the key `receipts@inline` for a session started with `--plugin-dir`.

| Key | Default | What it does |
| :- | :- | :- |
| `spike` | `true` | Allows the sizing subagent for unfamiliar tasks. Set it to `false` and the mod never spawns one. |
| `cleanView` | `true` | Starts each session with tool rows collapsed. The popover and the pane still toggle it. |

## What it reaches

The mod calls the model API for its labels and the derived plan, and spawns a subagent for the spike. It makes no other network calls and sends no telemetry of its own. The only thing it writes is its own store.

## Development

```bash
claude plugin validate . --strict
claude plugin test
bun scripts/simulate.ts
bun scripts/mock-band.ts 155
```

`scripts/mock-band.ts` prints the band as plain text in each state: working, over the range, verified, unverified, narrow, collapsed, with the tooltip, and the popover. It uses the same pure view the mod draws from. The argument is the band's width, which is the terminal's width less 5.

`src/` holds the logic as plain modules with no mods API dependency. These are the estimator, history, milestones, ledger, shape, spike, view and band modules, plus a session that talks to Claude Code through a small host interface. `hooks/register.ts` builds that host from `$` and wires the hooks.
