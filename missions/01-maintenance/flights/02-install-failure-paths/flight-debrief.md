# Flight Debrief: Install Failure and Interruption Paths

**Date**: 2026-11-16
**Flight**: [Install Failure and Interruption Paths](flight.md)
**Status**: landed (set to `completed` at the end of this debrief, on the operator's confirmation)
**Duration**: 2026-11-16 - 2026-11-16 (four legs designed, implemented and reviewed, hosted runs and debrief in one session)
**Legs Completed**: 4 of 4
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
The flight did what it set out to do. In pull request #10:

- A failed install leaves its sandbox off the network and the record says so, whatever `network` was asked for. This holds at both failure exits: the thrown-error path the finding named, and the ordinary failed build, which had the same gap when the caller passed `network: true`.
- `Docker.setNetwork(container, false)` no longer reports success when Docker could not be asked. Without this the record could say "off" on the strength of a question that was never answered.
- At startup, a record left `installing` for more than seven hours (by default) is marked `failed` and its sandbox detached, with a re-check before each detach and a write made under the registry lock.
- The process exits within 15 seconds of a stop signal, and a second signal does nothing.
- `disconnect_mcp_server` refuses when the sandbox is gone. The defect the inspection reasoned out was reproduced first: the unchanged code returned success and stored the record with its commands, tools and servers emptied.
- Every failure branch of `install` has a unit case; the suite went from 396 to 447.

### Mission Criteria Advanced
Criterion 2 (finding 4) is met by the code in pull request #10 and stays open until it merges, as criterion 1 did for flight 01.

### Checkpoints
| Checkpoint | Result |
|------------|--------|
| A failed install is shown, by unit test and by one Docker assertion, to leave the sandbox off the network | Met. Eight unit cases that fail without the change; one Docker case against the real daemon (attached during the build, detached after, record agreeing). |
| A stale `installing` record is reconciled at startup; a fresh one is left alone | Met by unit test, including through `App.start()`. Not shown against a real interrupted install. |
| Shutdown exits within its deadline with a hung close, and a second signal is ignored | Met by unit test on the extracted function. By hand on a scratch build: exit 0 within 8 ms of one `SIGTERM`, one shutdown for two. The exit-1 path was not provoked in a real process. |
| `disconnectMcp` on a missing sandbox reports the sandbox as gone and leaves the record as it was | Met. Reproduced before the fix. |

### Not Shown
- **A real interrupted install, end to end.** No test kills a process mid-install and then starts another seven hours later. The detach is shown against real Docker (leg 1's case); the reconciliation's logic only against doubles.
- **`App.start()` reconciling against a slow real Docker.** That it does not delay startup is by construction (the promise is not awaited), not by test.
- **Exit code 1 in a real process.** A hung close was never provoked outside the unit test.
- **`src/index.ts` has no automated test.** Its wiring was checked once by hand and by the Reviewer's read.
- **The flight's own "by hand, once" step** (start a failing install, `docker inspect` it, compare `project_info`) was not done as written. Leg 1's Docker case does the first two against the real daemon; `project_info` was not called.
- **The hosted count step failing** on a mostly skipped suite: still local only.

## What Went Well
- **Leg design found two defects the inspection had not.** Reading `install` end to end showed the recipe-failure exit staying online for `network: true`. Reading `setNetwork` showed that `hasNetwork` answers "no" both for "attached to nothing" and for "could not ask". Both were inside the finding and neither was in the flight spec.
- **The design reviews earned their cost.** Both high-risk legs came back "approve with changes" with two high-severity points each. Leg 1: `setNetwork` could not be fixed through `hasNetwork`'s boolean, and the test double could not express the cases. Leg 2: the window for detaching a neighbor's live build was up to minutes wide, not milliseconds, and the planned guarded write would have changed `Registry.delete`. The second pass on leg 2, run because the first changed the leg substantively, caught a write that would have dropped another process's warnings. None of these reached the code.
- **Reproduction before the fix for 4d.** The finding was marked "effect inferred". The leg required the test first, and it recorded exactly what the old code stored. The fix is three lines and the evidence for it is no longer an inference.
- **Tests seen to fail first.** Leg 1's Developer ran the new cases against the old `src/` and reported which failed (11) and which were guards on existing behavior. Legs 2 to 4 wrote tests first.
- **One review pass, no fix cycle, no divert.** The Docker suite passed on the first full run.
- **The carried recommendation was closed.** The hosted check's Typecheck and Unit-test steps were each shown red on the runner (pull requests #11 and #12), in 11 and 16 seconds.

## What Could Be Improved

### Process
- **The Deviations section of the flight log was left empty** while the Flight Director Notes recorded three departures from the flight spec (a shared method's behavior changed, a public method added to `Registry`, the leg list restructured). The Architect's point: a change to a shared method is a deviation and should be recorded as one when it is made. Corrected in the log with this debrief. The operator was told of the `setNetwork` change in a status message during leg 1's design and again at landing; it was not put as a question.
- **The out-of-scope defects were not logged as squawks during the flight.** The workflow says to log and defer them with an id. Three were seen in leg 1's design review and were listed in the leg and the log instead, because it was not clear each was squawk-sized. They are sorted below.
- **The flight-end review read the largest test file shallowly, and said so.** The debrief's Developer then read all of it and found two weak assertions (below). One review over four legs and about 900 changed lines is where that came from.
- **Two wording fixes were made after the Reviewer confirmed**, by the Developer that committed, and checked only by the Flight Director in the diff. They were a moved comment and a README sentence. The alternative was a second review for two lines.
- **The Docker suite ran twice on the same code**, 25 minutes apart: once in the review, once for this debrief. The second run did add per-case times, which the first did not record.

### Technical
- **Staleness is a guess by age.** A registry record has no owner, so seven hours stands in for "no process is installing this". It does not cover a neighbor with a larger `MCPE_INSTALL_TIMEOUT`, a clock that jumped, or an install with every step at its limit (about 27,000 s against 25,200 s; not realistic). In those cases a live build can lose its network; its own final write restores the record. The practical exposure the rule leaves is the other way: after a crash, the sandbox stays attached until a start that comes more than seven hours later and finds Docker up.
- **`takeOffline` serves two callers and its warning names one.** A reconciled install whose detach fails gets "could not be taken off the network after the failed install", where "interrupted" is meant. Small; squawk candidate.
- **Two weak assertions in `test/installer.test.ts`.** In "writes nothing when the record was replaced during the detach", the file's mtime is captured after the reconciliation and compared with itself, so those lines cannot fail; the case's one working assertion is that the newer record survives. In "changes nothing and logs once when Docker does not answer", `expect(log[0]).toContain("2")` passes on any line with a 2 in it. Squawk candidate.
- **Some new cases add count more than coverage.** Two pairs overlap ("cannot be turned off" with "throw followed by a failed turn-off"; the two "during the detach" write cases), and five cases pin behavior this flight did not change (rollback, success, `uninstall`). They are worth having as guards; the leg did not label which were which.
- **`App.reconciling` is a public field that only tests read.** It is the seam that made the startup tests honest. Flight 03 will want the same thing for its own startup work; one name for "startup work finished" would be better than a field per task.
- **Startup reconciliation lives in `Installer`.** It needs the Docker client and `takeOffline`, which are there. With flight 03 adding two more startup sweeps that belong to the registry and the proxy, there will be three in three places.
- **A failed inspect in `setNetwork(…, false)` costs a second Docker call** (`docker version`). Only on that path.

### Documentation
- The README now covers the network after a failed install and the startup reconciliation. Nothing explains `Registry.update` or why staleness goes by age outside the code comments, which is where a maintainer will look; no further document is proposed.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| `Docker.setNetwork(container, false)` throws when the daemon does not answer. A shared method's behavior changed; the flight spec did not name it. | Without it, "recorded as off" could be false, which is the finding. Limited to an error condition; no caller behaves differently outside it. | Yes: record a shared-method change as a deviation when the leg is designed, and say so to the operator then. |
| The recipe-failure exit also goes offline. | The flight's decision ("off after a failed install") covers it; the spec's evidence named only the `catch`. | No. |
| `Registry.update(slug, fn)`, a new public method. | The reconciliation's write had to be decided under the lock. No field was added to the record. | Yes, as the way to change a record from its current state. |
| Leg list changed: the tests-only leg folded into leg 1; the first tentative leg split in two. | A tests-only leg would have pinned behavior the leg before it had just changed. The flight allowed the fold. | Yes. |
| Legs 3 and 4 were drafted while leg 2 was in review. | Neither depends on leg 2's code. Each had its citations re-checked before `ready`. | Yes, for legs with no dependency on the one in flight. |
| The staleness limit is seven hours, not the spec's two. | An install can run two recipe attempts, plus clone, pulls and discovery. | No. |
| The flight's hand check with a failing install was replaced by the Docker case. | The crew may not use the operator's live instance. | No. A flight should not specify a hand check the crew cannot run. |
| Two throwaway pull requests (#11, #12) to show two check steps red. | Flight 01 debrief, recommendation 2. | No. Done once. |

## Key Learnings
- Read the whole function a finding points into. The finding named one exit of `install`; the same defect sat at the other.
- A boolean that answers "no" for both "there is none" and "I could not find out" will be used as "there is none". `hasNetwork` was; `Docker.state` does the same for a failed inspect and is still read that way.
- Startup work on a directory several processes share needs four things, all of which the design reviews had to add: judge again immediately before acting; write from the state under the lock, not from the copy read earlier; do nothing when the answer is unknown; and give tests a promise to await.
- When Docker does not answer, changing nothing is better than recording a guess: a `failed` record is never looked at again, an `installing` one is.
- An "inferred" finding should be reproduced before it is fixed. Here it took one test and turned a consistency change into a defect fix with evidence.
- With every leg uncommitted until the flight's end, `git stash` is no longer a safe way to see a test fail against old code after the first leg. Later legs have to write the test first.

## Test Metrics
Run for this debrief by the Developer, at `77dc425`.

- **Unit suite**: 18 files passed, 1 skipped (the gated Docker file); 447 passed, 18 skipped, 0 failed; 1.64 s. Flight 01: 396 passed, 17 skipped, 1.63 s. The 51 new tests cost nothing measurable: doubles and fake timers. The one new skip is the new Docker case, counted as skipped when the suite is gated off. Slowest unchanged: 1005 ms ("leaves the project unchanged when the server does not start"), 205 ms, 105 ms, then 56 ms.
- **Default Docker suite**: 16 passed, 2 skipped (the pressure cases), 0 failed; 154.5 s. Flight 01: 15 passed, 2 skipped, 151.6 s. One new case at 2.2 s; the rest is inside the spread. The Reviewer's run of the same code 25 minutes earlier took 153 s.
- **Docker per-case times**, recorded for the first time: Go CLI install 16.5 s; timeout kill 2.3 s; clone failure 1.0 s; proxied MCP server 9.9 s; host environment value 2.3 s; `refresh_mcp` 4.2 s; empty-valued variable 2.9 s; uninstall 0.4 s; rebuild on another image 17.4 s; **failed install ends offline (new) 2.2 s**; and the six idle-timeout cases 17.7, 15.4, 11.6, 19.2, 17.7 and 12.6 s, about 94 s together, which is most of the suite. The 19.2 s case ("short execs between polls") is the closest to its limit.
- **Pressure cases**: not run. Nothing they cover changed.
- **Hosted check**: 17 s on the landing commit; 447 passed against a floor of 430. Red runs: 11 s (Typecheck) and 16 s (Unit tests).
- **Flakes**: none in two Docker runs, several unit runs and four hosted runs.

## Methodology Observations
All under mission-control 1.2.3.

- **agentic-workflow, Phase 2d to Phase 3: no place for verification that needs a pushed branch (second flight in a row).** Review, commit, draft pull request, then land. This flight's hosted green run and the two red-step runs could only follow the push, and were recorded in a second commit (`77dc425`), as flight 01's were in `f4b339e`. Cost: one extra commit per flight; no rework.
- **agentic-workflow, Phase 2d step 3, against the project crew file: who commits (second flight in a row).** The skill lists the commit as a Flight Director step; the crew file has a Developer spawned for it. Followed the crew file. Cost: one spawn, about 42,000 tokens, for two wording edits, a test run and `git add`/`git commit` from an exact list.
- **agentic-workflow, Phase 2b and 2d: all legs stay uncommitted until the flight's end, and two things follow that the skill and crew prompts do not mention.** (1) The crew file's Review prompt says "Review all changes on the flight branch relative to its base", but at review time nothing is committed: the changes are a working tree with untracked files. The spawn prompt had to say so and list the untracked paths. (2) From the second leg on, any agent running `git stash`, `git restore` or `git checkout -- <file>` would destroy the earlier legs' work. Leg 1's Developer used `git stash push -- src/` to see tests fail; legs 2 to 4 had to be forbidden from it in the spawn prompt and told to write tests first. Cost: prompt text in every spawn; no loss occurred.
- **agentic-workflow, Phase 2d: one review for the whole flight read the largest test file shallowly.** The Reviewer confirmed and stated it had not read every added line of `test/installer.test.ts` (369 added lines of about 900 across four legs). The debrief's Developer, asked to read it all, found two assertions that cannot fail or fail too loosely. Expected: nothing different from the skill's wording; recorded because the batching is the skill's design. Cost: two weak assertions shipped in the pull request, both non-blocking.
- **agentic-workflow, Phase 2d steps 1 and 2: no wording for non-blocking notes after `[HANDOFF:confirmed]`.** The loop is "if issues found, fix and re-review until confirmed". The Reviewer confirmed with one non-blocking note and the Flight Director had one of its own. They were fixed by the committing Developer with no re-review. Cost: none seen; two lines went in unreviewed by the Reviewer.
- **agentic-workflow, Phase 2a step 4 (re-review after substantive changes): worked.** Leg 2's second pass, about 57,000 tokens and 30 seconds, found that the revised guidance contradicted the revised criterion (warnings replaced from a stale copy).
- **agentic-workflow, Phase 2a ("legs are planned one at a time"): legs 3 and 4 were drafted while leg 2 was under review.** The skill's order is design, implement, then design the next. Two legs with no dependency on leg 2's code were written as `planning` during the wait and audited before `ready`. Cost: none; the audits found no drift. Recorded because the skill has no wording for it either way.
- **agentic-workflow, Phase 2 (out-of-scope defects found mid-flight): not followed as written.** The skill says to log such a defect as a squawk and defer it, noting the id. Three were found by leg 1's design review. The Flight Director listed them in the leg's Out of Scope section and the log instead, unsure whether each passed the squawk gate, and sorted them at the debrief. Expected by the skill: three squawk ids in the log at the time. Cost: the items had no ids for the length of the flight; none was lost.
- **agentic-workflow, Phase 2b, and the crew file's Implement prompt: nobody is told who ticks a leg's acceptance criteria.** Leg 1's Developer ticked them; the Developers of legs 2 to 4 did not. The Reviewer reported the inconsistency. The Flight Director ticked the rest after the review. Cost: one review finding and a scripted edit.
- **flight (as scaffolded by routine-maintenance): the tentative leg list had a tests-only leg**, which agentic-workflow's leg-sizing rule calls a smell. The flight's own "acceptable variations" allowed folding it, so it cost only a note. Recorded because the scaffold and the sizing rule disagree by default.
- **flight (as scaffolded by routine-maintenance): a decision was left to leg design whose better answer the flight had already reserved for the operator.** The spec said an ownership field in the record "needs the operator" and also asked leg design to find "a better ownership signal if the record already carries one". It does not, so leg design could only choose age. The Architect's view: the flight should have put the schema question to the operator when it was scaffolded. Cost: none in rework; the question reaches the operator one flight later, as a recommendation.
- **flight-debrief, Phase 2 (Developer instruction to run the full suite): the Docker suite had run on identical code 25 minutes earlier**, in the flight review. Flight 01's debrief recorded the same instruction running on a flight that changed no code. Cost: about 2.5 minutes; value this time: per-case times.
- **agentic-workflow, the Flight Director does not edit source: a Developer was spawned to create two scratch branches with one test file each** (about 43,000 tokens), as in flight 01. Recorded as cost, not as a complaint: it kept the rule simple.

## Recommendations
1. **Merge #10 after this debrief is committed to it**, so the debrief does not need a pull request of its own this time.
2. **Tell flight 03's leg design what this flight learned about startup work on a shared directory**, before it starts: do not remove a file by age alone when a live process may own it; re-check each file immediately before removing it; do nothing when unsure; expose an awaitable promise; and check the registry's version where the file is read and before it is written, not only at startup, because `mutate` and `update` re-read and then rewrite. Written into flight 03 with this debrief; it was still `ready`.
3. **Put the ownership of an `installing` record to the design sortie for finding 3** (who owns a sandbox). An owner in the record would replace the seven-hour guess and close the one window the reconciliation cannot. It is a registry schema change; a process id alone is not enough (reused, meaningless across hosts). Not worth a change of its own now.
4. **Fix the two weak assertions and the warning's wording** at the next turnaround: squawks 0029 and 0030, with 0031 and 0032 for the two existing behaviors that were squawk-sized.
5. **Give `src/index.ts` one process-level test** when a build is available to the suite: start the built server with its own data directory, send `SIGTERM`, expect exit 0. It needs a build step the unit suite does not have today, so it is a recommendation, not a squawk.
6. **The ruleset on `main` and the maintenance report** are still open from flight 01 and unchanged.

## Action Items
- [ ] Operator: merge #10 once this debrief is on it.
- [x] Logged as squawk [0029](../../../../squawks/0029-reconciliation-tests-with-weak-assertions.md): two weak assertions in the reconciliation cases of `test/installer.test.ts` (a self-comparing mtime check; `toContain("2")`).
- [x] Logged as squawk [0030](../../../../squawks/0030-detach-warning-calls-an-interrupted-install-failed.md): `takeOffline`'s warning says "after the failed install" for an interrupted install that was reconciled.
- [x] Logged as squawk [0031](../../../../squawks/0031-failure-advice-says-sandbox-kept-when-container-is-gone.md): after a second build attempt whose container could not be created, the failure advice says "The sandbox was kept" when no container exists. Text only; a status change would escalate.
- [x] Logged as squawk [0032](../../../../squawks/0032-discovery-throw-leaves-proxied-sessions-open.md): a throw from discovery during an install leaves the project's proxied sessions open; close them on that path.
- [ ] Not a squawk, for the design sortie: a first-attempt `createContainer` that fails after Docker created the container, followed by a rollback whose `destroy` also fails, leaves a container with no record. The fix is a choice (keep a record, log, or retry), and it is the ownership question again.
- [ ] Recommendation 3 (record ownership), with the design sortie.
- [ ] Recommendation 5 (`src/index.ts` process test), when the suite can build.
- [x] Flight 03 updated with the notes on startup work.
- [x] Flight 01 debrief, recommendation 2 (two check steps shown red on the runner). Done in this flight.
- [ ] Operator, from flight 01: ruleset on `main`; publish `maintenance/2026-11-15.md` or not.
