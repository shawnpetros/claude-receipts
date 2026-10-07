# receipts

A Claude Code mod that says **UNVERIFIED** when Claude claims done without a check. Under every answer that claims done, a receipt line names the test or build that ran after the last edit, or says that nothing did. It also replaces the wall of tool calls with a progress band that tells the truth.

The name reads like a cost meter, and it isn't one. It's a verification receipt.

It does three jobs:

1. **Receipts.** When the turn ends, if the answer claims done and nothing verified the work after the last edit, a line says so under the answer. If something did, the line shows what ran and how it went, and what the turn cost when Claude Code knows.
2. **Milestones instead of tool walls.** A bordered band directly above the prompt shows what the turn is working on, what's finished and what's left. At the default quiet level, ordinary tool rows draw nothing, during the turn and after it, and so does most of the chrome a turn scatters. The rows that matter still show, one dim line each with how they ended: the first edit of each file, test and build runs, commits, pull requests, and finished subagents.
3. **An estimate that learns and doesn't lie.** It stays indeterminate until there's a basis. Then it shows a range, names where the range comes from, and shows how often its past ranges were right. The range narrows as steps finish.

Tested with Claude Code 2.1.291. Mods need 2.1.287 or later.

## Install

```bash
claude --plugin-dir ~/projects/claude-receipts
```

That loads the mod for one session. Nothing opens by itself: the band appears above the prompt when you send a prompt. `/receipts` opens a pane with the long view if you want it.

Or install it from its marketplace:

```bash
claude plugin marketplace add shawnpetros/claude-receipts
claude plugin install receipts@claude-receipts
```

Use one or the other, not both. With `--plugin-dir` and the installed copy in one session, two copies of the mod draw the same band and keep separate state.

To check that it's learning, finish a turn and run `/receipts stats`. The count of finished tasks should go up by one.

## The band

While a turn runs, the band has an orange border and these rows:

- **Title.** A ✶, your prompt cut to fit, and the elapsed time on the right.
- **Summary.** `Step 2 of 4`, a full-width bar, the percent done, then the estimate in dim text with its basis, such as `~4 to 9 min · from 3 similar tasks`. The percent is weighted by how long each step is expected to take.
- **One row per step.** A 12-cell bar for the step and a word: `Working`, `Next`, `Later` or `Done`. At most six steps show, around the current one, then `+n more`.

When the turn ends, the band always leaves the working state. It becomes a completion card and stays until your next prompt:

- **All done.** A green border and a `✓ All done` badge, only when every step finished. A task-tool plan counts as finished when every task is completed.
- **Turn ended short.** A grey `■ Turn ended · 2 of 5 steps reached` badge when steps were left. Those steps read `Not reached`, never `Done`.
- **Verified.** A green border and a `✓ All done · bun test 152 pass` badge, every step ticked with a full bar, and `took 1m 47s` on the right.
- **Unverified.** A yellow border and a `⚠ Done, unverified` badge. The title row shows the receipt, such as `claimed done, no test/build/run after the last edit (src/x.ts at 14:02)`. When that doesn't fit, it shortens to the file and time first.
- **A failed check.** A yellow `✗ Done, checks failed` badge and the run that failed.
- **Stopped.** A grey `■ Stopped` badge when you interrupt the turn.

If agents the turn started are still running when it ends, the title row says `waiting on 2 agents`. The count drops as each one finishes, and the next prompt clears it.

A plan the mod derived marks a step done when a small model says the assistant's latest message finished it. When the turn ends, one more pass reads the final answer against the steps still open and marks the ones it shows were completed. That pass has 1.5 seconds. If it misses, the card says how far the plan got rather than guess.

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
- **R O W S.** Off, Clean or Quiet: how much of the transcript the mod draws away. See below.
- **S E T T I N G S.** An On and Off switch for the spike.

Your plugin settings can't change while a session runs, so these choices override them for the rest of the session. `/clear` puts your settings back.

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
- **The rows level only changes drawing.** The transcript is never modified. Set it to Off and every row is back exactly as it was.
- **The receipt reports and never blocks.** It never stops a turn or holds one back. The worst it does is wait up to 1.5 seconds for a label.

## How the estimate works

Each task is filed under a shape: task type (build, debug, research, writing, config or refactor), step count (1, 2-3, 4-6 or 7+), a hash of the repository, whether the repository has tests, and the tool mix. Remaining time is the sum of the expected time of each step not yet done. The expectation comes from the most specific shape with at least 3 past tasks. Failing that, it falls back to a coarser shape, and then to a global prior.

The spread counts only the steps that are left, so it shrinks as steps finish. When a shape is new and the plan has 3 or more steps, the mod asks one cheap, read-only subagent for minutes per step. It does this once per task shape per session, with a 60-second limit, and counts the answer as half of one past task. It never does it for research, writing or chat tasks, whose steps are cheap.

Time spent waiting on a permission prompt isn't learned as work. Claude Code reports each tool's own run time without the prompt. The rest of the call is waiting, and it comes out of the step and the total before they're saved. Calibration is still scored on the wall clock, because that's what the range promised.

History lives in the mod's own store. Only finished task records are saved, and the averages are rebuilt from them. The store keeps the newest 500 tasks and stays under 1 MiB.

## Receipts

Each turn keeps a ledger of edits and of shell commands that look like verification: test runners, `tsc`, linters, builds and `make check`. At the end of the turn:

| What happened | Line under the answer |
| :- | :- |
| Edited, claimed done, nothing verified after the last edit | `UNVERIFIED · claimed done, no test/build/run after the last edit (src/x.ts at 14:02)` |
| Edited, claimed done, a verify run after the last edit | `receipt · bun test ✓ 152 pass · 1m ago` |
| A verify run after the last edit that failed | `receipt · bun test ✗ exit 1 · 150 pass · 2 fail · 5s ago` |
| No edits, or the answer doesn't claim done | nothing |

When Claude Code reports usage, the line ends with what the turn cost:

| Who you are | What the line adds |
| :- | :- |
| A Claude plan user, with rate-limit windows | `5h window 6% used, resets 18:30` |
| An API key user, with no windows | `$0.42 this turn` |
| Neither is known | nothing, never a guess |

If the current turn's receipt line is wrong, for example it called an answer done when it wasn't, run `/receipts wrong`. Each receipt can be marked once. `/receipts stats` shows `claims-done false positives: 1 of 12 receipts (8%)`. That number is the precondition for ever letting the receipt block a turn. See the roadmap.

A small model decides whether the answer claims done. If its label isn't back within 1.5 seconds, plain completion words in the answer decide instead.

## Commands

| Command | What it does |
| :- | :- |
| `/receipts` | Opens or closes the pane, the long view with the calibration line |
| `/receipts tools` | Opens the settings popover in the band |
| `/receipts rows [off\|clean\|quiet]` | Sets the rows level, or steps to the next one with no argument |
| `/receipts clean` | Switches the rows level to Off, and back to what it was |
| `/receipts basis` | Shows or hides the basis tooltip, as `b` does |
| `/receipts stats` | Shows the calibration history and task counts by type, with median durations |
| `/receipts wrong` | Marks the current turn's receipt line as a false positive, for the count in stats |
| `/receipts reset-history` | Forgets every learned task |

In the pane, `c` switches the rows level to Off and back, and `b` shows where the estimate comes from.

## Rows level

The rows level sets how much of the transcript the mod draws away. Quiet is the default.

| Level | What draws |
| :- | :- |
| Off | Every row exactly as Claude Code draws it |
| Clean | Tool rows as one dim line each, such as `● Edit src/x.ts`. Milestone rows in full. |
| Quiet | See below |

Quiet goes further:

- **Tool rows.** Ordinary tool rows, their results and folded groups draw nothing, during the turn and after it. Each milestone becomes one dim line with how it ended, such as `● Bash bun test ✓`.
- **The spinner.** It draws nothing, because the band already shows the elapsed time and the step.
- **While a turn runs.** Progress pills, the turn-duration line, status notices and other commands' output draw nothing. This mod's own output and any error line always show.
- **Hand-backs.** A subagent's hand-back, a message from another session or a task notification draws nothing while the turn runs. After the turn it draws one dim line, such as `↳ message from @Explore: Found 3 mods`.
- **Assistant text.** Text between tool calls draws as its first line, dim. The final answer draws in full once the turn completes.

Your own prompts always draw in full. Quiet never touches a question the assistant asks you or a permission prompt.

ctrl+o is the escape hatch. It shows the full transcript, and a hand-back row it expands draws in full. ctrl+o also expands a folded group of reads and searches. A single tool row or a block of assistant text can't be expanded past the level, because Claude Code doesn't tell a mod when one is expanded. Set the level to Off to see those in full.

## Configuration

Set these under `pluginConfigs` in your Claude Code settings. Use the key `receipts@inline` for a session started with `--plugin-dir`.

| Key | Default | What it does |
| :- | :- | :- |
| `spike` | `true` | Allows the sizing subagent for unfamiliar tasks. Set it to `false` and the mod never spawns one. |
| `cleanView` | `true` | Starts each session at the quiet rows level. Set it to `false` to start at Off. The popover and `/receipts rows` change it for the session. |

## What it reaches

The mod calls the model API for its labels and the derived plan, and spawns a subagent for the spike. It makes no other network calls and sends no telemetry of its own. The only thing it writes is its own store.

## Known issues

- **VS Code** draws no pane and no band, so only the receipt line and the transcript rows show. This is tracked upstream as anthropics/claude-code #99423 and #99691.
- **Claude Code Desktop** drops commands a mod registers, so `/receipts` and its subcommands aren't there. The band's keys still work.
- **Two copies at once.** Don't load the inline copy (`--plugin-dir`) and the marketplace install in the same session. Both draw the same band and keep separate state, so the band you see may belong to the copy that missed the turn's end.
- **Builds before 2.1.287** don't run mods. `hooks/hooks.json` carries an empty `hooks` key beside `modules`, so an older build loads nothing instead of failing.

## Roadmap

Each release answers one question it can measure.

- **0.3: can someone use it without a manual?** Everything from the 0.2 brief that hasn't landed yet. The test is a new user reading only the band and `/receipts` help.
- **0.4: does the receipt change behaviour?** The cost line from `$.session.usage()` already shipped in 0.2.2. The rest is an optional gate that turns UNVERIFIED from a mirror into a block, off by default. It ships only after the claims-done classifier's false-positive rate has been measured over enough live turns with `/receipts wrong` and `/receipts stats`. A gate that blocks a finished turn gets the mod uninstalled.

Not planned: token meters, burn bars, or a rename.

## Development

```bash
claude plugin validate . --strict
claude plugin test
bun scripts/simulate.ts
bun scripts/mock-band.ts 155
bun scripts/check-manifest.ts
```

`scripts/mock-band.ts` prints the band as plain text in each state: working, over the range, verified, unverified, narrow, collapsed, with the tooltip, and the popover. It uses the same pure view the mod draws from. The argument is the band's width, which is the terminal's width less 5.

`src/` holds the logic as plain modules with no mods API dependency. These are the estimator, history, milestones, ledger, shape, spike, view and band modules, plus a session that talks to Claude Code through a small host interface. `hooks/register.ts` builds that host from `$` and wires the hooks.
