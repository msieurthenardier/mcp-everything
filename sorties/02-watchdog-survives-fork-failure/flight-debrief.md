# Flight Debrief: Watchdog Survives Fork Failure

**Date**: 2026-11-15
**Flight**: [Watchdog Survives Fork Failure](flight.md)
**Status**: landed
**Duration**: 2026-11-15 - 2026-11-15 (planning, execution and debrief in one session)
**Legs Completed**: 1 of 1
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
The sandbox watchdog no longer exits when it cannot fork. Its per-poll fork runs under `command eval` and is retried until it succeeds; a starved poll counts as activity; the first failed fork of a container run writes one line to the container's stderr. The production change is about a dozen lines of shell in one constant (`WATCHDOG_SCRIPT` in `src/sandbox/docker.ts`), committed as `5cf4fad` on `sortie/01-sandbox-idle-timeout` and carried by pull request #1, which is open and not yet merged.

No defect was found in this debrief. What it found is a durability gap: the only tests that exercise the fix are skipped by default, and nothing in the project runs them unprompted.

### Charter Success Criteria

| Criterion | Result | Notes |
|-----------|--------|-------|
| A sandbox held at its process limit by processes that keep forking is never stopped, on both a Debian-based image (dash) and a busybox image | Met, for the pressure that was tested | Negative control: against sortie 01's script both pressure cases fail, the container exiting with code 2 (`Cannot fork` on dash, `can't fork` on busybox). Against the new script: 30 of 30 runs per shell (Developer) and 10 of 10 per shell (Reviewer), each asserting the container is running with an unchanged start time after the pressure. Those runs bound the failure rate at roughly 10%; they do not rule out a rare failure, and one early planning run on busybox ended with a stopped container that was never explained. Only pressure that comes and goes is tested automatically; the fully packed case was measured once by hand, on dash. |
| Once the pressure ends and the sandbox goes quiet, it still idle-stops, within a bound stated in the README | Met | Every pressure run also asserts an idle stop with exit code 0 within the timeout plus 15 s. The README states that idle stopping resumes with the timeout and latency already documented there. |
| All of sortie 01's idle-timeout behavior is unchanged: its existing integration cases pass unmodified | Met | The 12 existing Docker cases pass and the diff to both test files only adds lines. |

**Constraints**: the watchdog busy-retries only while it cannot get a process slot for its `sleep` (the constraint as revised by the operator; true by construction of the loop); it uses only `/bin/sh` and coreutils with no host-side process; and the fix is part of pull request #1 before that pull request merges.

### Sortie 01's Open Criterion
Sortie 01's debrief recorded "a sandbox is never stopped mid-work" as not met because of this defect. With this flight it can be recorded as **met for the failure that was found**: on the two default images, under the tested pressure, at commit `5cf4fad`. It is not established as a general property. Not shown: shells other than dash and busybox behind `/bin/sh`, fork failures from causes other than the process limit, retrying for longer than about a minute, gVisor, and an install as such (a long exec still stands in for it). A follow-up note has been added to sortie 01's debrief.

### Checkpoints
All five flight checkpoints were met, including 30 consecutive passing runs per pressure case.

## What Went Well
- **Sortie 01's debrief turned straight into a precise, verified piece of work.** The debrief named the defect with evidence and said it needed a design decision; this flight took that as its charter. The chain worked and is worth keeping.
- **Measuring before deciding changed the design twice.** Running the watchdog at lowest priority was the planned way to keep the retry loop from taking CPU; a measurement showed it has no effect under a CPU quota, so it was dropped. And measurement showed that a zero-CPU wait and guaranteed resumption cannot both hold, which went to the operator as a choice before any code existed instead of surfacing as a failed criterion.
- **The warning line.** Three kinds of pressure tried at planning never reached the watchdog and would have let a naive test pass against the broken script. Having the production code emit one assertable line when the failure path runs is what makes the tests able to fail.
- **The negative control.** Restoring the old script and confirming both cases fail, with the reason (exit code 2, no warning line), is the single strongest piece of evidence in the flight.
- **Marking each design statement measured or inferred.** Reviewers and the debrief Developer could see at a glance which claims the code rests on and where each README caveat comes from. Review found overclaims precisely because the marks made them checkable.
- **The leg design review caught four real problems cheaply**: pressure commands that would have been mangled by string escaping, the wrong repeat count, a missing per-poll reset, and a negative control that proved "fails" but not why.
- **A blocker rule instead of retries.** The Developer was told that any stopped sandbox in a pressure run was a blocker to report, not a flake to re-run. None occurred, and the counted results are not the survivors of retries.

## What Could Be Improved

### Process
- **The Flight Director's own transcription errors cost a review cycle.** The second architecture review was mostly corrections to statements worded beyond their evidence: an image the reference script had never been run on, a measurement of the old script quoted for the new one, "no steady trend" from four samples. Later, the leg's summary of the change left out a line the reference script contained. All were checkable against the log before review. Marking claims measured or inferred does not help if the mark is applied from memory.
- **The test recipe's reliability was measured only after a review asked.** Premises of the mechanism were measured before the first review; whether the pressure reliably reaches the watchdog was not, and that is where the 19-of-20 result and the unexplained stop appeared. Sortie 01 had the same pattern with its race stress test.
- **Nobody asked how long the new tests take until the operator objected.** The leg required the pressure cases to pass as part of the default Docker suite. During review the operator ruled them too slow for that, which became a post-landing fix, a deviation and a second review cycle.
- **The unexplained stop was never explained.** The run's exit code was not captured, so the question could only be bounded statistically afterwards. Diagnostics should be captured on every run of an exploratory series, not only once something looks wrong.
- **A status report ran ahead of the facts.** A pull-request comment said the description had been rewritten when the command that rewrites it had failed behind a pipe that hid its exit status. It was noticed and corrected within minutes, but the comment was briefly untrue.
- **A Developer agent killed processes by pattern**, took down its own shell and left two test containers behind, which it then removed by exact name. Later briefs forbade pattern kills.

### Technical
- **The fix has no net that runs unprompted.** The two pressure cases are opt-in (`MCPE_PRESSURE_TESTS=1`), there is no CI, and `npm run test:docker` reports them only as "2 skipped" with no reason. The rule "run them when the watchdog script or its tests change" does not cover the changes most likely to break the fix without touching it: a base-image update, a new dash or busybox, a Docker or kernel change, a custom image with a different `/bin/sh`. The unit test checks that two strings are present in the script, not that a shell honors them. This reverses the direction of sortie 01's third recommendation, by the operator's decision.
- **Nothing next to the script points at its tests.** The comment above `WATCHDOG_SCRIPT` does not mention `npm run test:docker:pressure`; the guidance lives in the README's Development section, a test-file comment and this sortie's flight log.
- **`test:docker:pressure` selects its cases by a phrase in their names.** Rename a case and the command matches nothing and reports everything skipped. Whether it then exits non-zero was not checked.
- **Setting only `MCPE_PRESSURE_TESTS=1`** runs nothing and says nothing.
- **The `starved` flag is redundant and untested.** A starved poll is already seen as activity by the PID-gap check and the `/proc` scan. The flag adds a variable that must be reset every poll, which is exactly what the leg's first draft forgot.
- **Stderr of the fork attempt is discarded wholesale.** If the fork fails for a reason other than the process limit, the watchdog still loops and still prints "process limit reached". If `sleep` cannot be executed at all, the loop spins forking; that last behavior predates this flight.
- **The option not taken was never built.** The case against parking on a pre-forked child, and the statement that dash offers no timed wait, are reasoned, not tested. The operator's choice between the two options rested on that reasoning, labelled as inferred.
- **The measured environment is unpinned.** `buildpack-deps:stable` and `alpine/git:latest` are floating tags; the shell versions the fix was measured on are not recorded anywhere.
- **Costs of the retry loop, as measured**: about one CPU of the sandbox's default two while the watchdog cannot fork in a fully packed sandbox, and tens of thousands of PID numbers consumed per second under pressure. Long durations were not measured.
- **Test-code debt**: the new block repeats helpers from the block above it, and builds its failure diagnostics on every run, passing or not.

### Documentation
- The leg file's regression criterion is ticked although it was met in a changed form; a reader of the leg alone is misled, and has to find the Deviations entry in the flight log.
- The standing instruction about when to run the pressure cases is recorded in the flight log, where a future developer or reviewer is unlikely to look.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Charter constraint revised from "no busy loop" to "busy-retry only while it cannot get a slot" | Measurement showed a zero-CPU wait and guaranteed resumption cannot both hold; the operator chose resumption | Yes, as a pattern: put a measured contradiction to the operator before design continues |
| All work on one branch and one pull request; no `sortie/02-…` branch | Operator's direction at spec approval, so the fix reaches `main` with the feature it repairs | Case by case. It bought an atomic merge and cost reviewability: pull request #1 now carries two sorties, three squawks and two debriefs, and the branch name describes one of them |
| Pressure cases made opt-in after the leg had landed | Operator's instruction during review: too slow for every review | The instruction, yes. The timing, no: ask at leg design |
| No third architecture review after the second cycle's revisions | Two-cycle cap; the revisions were wording and plan, not design | Yes, when nothing substantive changed |
| No second leg design review | The changes were the reviewer's own fixes | Yes, when that holds |
| Acceptance run done as one batch of 30 per shell instead of two of 15 | It fit the command time limit | No, incidental |

## Key Learnings
- When a test must prove that a failure path ran, have the production code emit a once-only signal the test can assert, and treat its absence as a failure of the test, not a pass.
- A test of a fix is not trusted until it has been seen to fail against the unfixed code, for the stated reason.
- A measured claim needs its provenance written next to it: which version of the code, which image, how many samples. Without that, "measured" drifts.
- Thirty clean runs are a bound, not assurance. Say what rate they exclude.
- Deciding where a slow test lives is a design question. Asked late, it turns a regression net into a note in a README.
- A `-t` filter is a regular expression; a test name with parentheses in it cannot be selected by its own text.

## Test Metrics
Compared with sortie 01's debrief, the only earlier record.

- **Unit suite** (`npm test`): 15 files passed, 1 skipped; 270 tests passed, 14 skipped, 0 failed; 1.44 s. Sortie 01: 268 passed, 12 skipped, 1.46 s. The two extra passes are squawk 0002's parse tests; this flight added assertions to an existing case, not new cases. The two extra skips are this flight's pressure cases. Slowest tests unchanged: one at about 1 s, two between 100 and 210 ms.
- **Default Docker suite** (`npm run test:docker`): 12 passed, 2 skipped, 0 failed; 141.6 s. Sortie 01: 12 passed, 140 s. No change beyond noise, which is what making the pressure cases opt-in was for. Per case: install 16.1 s, rebuild on another image 17.0 s, proxy 9.7 s, three under 3 s, and the six idle-timeout cases between 11.6 and 19.1 s (about 94 s together, as before).
- **Pressure cases** (`npm run test:docker:pressure`), not run for this debrief by the operator's rule; figures from the flight log: 2 passed in 31 to 33 s for the pair. Warning line after 949 to 4262 ms across 80 recorded runs.
- **Flakes**: none observed in any run of any suite during this flight. The idle-timeout cases remain timing-sensitive; the closest was 19.1 s of work against 21 s deadlines, the same case and about the same margin as in sortie 01.
- **Skips**: the Docker file is skipped without its opt-in, and two of its cases now need a second one. There is still no CI.

## Methodology Observations
All observed with mission-control 1.2.3.

- **Sortie skill, Plan step 2 (charter).** The charter was agreed with a success criterion and a constraint that could not both be satisfied. The Flight Director had told the operator that no approach was yet tested; the contradiction was found by measurement during design and the operator revised the constraint. The skill has no step for probing a charter's feasibility before the charter gate. Expected: nothing different in the skill, necessarily; recorded because the charter gate passed something infeasible. Cost: one extra operator round-trip. Saved: a failed acceptance criterion later.
- **Flight skill, Phase 4 (design decisions).** Following sortie 01's debrief, every factual statement in the design decisions was marked measured or inferred. The flight format has no place for that mark or for a measurement's provenance, so it was added ad hoc and applied from memory. Result: three statements marked measured that their measurements did not support as worded, all caught in the second review cycle. Expected: a measured statement that names its measurement. Cost: most of one review cycle.
- **Flight skill, Phase 5b (design review).** The reliability of the test recipe was measured only in response to the first review. Second occurrence in this project (sortie 01: the race stress test came after its first review). The skill prompts premise verification for design decisions, not for the verification approach itself. Cost here: one busybox series with weak pressure, an unexplained stop with no exit code captured, and a repeat series.
- **Flight skill, Phase 5b (two-cycle cap).** The second cycle's revisions went to the operator unreviewed, as in sortie 01. This time they were wording and plan, not a rewritten decision. No cost observed.
- **Agentic-workflow skill, Phase 2a (leg design).** The leg restated the flight spec's change in its own words and dropped one line of it. The duplication between flight spec and leg is where the divergence came from; the leg design review caught it. Cost: none realized. Without the review it would have been a watchdog that never idles again after one starved poll, caught only by a late assertion.
- **Agentic-workflow skill, Phase 2a (leg design).** Nothing in leg design asks how long new tests take or whether they belong in the default suite. Expected: a prompt to state a time budget for tests a leg adds. Cost: an operator objection during review, a post-landing fix, a deviation and a second review cycle.
- **Agentic-workflow skill, leg immutability.** A criterion changed after the leg had landed. The leg cannot be edited, so it is ticked as met while the truth is in the flight log's Deviations. Expected: a way to annotate a landed leg's criterion as superseded. Cost: a leg file that misleads on its own.
- **Agentic-workflow skill, Git Workflow.** The operator directed that this sortie run on another sortie's branch and pull request. The workflow assumes one branch and one pull request per flight; there was no path for it, so "open a draft PR" became "rewrite an existing pull request's title and description". Handled through Flight Director notes and a rewritten prerequisite. Cost: design-review effort spent on a branch plan that was then replaced, and a pull request whose branch name no longer describes it.
- **Agentic-workflow skill, Phase 3 (flight completion).** The pull request was again marked ready before the debrief, as the workflow prescribes. Sortie 01's debrief recorded the same sequence as having advertised an unmet criterion. This time the debrief found no defect, so there was no cost; recorded as a second occurrence of the ordering.
- **Agentic-workflow skill, Phase 2d (flight review).** The first review confirmed with no blocking issues and its most useful finding was incidental (test names that cannot be selected by `-t`). The durability gap in this debrief was outside any acceptance criterion and so outside the review. Recorded, not judged; the same shape as sortie 01's observation.
- **Flight-debrief skill, driving the next flight.** Sortie 01's debrief recommendation became this sortie's charter almost verbatim, with its evidence. Worked as intended.
- **Sortie skill, right vehicle?** Yes. One outcome, one decision cluster, one leg. Not a squawk: it needed an operator trade-off and changes container lifecycle. Not a mission. The design effort was large for a dozen lines of shell (two architecture reviews, a leg review, two code reviews, about a dozen measurement tables); a lighter vehicle would not have caught the same things, and the previous flight's defect came from doing less.
- **Flight-debrief skill, Phase 2 (test metrics instruction).** The skill tells the Developer to run the full test suite. The operator had ruled that the pressure cases run only when the watchdog changes, so the interview ran the default suites and took the pressure figures from the log. Recorded as a project rule overriding a skill default, with no cost.

## Recommendations
1. **Give the fork guard a net that does not depend on memory.** At minimum: a line in the comment above `WATCHDOG_SCRIPT` saying that changing it, or the sandbox images, requires `npm run test:docker:pressure`; and the same rule in the Reviewer's prompt in `.flightops/agent-crews/leg-execution.md`, since that is what a review actually reads. Better: run the pressure cases on a schedule or before a release, because the likeliest breakage is an image or shell update that touches no file in this repository.
2. **Make `npm run test:docker:pressure` fail when it runs nothing**, so a renamed case or a missing variable cannot produce a green result.
3. **Record what the fix was measured on**: the dash and busybox versions, or image digests, behind the two floating tags.
4. **In design, write each measurement's provenance beside the claim it supports**, and measure the test recipe's reliability before the first review, capturing diagnostics on every run.
5. **Decide at leg design where slow tests live**, with a stated time budget, instead of at review.

## Action Items
- [x] Squawk 0004 (completed 2026-11-15): add to the `WATCHDOG_SCRIPT` comment that changes to the script or the sandbox images require `npm run test:docker:pressure`.
- [x] Squawk 0005 (completed 2026-11-15): add the operator's rule to the Review prompt in `.flightops/agent-crews/leg-execution.md` (run the pressure cases when the watchdog script, its tests or the sandbox images are in the diff; otherwise not).
- [x] Squawk 0006 (completed 2026-11-15): record in the README or beside the script the dash and busybox versions the guard was measured on.
- [ ] Needs a small design decision, so not a squawk: make `test:docker:pressure` fail when no case ran.
- [ ] Later flight: a scheduled or pre-release run of the pressure cases, or CI; whether the redundant `starved` flag should stay; distinguishing fork-failure causes in the warning; shells other than dash and busybox; gVisor; behavior over long retry durations.
- [x] Sortie 01's "never stopped mid-work" criterion re-assessed (above) and a follow-up note added to its debrief.
