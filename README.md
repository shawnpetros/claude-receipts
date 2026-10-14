# receipts

A Claude Code mod that says **UNVERIFIED** when Claude claims done without a check. Under every answer that claims done, a receipt line names the command that verified the work after the last edit, with its exit code and the runner's own summary line, or says that nothing did. A second, read-only agent then tries to refute the claim. It also replaces the wall of tool calls with a progress band that shows Claude's own plan.

The name reads like a cost meter, and it isn't one. It's a verification receipt.

It does three jobs:

1. **Receipts.** When the turn ends, if the answer claims done and nothing verified the work after the last edit, a line says so under the answer. If something did, the line shows the command, its exit code and its summary line, and what the turn cost when Claude Code knows. A cross-check agent re-runs the gate where it can and says whether it agrees.
2. **Milestones instead of tool walls.** A bordered band directly above the prompt shows the plan Claude recorded with its task tools: what it's working on, what's finished and what's left. The mod never makes steps up. At the default quiet level, ordinary tool rows draw nothing, during the turn and after it, and so does most of the chrome a turn scatters. The rows that matter still show, one dim line each with how they ended: the first edit of each file, test and build runs, commits, pull requests, and finished subagents.
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

The steps are Claude's own, recorded with TaskCreate and TaskUpdate. If Claude records none, there are no steps: the second row reads `working · 1m 13s` with the estimate, and there's no percent to make up.

When the turn ends, the band always leaves the working state. It becomes one of six cards and stays until your next prompt:

| Card | Border | When |
| :- | :- | :- |
| Working | orange | The turn is running |
| `■ Turn ended · 2 of 5 steps reached` | grey | Steps were left, or work stopped without a claim of done. Unfinished steps read `Not reached`, never `Done`. |
| `✓ All done` | green | Every recorded step completed, a passing verify ran after the last edit, and the cross-check didn't refute it |
| `⚠ Done, unverified` | yellow | Claude claims done and nothing verified the work after the last edit. A failing verify reads `✗ Done, checks failed`. |
| `✗ Done, refuted` | yellow | The cross-check refuted the claim. Its reason sits in the title row, word for word. |
| `✓ Answered · 25s` | green | The turn was an answer, not a job: no edit and no real command ran |

A grey `■ Stopped` badge shows when you interrupt the turn.

After the steps, a finished card shows the receipt row, the same line printed under the answer, and the cross-check row: `cross-check · running (opus)…`, then `cross-check · ✓ confirmed (opus, reran bun test exit 0) · 38s`, `cross-check · ✗ refuted: tests cover only the happy path`, or `cross-check · ? unclear`.

If agents the turn started are still running when it ends, the title row says `waiting on 2 agents`. The count drops as each one finishes, and the next prompt clears it.

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

These are the rules the mod follows. Each one exists because some tool, somewhere, broke it.

- **Steps are never made up.** A step exists only if Claude recorded it with its task tools. Without a task list the band says `working` and shows the clock. An earlier version guessed plans of 5 or 6 steps for prompts that needed one answer, then reported `1 of 6 reached`.
- **A receipt is a command, an exit code and a summary line.** The line under the answer names the verify command, its exit code, and the runner's own summary line word for word. Nothing less is called a receipt. A `grep -i error` over a log is flagged as `grep-for-error, not a receipt`, because a warning or a swallowed summary passes that grep.
- **Only a check after the last edit counts.** A test run before the final edit verifies a different file.
- **The cross-check is independent.** A separate, read-only agent tries to refute the claim, re-running the verify command where it can. Its verdict is shown word for word and never softened.
- **All done means all three.** Every recorded step completed, a passing verify after the last edit, and no refutation. Missing any one gives a different card.
- **Never a single number.** You always get a range such as `~4 to 9 min`. A countdown never freezes. A range that would round to one value is widened until it shows two, and its low end is never 0.
- **"Indeterminate" has a time limit.** You only see it while there's no plan and no history, for at most 90 seconds. After that you get a range from the prior, labelled `prior only`.
- **The source is always named.** Every range says where it comes from: `from 7 similar tasks`, `spike guess` or `prior only`.
- **The mod reports its own score.** `b` in the band, the pane and `/receipts stats` show a line such as `calibration: 61% of 18 tasks ended inside the range`. After 10 or more tasks, if the score falls below 50%, the band says plainly that the ranges have been missing. That warning can't be hidden.
- **Countdown digits require confidence.** Digits such as `3:52 to 8:40 left` appear only when confidence is 0.5 or higher.
- **Running over is reported.** When elapsed time passes the top of the range, the row reads `over by 2m 10s` and the range widens with elapsed time as its floor. It never resets to indeterminate.
- **The rows level only changes drawing.** The transcript is never modified. Set it to Off and every row is back exactly as it was.
- **Nothing blocks.** The receipt and the cross-check never stop or hold a turn. The worst the mod does is wait 1 second for the task-type label when you submit a prompt, and 1.5 seconds for the claims-done label when the turn ends.

## How it works

**The plan.** When you submit a prompt, a small model labels its type, waiting at most 1 second. A build, debug, config or refactor prompt goes in with one extra line for Claude, the same bytes every time so the prompt cache holds: "Before non-trivial work, record your plan with TaskCreate as 2 to 8 short steps, mark each in_progress and completed with TaskUpdate as you go, and keep the list current if the plan changes." The band's steps are that list. A chat, research or writing prompt gets one "answer" step. A Read, Grep or a command that only looks around (`git status`, `ls`, `cat`) never changes that. An edit or a real command means work has started. From then on the plan comes from the task tools, or the band says `working`.

**The estimate.** Each task is filed under a shape: task type, step count (1, 2-3, 4-6 or 7+), a hash of the repository, whether it has tests, and the tool mix. Remaining time is the sum of the expected time of each step not yet done. The expectation comes from the most specific shape with at least 3 past tasks, then a coarser shape, then a global prior. Step durations come from Claude's TaskUpdate transitions, so what the mod learns is real. The spread counts only the steps left, so it shrinks as they finish.

For a build-type task with 3 or more recorded steps and no history, the mod asks one cheap, read-only subagent for minutes per step. It does this at most once per shape per session, with a 60-second limit, and counts the answer as half of one past task.

Time spent waiting on a permission prompt isn't learned as work. Claude Code reports each tool's own run time without the prompt, and the rest of the call comes out of the step before it's saved. Calibration is still scored on the wall clock, because that's what the range promised. History keeps the newest 500 tasks and stays under 1 MiB.

**The receipt.** Each turn keeps a ledger of edits, of verify commands with their exit codes and summary lines, and of greps for "error". The summary line is the runner's own, found by its known shape: bun's pass and fail lines, jest's `Tests:`, vitest's `Tests`, pytest's `=== … in 0.12s ===`, cargo's `test result:` or `error[E…]`, go's `ok` or `FAIL`, make's `make: *** … Error N`. A small model decides whether the answer claims done. If its label isn't back within 1.5 seconds, plain completion words decide instead.

| What happened | Line under the answer |
| :- | :- |
| Edited, claimed done, a passing verify after the last edit | `receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago` |
| A failing verify after the last edit | `FAILED · cargo test · exit 101 · test result: FAILED. 3 passed; 2 failed; …` |
| Edited, claimed done, nothing verified after the last edit | `UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since` |
| Only a grep for "error" after the last edit | the UNVERIFIED line, ending `(grep-for-error, not a receipt)` |
| No edits, or the answer doesn't claim done | nothing |

When Claude Code reports usage, the line ends with what the turn cost:

| Who you are | What the line adds |
| :- | :- |
| A Claude plan user, with rate-limit windows | `5h window 6% used, resets 18:30` |
| An API key user, with no windows | `$0.42 this turn` |
| Neither is known | nothing, never a guess |

**The cross-check.** When a turn with edits claims done, the mod spawns one read-only agent of the Explore type, on opus unless you set `crossCheckModel`. It gets your request and Claude's claim, each up to 800 characters, plus every verify command with its exit code and summary line, and `git diff` of the edited files. A diff over 400 lines is sent as its `--stat`, and the agent is told so. It's told to refute the claim, re-run the verify command if there is one, and call it refuted if unsure. It answers `confirmed`, `refuted` or `unclear` with a short reason, and the card shows that word for word. No answer within 90 seconds counts as unclear. It never blocks the turn and never runs more than once per turn.

It's skipped when the turn made no edits, when `crossCheck` is off or `/receipts check off` ran, in `-p` mode, and when the five-hour window is over 85% used. `/receipts stats` counts confirmed, refuted and unclear verdicts.

If the current turn's receipt is wrong, for example it called an answer done when it wasn't, run `/receipts wrong`. Each receipt can be marked once, and `/receipts stats` shows `claims-done false positives: 1 of 12 receipts (8%)`. That number is the precondition for ever letting the receipt block a turn. See the roadmap.

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
| `/receipts check [on\|off]` | Turns the cross-check on or off for this session, or says which it is |
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
| `spike` | `true` | Allows the sizing subagent for unfamiliar build-type tasks. Set it to `false` and the mod never spawns one. |
| `cleanView` | `true` | Starts each session at the quiet rows level. Set it to `false` to start at Off. The popover and `/receipts rows` change it for the session. |
| `crossCheck` | `true` | Spawns the read-only cross-check agent when a turn with edits claims done |
| `crossCheckModel` | `opus` | The model the cross-check runs on, as an alias or a model id |

## What it reaches

The mod calls the model API for its labels, spawns a subagent for the spike and one for the cross-check, and runs `git diff` on the files a turn edited. It makes no other network calls and sends no telemetry of its own. The only thing it writes is its own store.

## Known issues

- **VS Code** draws no pane and no band, so only the receipt line and the transcript rows show. This is tracked upstream as anthropics/claude-code #99423 and #99691.
- **Claude Code Desktop** drops commands a mod registers, so `/receipts` and its subcommands aren't there. The band's keys still work.
- **Two copies at once.** Don't load the inline copy (`--plugin-dir`) and the marketplace install in the same session. Both draw the same band and keep separate state, so the band you see may belong to the copy that missed the turn's end.
- **Builds before 2.1.287** don't run mods. `hooks/hooks.json` carries an empty `hooks` key beside `modules`, so an older build loads nothing instead of failing.

## Roadmap

Each release answers one question it can measure.

- **0.3: can someone use it without a manual?** Plans are Claude's own, receipts are command, exit code and summary line, and a cross-check re-runs the gate. The test is a new user reading only the band and `/receipts` help.
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

`scripts/mock-band.ts` prints the band as plain text: the six card states, then working with no task list, over the range, checks failed, narrow, collapsed, and the popover. It uses the same pure view the mod draws from. The argument is the band's width, which is the terminal's width less 5.

`src/` holds the logic as plain modules with no mods API dependency. These are the estimator, history, milestones, ledger, crosscheck, quiet, shape, spike, view and band modules, plus a session that talks to Claude Code through a small host interface. `hooks/register.ts` builds that host from `$` and wires the hooks.
