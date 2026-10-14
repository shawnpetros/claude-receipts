# receipts 0.3.0: plan-first clean view, honest runtimes, built-in verification

Status: spec, 2026-10-14. Supersedes the plan-derivation half of SPEC.md; everything else in SPEC.md
(estimator honesty, quiet suppression, band layout, store, calibration) stays.

## Why a rebuild

Live use showed two failures. First, derived plans: the mod invented 5 or 6 steps for prompts that needed
one answer, then reported "1 of 6 reached". A single Read promoted an answer into a fake plan. Second,
the receipt was a mirror of a regex, not a verification. Shawn's own gates (shawn-mode) say what a
receipt is: the exact CI target, its exit code, the summary line verbatim, and an independent reader
who re-runs the gate before "done" is believed.

## 1. Plan-first, never derived

- Delete plan derivation. The mod never invents steps.
- For prompts classified build / debug / config / refactor (one classify at `turn.start`, cached), the
  mod adds a `prompt.context` section, byte-stable so it caches: "Before non-trivial work, record your
  plan with TaskCreate as 2 to 8 short steps, mark each in_progress and completed with TaskUpdate as you
  go, and keep the list current if the plan changes." Milestones are then Claude's real plan.
- If Claude never calls the task tools, the band shows one row: "working · 1m 13s" with the elapsed
  and the estimate from the shape prior. No fake steps, no percent.
- Writing / chat / research prompts: the one-step "answer" plan and the green "✓ Answered · 25s" card,
  as in 0.2.4. A Read, Grep or Glob never changes the plan shape. Only Edit, Write, NotebookEdit or a
  non-trivial Bash (not git status/log/diff, ls, cat) counts as work starting, and even then the plan
  comes from the task tools or stays at "working".

## 2. Estimates

Unchanged contract (range, basis, calibration, 90 s cap, over-by). Step durations now come from
TaskUpdate transitions, so learning is real. The spike stays for build-type tasks with 3 or more
planned steps and no history, once per shape per session. Permission wait subtraction stays.

## 3. Receipts, by Shawn's definition

Ledger per turn:
- every Bash call whose command matches the verify pattern, with: command verbatim, exit code (from
  the result's isError and "Exit code N"), and the summary line verbatim, found by known shapes
  ("N pass", "N passed, M failed", "Tests: ...", "ok", "error[E...]", "FAIL", "make: *** ... Error N");
- the time of the last Edit/Write/NotebookEdit.
Rules:
- A verify counts only if it ran after the last edit.
- A `grep -i error` (or similar) over a log is flagged as "grep-for-error, not a receipt".
- The receipt line: `receipt · bun test · exit 0 · 105 pass, 0 fail · 1m ago`.
- UNVERIFIED: `UNVERIFIED · claims done · last edit src/x.ts 14:02 · no verify since`.
- A failing verify after the last edit: `FAILED · cargo test · exit 101 · 2 failed` in warning colour,
  and the card never reads All done.

## 4. Adversarial cross-check

When a turn ends, Claude's final text claims done, and at least one edit happened:
- Spawn one read-only subagent (`$.agent.spawn`, Explore type, model from userConfig
  `crossCheckModel`, default `opus`, 90 s cap, once per turn). Input: the user's ask (first message
  ≤800 chars), Claude's final claim (≤800), the ledger (commands, exit codes, summary lines), and the
  diff of touched files (`$.process.run(['git','diff','--','<files>'])`, capped at 400 lines; above
  that, send the stat and say "diff too large to read in full").
- Instruction: "Try to refute the claim that this work is done and verified. Re-run the verify
  command if one exists (read-only otherwise). Default to refuted if uncertain." Output JSON
  `{verdict: confirmed|refuted|unclear, reason ≤120 chars, reran: bool, exit: n|null}`.
- Card gets a third row: `cross-check · ✓ confirmed (opus, reran bun test exit 0) · 38s`, or
  `cross-check · ✗ refuted: tests cover only the happy path`, or `cross-check · ? unclear`.
- Never blocks the turn. `/receipts stats` counts confirmed/refuted/unclear and false positives
  marked with `/receipts wrong`.
- Skips: no edits; userConfig `crossCheck: false`; `/receipts check off`; turns in `-p` mode.
- Cost guard: at most one spawn per turn; none if the 5-hour window is above 85% per
  `$.session.usage()`.

## 5. Card states

Working (accent border) · Turn ended, k of n reached (grey) · All done (green, only when every task
completed AND receipt present AND cross-check not refuted) · Done, unverified (warning) · Done, refuted
(warning, with the reason) · Answered (green, one-step turns). The title row keeps the ask, elapsed and
the fold control; row two the step bar and estimate; then steps; then the receipt row; then the
cross-check row when it exists.

## 6. Invariants (added to SPEC.md's)

10. The mod never invents plan steps. A step exists only if Claude recorded it with the task tools.
11. A receipt is a command, an exit code and a verbatim summary line. Nothing less is called a receipt.
12. The cross-check is independent: a separate agent, read-only, that may re-run the gate. Its verdict
    is displayed verbatim and never softened.
13. All done requires all three: every step completed, a receipt after the last edit, no refutation.

## 7. Tests (write first)

- Plan: a build prompt gets the prompt.context section; a writing prompt does not; TaskCreate with 4
  steps yields 4 milestones; a Read during an answer turn leaves the plan at one step; an Edit during
  a build turn with no task tools leaves the band at "working" with no steps.
- Ledger: summary lines parsed for bun, jest, vitest, pytest, cargo, go, make; grep-for-error flagged;
  verify before the last edit does not count; failing verify forces the FAILED card.
- Cross-check: spawned once per qualifying turn; skipped with no edits, with the config off, above the
  usage guard; verdict rows render all three states; diff capping at 400 lines; refuted prevents All done.
- Cards: the six states render with correct colours and badges at 100 and 160 columns.
- Existing estimator, calibration, store and suppression tests stay green.
