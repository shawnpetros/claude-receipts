# receipts, a Claude Code mod

Status: spec, 2026-10-07. Personal tooling. Owner of invariants, tests and review: Shawn. Implementation: an agent.

## 0. Goal

Replace the wall of tool calls with a progress view that tells the truth, and refuse to let "done" pass
without a receipt. Three jobs:

1. **Milestones, not tool walls.** Show what the turn is working on, what is finished, what is left.
   Collapse raw tool rows behind a toggle. Surface the few interim events that matter (file edited,
   tests run with result, commit, PR, subagent finished).
2. **An estimate that learns and never lies.** Indeterminate until there is a basis, then a range with
   the basis named and the mod's own calibration shown. Narrows as the task takes shape and as steps
   complete. Spikes a cheap subagent to size an unfamiliar task shape.
3. **Receipts.** On turn end, if the assistant claims done and no verifying command ran after the last
   edit, say so under the answer. If one did, print the receipt.

Evidence this answers (Jev audit, 769 conversations): stopped_short 61%, claimed_done_unverified 69% in
Claude Code, overloaded_prompt 77%, outcome partial 26%.

## 1. Surfaces (mods API, docs at code.claude.com/docs/en/plugins/mods)

- The `AbovePrompt` band is the primary surface (revised 2026-10-07; the auto-opened dock pane took a
  third of a fullscreen terminal for four lines). A round-bordered block: title row (prompt, elapsed,
  `[-]`), a summary row (step i of n, a step-weighted bar, percent, the estimate range with its basis),
  one row per step (12-cell bar and a state word, six at most, then `+n more`). Below 110 columns the
  step bars drop. On turn end it becomes the completion card (green, or warning when UNVERIFIED or a
  check failed) until the next prompt. `Pane` opens only on `/receipts`.
- `ui.render` on `ToolUse`, `ToolResult`, `ToolGroup` rows: when clean view is on, draw one dim line
  per call (`● Edit src/x.ts`, `⎿ 12 lines`) instead of the full block. Milestone events draw normally.
  Suppression (on by default) goes further while a turn runs: plain rows draw nothing, milestone
  events one dim line each with their outcome.
- Settings popover in the band (`t`, `/receipts tools`): model and effort chips, switches for clean
  view, the spike and suppression. Drawn in the band because a `Pane` cannot ask to be inline.
- `turn.complete` `{ text }`: one receipt line under the answer.
- Buttons: `clean view on/off`, `estimate basis`, `park` (no-op placeholder for a later mod; hidden).
- Commands: `/receipts` (toggle pane), `/receipts tools`, `/receipts stats` (calibration history),
  `/receipts reset-history`.

## 2. Milestones

Source of truth, in order of preference:
1. Task tools: `TaskCreate` / `TaskUpdate` calls observed on `tool.call` give a live list with states.
2. If none by the first assistant step, derive a plan: `$.model.classify` over the user prompt and the
   assistant's first text block → 2..8 steps, each a short noun phrase. Mark "derived" in the pane.
3. Fallback: a single milestone "the task".

Step completion signals: TaskUpdate completed; or classify on each `turn.step` result text that a derived
step is done (cheap, cached per step). Milestone events, always shown even in clean view: Edit/Write of
a file not seen before this turn, any Bash whose command matches a verify pattern with its exit code,
`git commit`, `gh pr create`, subagent finished, test counts.

## 3. Estimate

**Task shape** (the key for learning): `{task_type, step_count_bucket (1,2-3,4-6,7+), repo (hash of
$.session.repo or cwd), has_tests (bool), tool_mix_bucket}`. task_type from classify over the prompt
(build/debug/research/writing/config/refactor).

**History**, in `$.store` (4 MiB cap, prune to last 500 tasks): per shape key, per step index, observed
durations; per shape, total durations; global prior across all shapes. Store EMA mean and variance.

**Estimate = remaining time** = Σ over remaining steps of expected step duration, using the most specific
bucket with ≥3 samples, else parent buckets, else global prior. Interval = mean ± k·σ where σ shrinks with
samples and with fraction complete (remaining uncertainty only). Confidence = f(samples in bucket,
fraction complete, variance), 0..1.

**Spike.** When the shape bucket has <3 samples and the plan has ≥3 steps, once per task, spawn a
subagent (`$.agent.spawn`, cheapest model available, 60s cap) with the plan and repo summary, asking for
minutes per step and a 1..5 confidence. Treat as one sample at weight 0.5. Pane shows "spike guess"
while it is the only basis. Can be turned off in userConfig.

**Display rules** (the honesty contract):
- `indeterminate` only while there is no plan AND no history. Hard cap: by the first completed milestone
  or 90 seconds, whichever first, show a range from the global prior.
- Always a range, never a point: `~4 to 9 min`. Basis always named: `from 7 similar tasks`,
  `spike guess`, `prior only`, `derived plan`.
- Countdown digits appear only when confidence ≥ 0.5; below that show the range and a bar.
- When elapsed exceeds the range: `over by 2m 10s`, the bar turns dim, the estimate re-widens using
  elapsed as a lower bound. Never freezes, never resets to indeterminate.
- Calibration line: in the pane, `/receipts stats`, and the band's `b` tooltip:
  `calibration: 61% of 18 tasks ended inside the range`. Below 50% after ≥10 tasks: the band says so in
  plain words, permanently, and it cannot be folded away.
- Progress bar is by steps weighted by expected duration, not by count.

**Learning.** On turn end with a completed task, write actual durations per step and total under the
shape key; update calibration (was the actual inside the last displayed range before the final step).

## 4. Receipts (done-gate)

Ledger per turn: last edit time (Edit/Write/NotebookEdit/MultiEdit), every Bash matching the verify
pattern `(test|spec|jest|vitest|pytest|cargo (test|check|clippy)|go test|bun test|npm (test|run (test|build|lint))|pnpm|tsc|eslint|ruff|mypy|make (test|check)|build)` with exit code. On `turn.complete`,
classify the final assistant text: claims done? If yes and no verify after last edit → text line:
`UNVERIFIED · claimed done, no test/build/run after the last edit (src/x.ts at 14:02)`. If yes and
verified → `receipt · bun test ✓ 152 pass · 1m ago`. If the task has no edits, no line. Never block the
turn; this is a mirror, not a gate, in v1.

## 5. Invariants, each with its scar

1. **Never a point estimate, never a frozen countdown.** Scar: every "ETA" in every tool ever.
2. **Indeterminate is time-boxed.** Scar: Shawn's own words, "don't cheat and just stay indeterminate."
3. **Basis always named, calibration always shown.** The mod reports its own hit rate; a bad score is
   displayed, not hidden. (Revised 2026-10-07: a passing score moved behind `b` to keep the band small;
   a failing one stays on the band.)
4. **Clean view hides rendering only.** The transcript rows are untouched; toggling off shows everything.
   Scar: the original /buddy main-model leak; a mod rewriting content is a different and riskier thing.
5. **Milestone events are never hidden.** Edits, verify runs with exit code, commits, PRs.
6. **Hooks return fast.** Any model call is awaited off the hot path (10s hook cap; keep under 2s).
   Classify results cached per step per turn.
7. **No network except the model API and the subagent.** No telemetry of its own.
8. **Store stays under 1 MiB** by pruning oldest tasks first.
9. **A derived plan is labelled derived.** The mod never presents its own guess as the assistant's plan.

## 6. Adversarial tests (claude plugin test, write first)

- Estimator: zero history → indeterminate; after 90s mocked clock → prior range shown.
- Estimator: with 3 samples in bucket, range narrows monotonically as steps complete (σ non-increasing).
- Estimator: elapsed beyond upper bound → "over by" string, lower bound ≥ elapsed, never indeterminate.
- Estimator: countdown digits absent when confidence < 0.5, present at ≥ 0.5.
- Calibration: 10 synthetic tasks, 6 inside range → 60%; message appears at <50% with ≥10 tasks.
- Store pruning: 600 tasks inserted → ≤500 kept, oldest dropped, size under 1 MiB.
- Spike: shape with <3 samples and ≥3 steps spawns exactly one subagent per task; 2 samples + spike
  weight = 2.5; spike off in config → never spawns.
- Milestones: TaskCreate/TaskUpdate sequence yields the right list and states; derived plan labelled.
- Clean view: ToolUse render returns one row; milestone edits/verify runs render fully; toggle restores.
- Receipt: edit then `bun test` exit 0 then "done" → receipt line; edit then "done" with no verify →
  UNVERIFIED line; no edits → no line; verify before the last edit → UNVERIFIED.
- Hook budget: every hook under 2s with model calls stubbed to 1.5s.
- Band: at 160 and 100 cols, title + summary + one row per step, every row exactly the inner width;
  step bars only at ≥110; collapse leaves the title row; the completion card recolours with its badge
  variants; no pane opens unasked.
- Suppression: plain tool rows draw nothing mid-turn, milestones one dim line, full after the toggle.
- Popover: the current model highlighted; a pick goes through the /config row, else /model.

## 7. Out of scope v1

Blocking the turn on UNVERIFIED, parking lot, receiver stamp, per-project config, desktop-only SVG.
