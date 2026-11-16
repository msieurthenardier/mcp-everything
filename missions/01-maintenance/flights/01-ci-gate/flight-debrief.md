# Flight Debrief: CI Gate

**Date**: 2026-11-16
**Flight**: [CI Gate](flight.md)
**Status**: landed (set to `completed` at the end of this debrief, on the operator's confirmation)
**Duration**: 2026-11-16 - 2026-11-16 (leg design, implementation, review, hosted runs and debrief in one session)
**Legs Completed**: 1 of 1
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
The flight did what it set out to do. Pull request #7 adds one job, `check`, that runs on every pull request and every push to `main`: `npm ci`, typecheck, the unit tests with a minimum passed-test count, the build, and a check that `dist/index.js` is packed. `engines`, `.nvmrc` and the README now state the same Node floor. A Dependabot configuration covers npm and the pinned actions.

The check does not yet stop anything. With no ruleset on `main` (`gh api …/rulesets` returns an empty list), a red check can still be merged and `main` can still be pushed to directly. Until the operator adds the ruleset, the check reports and nothing more.

### Mission Criteria Advanced
Criterion 1 (finding 7) is advanced and stays open. Shown: the check runs on a pull request, and the three statements of the Node floor agree. Not shown: a run on a push to `main`, which needs this pull request merged. The criterion should be checked off after that first push run.

### Checkpoints
| Checkpoint | Result |
|------------|--------|
| The workflow runs green on this flight's pull request | Met. Runs 43915711264 (19 s) and 43916193240 (15 s). |
| A failing commit on a throwaway branch turns it red | Met, more weakly than it reads. See below. |
| `engines`, `.nvmrc` and the README agree | Met. |
| The operator has been asked for the ruleset, with the check name | Met. The name is `check`. The ruleset does not exist yet. |

### Not Shown
- **Three steps have never been seen red on the hosted runner.** The red run (43915933566) used a type error in `src/`. `npm ci` runs `prepare`, which builds `src/`, so the job failed at Install and skipped everything after it. That proves the job blocks. It does not prove that Typecheck, Unit tests or the count step fail the job on the runner. Their failing cases were run only locally, from shell extracted from the YAML.
- **The Node floor itself is untested.** `.nvmrc` `22` resolves to the newest 22.x (v22.23.4 on both green runs). Nothing runs on 22.12, on 24 or on 26, all of which the project now claims or vitest's range allows.
- **A pull request from a fork** and a Dependabot pull request have not run. Nothing in the workflow depends on a secret or a writable token, so both should behave the same (inferred).

## What Went Well
- **Ground truth before the leg was written.** The flight spec carried one unchecked point (how vitest exits when no test matches) and one stale number (340 passing tests). Both were settled by running commands during leg design: vitest exits 1, and the suite stood at 396. The action commits were resolved from the release tags the same way, and the Developer was told to read the action's inputs at the pinned commit, not recall them.
- **The leg's verification extracted the workflow's own shell and ran it**, with `RUNNER_TEMP` pointed at a scratch directory, in a passing and a failing case for each inline script. The Reviewer repeated it independently and added a malformed report and an empty-object report. This is why the first hosted run was green.
- **No deviation, one review pass, no fix cycle.** The first hosted run passed in 19 seconds, against a divert threshold of about 5 minutes.
- **The red check found something the review had not**: where the job actually fails for a `src/` type error.
- **The flight's diff is small and exact.** One line changed in `package-lock.json`, by hand, and `npm ci` on the runner accepted it.

## What Could Be Improved

### Process
- **The red-run checkpoint should name the step it is meant to prove.** "Turns it red (a type error)" was satisfied by the first step that could fail. `prepare` is in `package.json` and the leg's own text says "`npm ci` runs `prepare`", so the leg could have predicted this and asked for a type error in `test/`, which only the Typecheck step sees.
- **The low-risk tier was right in outcome and thin in reasoning.** The leg skipped the design review because the workflow's shape was settled in the inspection's roundtable. The Architect agrees with hindsight, and adds that a workflow gating `main` should not be tiered low by default: it was safe here because an earlier review had pinned its shape, not because of what it is.
- **The maintenance report is still uncommitted.** The mission, all three flights and squawks 0014 to 0025 link to `maintenance/2026-11-15.md`. The operator was asked twice whether to publish it and the question was not answered, so it was left out of two pull requests. The links are dead on GitHub until it is decided.

### Technical
- **`@types/node` is `^26.6.6` and the Node floor is 22.12.** The type definitions accept APIs that do not exist on Node 22, and neither `tsc` nor the check would notice, because the check runs a current 22.x that may itself have them. Not caused by this flight; made visible by it. Both crew members flagged it, the Developer as the sharpest hole.
- **The count floor is a constant that only a person raises.** 350 against 396 lets 46 tests disappear unnoticed. The comment says to raise it; nothing prompts that.
- **The Build step repeats the build inside Install.** It costs 0.6 s and would matter only if `npm ci` stopped running `prepare`. Left as it is.
- **The Pack check proves `dist/index.js` is built and listed**, not that an `npx` install works. It runs with `--ignore-scripts`. The clean-clone build inside Install is the nearer proof of that.
- **`ubuntu-latest` is moving to Ubuntu 26**, per an annotation on every green run. No action; worth knowing if a run changes behavior without a commit.

### Documentation
- The README states the new floor and does not say why it is 22.12 (it is vitest's requirement, not the runtime's) or that Node 20 was dropped. A one-line note would save a reader the search.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| None in the leg. | | |
| Hosted green and red runs were done after the commit, between the review and landing, and recorded in a second commit (`f4b339e`). | They cannot run before the branch is pushed. | Yes: a flight whose checkpoints need a pushed branch should say so, and plan the second commit. |
| The maintenance report was left out of the flight's commit. | Publication is the operator's call and was not answered. | No. Decide it once. |
| A Developer was spawned to write the throwaway type-error file. | The Flight Director does not edit source, including on a scratch branch. | Yes, as is. |

## Key Learnings
- A workflow step is not shown to work until it has failed on the runner. Local extraction shows the script is right; it does not show the job is wired so that the step is reached.
- When install builds the project, install is the first gate. Every later step should be judged by what it catches that install does not: here, Typecheck catches `test/`, Unit tests catch behavior, the count catches a skipped suite, Pack catches the `files` list.
- A floor stated in `engines` is a claim. With one job on a floating major, the claim is tested only at the newest release of that major.
- Checking an action's inputs at the pinned commit took one `gh api` call and removed a guess about a major version neither agent had seen.

## Test Metrics
All run for this debrief unless marked. This flight changed nothing under `src/` or `test/`; every difference from sortie 03 comes from the squawk turnaround (`c2249b2`), which has no debrief of its own.

- **Unit suite** (`npm test`): 17 files passed, 1 skipped; 396 tests passed, 17 skipped, 0 failed; 1.63 s. Sortie 03: 340 passed, 16 skipped, 1.55 s. The 56 new tests and the one new skip are the turnaround's. Slowest tests unchanged: one at about 1 s ("leaves the project unchanged when the server does not start"), one at 202 ms, the rest under 110 ms.
- **Default Docker suite** (`npm run test:docker`): 15 passed, 2 skipped, 0 failed; 151.6 s. Sortie 03: 14 passed, 2 skipped, 148.2 s. One new case from the turnaround (squawk 0011); the difference is inside the 143 to 153 s spread recorded in sortie 03. Per-case times were not captured this time (the default reporter does not print them).
- **Pressure cases**: not run. Nothing they cover changed.
- **Hosted check**, new with this flight (read from the runs): 19 s and 15 s for the job. `npm ci` 3 to 4.4 s for 137 packages, Typecheck 0.8 s, Unit tests about 3.1 s (vitest itself 2.67 s, against 1.63 s locally), count under 0.1 s, Build 0.6 s, Pack under 1 s. The red run took 31 s and failed at Install. These seed later comparisons.
- **Flakes**: none in one run of each suite and three hosted runs.

## Methodology Observations
All under mission-control 1.2.3.

- **agentic-workflow, Phase 2d to Phase 3: no place for a checkpoint that needs a pushed branch.** The skill's order is review, commit, draft pull request, then verify legs and land. Two of this flight's four checkpoints (hosted green, hosted red) can only be checked after the push. Expected: a step between opening the pull request and landing for checkpoints of this kind. What happened: the Flight Director ran them there unprompted and recorded them in a second commit. Cost: one extra commit; no rework.
- **agentic-workflow, Phase 2d step 3, against the project crew file: who commits.** The skill says "Commit after review passes" as a Flight Director step. The crew file's interaction protocol says the Flight Director spawns a Developer to commit. The crew file was followed. Cost: one agent spawn (about 39,000 tokens) to run `git add` and `git commit` from an exact file list and message. The spawned agent also reported that its own attribution reminder named a different model from the co-author line it was told to write; it wrote what it was told.
- **agentic-workflow, Phase 2a step 2 (risk tier): "security-sensitive surface" met a design that an earlier phase had already reviewed.** The leg was a CI workflow on a public repository, which the tier list would send to design review. It was tiered low because routine-maintenance's roundtable had fixed its shape. The skill has no wording for "already reviewed upstream". Cost: none measured. A design review might have predicted where the red run would fail.
- **routine-maintenance, Phases 7 and 8: nothing says when the maintenance report and the scaffolded mission are committed.** Planning skills produce artifacts only. The squawk turnaround then committed squawk records that link to the report, and this flight committed a mission that links to it, while the report stayed untracked. Expected: a stated point at which the report is committed, or a prompt to the operator at scaffold time. Cost: dead links in a public repository across two pull requests, and one question put to the operator twice.
- **flight-debrief, Phase 2 (Developer instruction to run the full suite): on a flight that changed no source or test.** The Docker suite ran for 2.5 minutes to produce numbers that are entirely another change's. Expected: nothing different, necessarily; recorded because the instruction has no "nothing under test changed" case. Value this time: it gave the turnaround's test deltas a recorded home.
- **squawk, Verb Complete: a batch turnaround leaves no test metrics.** The turnaround moved the unit suite from 340 to 396 tests with no debrief to carry the numbers. They are recorded here, one flight late.
- **flight (as scaffolded by routine-maintenance): the leg's ground-truth step caught what the flight spec had not checked.** The spec carried a stale count and two inferences (run time, vitest's exit on an empty run). agentic-workflow Phase 2a's "gather ground truth" step corrected all three before the leg was written. Recorded as working.

## Recommendations
1. **Add the ruleset on `main`** (operator): require a pull request and the status check `check`, block force-push. Without it this flight changes what is visible, not what can be merged.
2. **Prove the three unproven steps on the runner** before relying on them: one throwaway pull request with a type error in a test file only (Typecheck), and one with a failing assertion (Unit tests). The count step needs a suite that is mostly skipped; local proof may be enough for that one.
3. **Decide what the Node floor claim rests on.** Either test it (a second job on `22.12.0`, or `.nvmrc` pinned to the floor) or keep one job and say in the README that the floor is the test toolchain's. This reopens the flight's "one job, one Node version" decision, so it is the operator's.
4. **Flights 02 and 03: the hosted check will go green without the Docker suite.** Both flights change behavior that only the Docker suite exercises against a real container. Their Verification sections now say to run `npm run test:docker` locally before the pull request is marked ready, and to raise the count floor in the leg that adds tests. (Done in this debrief; both flights were still `ready`.)
5. **Settle the maintenance report**: commit it, or commit a version with findings 1b, 2 and 3 shortened, so the links resolve.

## Action Items
- [ ] Operator: ruleset on `main` with the check `check`.
- [ ] Operator: publish `maintenance/2026-11-15.md` or not.
- [x] After #7 merges: confirm the check ran on the push to `main`, then check off mission criterion 1. Done, see the follow-up below.
- [x] Logged as squawk [0026](../../../../squawks/0026-types-node-major-ahead-of-node-floor.md): `@types/node` is a major version ahead of the Node floor.
- [x] Logged as squawk [0027](../../../../squawks/0027-startup-errors-print-a-stack-trace.md): a configuration error at startup is followed by a stack trace (from the turnaround's review).
- [x] Logged as squawk [0028](../../../../squawks/0028-readme-does-not-explain-the-node-floor.md): the README does not say why the floor is 22.12 or that Node 20 was dropped.
- [ ] Recommendation 2, as the first step of flight 02 or on its own.
- [ ] Recommendation 3, for the operator to decide.
- [x] Flights 02 and 03 updated with the Docker suite and count floor notes.

## Follow-up — 2026-11-16
- Pull request #7 merged (`ddedf48`) before this debrief was committed, so the debrief, squawks 0026 to 0028 and the status change go in a pull request of their own, on branch `flight/01-debrief`. The statement in the flight log that the debrief joins #7 was true when written and is superseded by this note.
- The check ran on the push to `main`: run 43918240155, event `push`, job `check`, success. Mission criterion 1 is checked off. It says the check runs; it does not say the check is required. `gh api …/rulesets` still returns an empty list, so the first action item stands.
- Dependabot started two update jobs on `main` within seconds of the merge. Its first pull requests will be the first to run the check from a branch this project did not write.
- This pull request is the first whose check runs with nothing under `src/` or `test/` changed and no workflow change: a plain documentation change, gated like any other.
