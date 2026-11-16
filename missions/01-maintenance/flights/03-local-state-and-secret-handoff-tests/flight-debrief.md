# Flight Debrief: Local State Hygiene and Secret Hand-Off Tests

**Date**: 2026-11-16
**Flight**: [Local State Hygiene and Secret Hand-Off Tests](flight.md)
**Status**: landed (set to `completed` at the end of this debrief, on the operator's confirmation)
**Duration**: 2026-11-16 - 2026-11-16 (two legs designed, implemented and reviewed in two cycles, hosted run and debrief in one session)
**Legs Completed**: 2 of 2
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
The flight did what its three criteria ask, by a shorter road than its spec laid out. In pull request #13:

- **Leftovers are removed at startup.** Env files (`tmp/env-<16 hex>`, which hold values) and registry temp files (`registry.json.<pid>.tmp`) left by a crash are removed once more than an hour old, before the stale-install reconciliation. Only the product's own names are matched, through one definition shared with the code that writes them; no link is followed, no file is read, no directory is created, and neither sweep can throw.
- **A newer registry is refused and left untouched.** The check sits in `Registry.refresh()`, which every write passes through first, so about ten lines cover reading, `put`, `delete` and `update`. Before the fix, a file marked version 2 loaded without complaint and the next write rewrote it as version 1, dropping its extra content (reproduced).
- **The hand-off of values to Docker was already tested.** The inspection said it was not. The flight closed four small gaps: the directory's mode, the `docker` client's environment, a rejected value leaving no file, and a real env file followed through a launch that succeeds and one that fails.

### Mission Criteria Advanced
Criteria 3, 4 and 5 (findings 5, 6a, 6d) are met by the code in pull request #13 and stay open until it merges. With that merge every criterion of mission 01 is checked.

### Checkpoints
| Checkpoint | Result |
|------------|--------|
| A unit test fails when a value is put into the connector's argv, and passes as the code stands | Met by an existing test, shown by experiment: with the values pushed into the argument list it failed (`expected 'exec -i -w /workspace/repo --env-file…' not to contain 's3cret'`). |
| The vacuous assertion is gone or made real, and the flight log says which | Neither: it was not vacuous. It covers `Docker.exec` calls, which is its test's subject. It stays, with a comment. The log says so. |
| A registry file marked with a later version is refused and is byte-identical afterwards | Met, through `Registry` and through the `App`. |
| Old env and registry temp files are removed at startup; fresh ones are left | Met. |

### Not Shown
- **A real crash.** No test kills a process between writing a file and removing it. The sweeps are shown against files a test creates and ages.
- **Two builds on one registry.** The refusal is shown with a hand-written file, not with a newer build writing while this one runs.
- **Three behaviors the tests name but do not pin** (found by this debrief's Developer; see Technical): that `shutdown()` does not wait for startup work; that an env sweep that throws does not stop the registry sweep and the reconciliation; that a matching directory is skipped by the `isFile` check and not by `unlink` failing on it.
- **The documented limits** (a neighbor with a startup timeout far above an hour; a clock that jumps) have no test.

## What Went Well
- **Ground truth before leg design caught a wrong finding.** The spec said no unit test covered the real connector. Reading `test/proxy.test.ts` and one `git log -S` showed a test from the proxy's first commit. The leg was designed against the real gaps and came out smaller. Had the spec been followed, a Developer would have been asked to build a seam and write tests that existed.
- **The design reviews changed the design for the better, twice.** Leg 1: the previous debrief had suggested sweeping while holding the registry lock. The review showed the lock can be taken from a live writer after 5 seconds, so it proves nothing, and that waiting for it blocks the event loop before the server answers `initialize`. The sweep takes no lock. Leg 2: the review found the leg's three statements about odd `version` values disagreed, and that the draft was wrong about a top-level array.
- **Each change was shown to matter before or after it was made.** The argv experiment, done first with an empty diff on both sides. The version-2 file rewritten as version 1 by the old code. The replaced assertion failing in five cases with the defect put back.
- **The first review cycle did its job.** Told to read every added test line, the Reviewer found an assertion that could not fail and showed it with a scratch test.
- **Out-of-scope defects were logged with ids when found** (squawks 0033 and 0034), which flight 02 had not done.
- **Developers were told not to tick criteria**; the Flight Director ticked them after the review. No inconsistency this time.

## What Could Be Improved

### Process
- **The Deviations section of the flight log was empty again at landing.** Flight 02's debrief recorded the same thing. The departures were written in the Flight Director Notes: the corrected reading of finding 5, three legs becoming two, the lock dropped. Filled in with this debrief. Twice is a habit, not a slip: the workflow says to log decisions in the Notes, and nothing sends them on to Deviations.
- **The corrected finding was told, not asked.** The operator heard of it in a status message when it was found and in the landing report. The Architect's rule, which fits what happened: a correction that only shrinks the work can proceed and be reported at once; one that changes a criterion or widens risk goes back first. This one shrank the work, but it also changed how a checkpoint is read ("gone or made real" became "stays"), which is closer to the line than the flight treated it.
- **Two review cycles and a Developer still left three weak cases.** Both Reviewers stated they read every added test line. The debrief's Developer, asked the same, found three more cases that pass for the wrong reason. Reading is not enough for this class of fault; what found each one, in this flight and the last, was asking "what change to the source makes this fail?" and trying it.
- **Squawk 0034 was probably the wrong call.** The rule is not to fold an out-of-scope defect into a leg. 0034 is one condition in the method the leg was editing, in the same family of data loss as the finding being fixed, and the leg's own draft had assumed it was already handled. The Architect judges that leaving it out was too strict. It is logged and open; it should be done before anything else touches `registry.ts`.
- **The Docker suite ran three times on this flight's code** (two review cycles, the second on the final tree; then this debrief). The third run added nothing but confirmation.

### Technical
- **Three weak cases in the new tests** (squawk candidate):
  - `test/server.test.ts`, "are not waited for by shutdown": `await expect(local.shutdown()).resolves.toBeUndefined()` passes whether or not `shutdown` awaits `startup`, because the reconciliation finishes at once on an empty registry. It needs a reconciliation that never resolves.
  - `test/server.test.ts`, "do not stop each other": the registry sweep is made to throw, but the env sweep runs before it, so finding the env file gone proves nothing about isolation in that direction. The reverse (env sweep throws; the registry sweep and the reconciliation still run) is not tested.
  - `test/proxy.test.ts` and its twin in `test/registry.test.ts`, "leaves a directory and a symbolic link": a matching directory survives even without the `isFile` check, because `unlink` fails on a directory and the failure is logged. The log is not asserted. The symbolic-link half does bite.
- **The registry lock's release removes whatever lock file is there.** `lock()` returns `() => fs.rmSync(lockFile, { force: true })`. A writer whose lock was taken after 5 seconds will, when it finishes, remove the new holder's lock. Together with the steal itself, this means "under the lock" in `mutate` and `update` (and in flight 02's guarded write) is weaker than it reads. Out of this flight's scope by its own spec; it matters for anything that checks and then acts on the registry, which is most of sortie 04.
- **The refusal protects only builds that have it.** Any build before this one still loads a newer file as version 1 and rewrites it. So the check is a floor to roll out before a format change, not a guarantee across a mixed set of processes.
- **Two near-identical loops.** `sweepEnvFiles` and `Registry.sweepTemps` list, match, `lstat`, check age, `unlink` and log in the same way, with different signatures. Worth one helper if a third sweep appears; not before.
- **Startup work lives in four places**: a private `sweep` on `App`, `sweepEnvFiles` in the proxy module, `sweepTemps` on `Registry`, `reconcileStale` on `Installer`. `App.startup` resolves when the reconciliation does; the sweeps are already done by then. It works. The Architect's advice is to leave it until sortie 04 defines what "owned" means, and extract one startup collaborator as that sortie's first leg.
- **Nothing ties the writer's real file name to the sweep's pattern in a test.** The pattern is tested against hand-made names. The shared definition makes drift unlikely; a case that sweeps a file `dockerConnector` itself wrote, aged, would close it.
- **A second `App.start()` leaves the first watcher interval running.** Existing, reached by no caller, noted in the log.

### Documentation
- The README covers the refusal (in the `MCPE_DATA_DIR` row) and the removal of leftover env files. Adequate.
- The maintenance report's finding 5 is wrong in a way a later reader will not see from the report. It is unpublished and still awaits the operator's decision; if it is published, it should carry a note at its head pointing here.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Finding 5 was read as "close four small gaps", not "write the connector's tests and a seam". | The tests the spec said were missing exist, since `7efc782`. | Yes: re-verify any "X is missing" claim from an inspection before designing on it. |
| The assertion the spec called vacuous was kept, with a comment. | It covers what its test is about. | No. |
| Two legs, not three: both sweeps in one. | One decision made twice (name, age, re-check); the flight allowed one function or two. | Yes, for work that shares one decision. |
| The registry sweep takes no lock, against the previous debrief's suggestion. | The lock can be taken from a live writer and waiting for it blocks the event loop. Age is the protection. | Yes: do not treat this lock as proof of exclusion until it is fixed. |
| The sweeps run synchronously inside `start()`, not inside the startup promise. | With no lock and no Docker call they are a few file operations; an async wrapper would not have deferred them anyway. | No. |
| `App.reconciling` renamed `App.startup`. | One awaitable for all startup work, as the previous debrief asked. | Yes. |
| A `version` that is present, not 1 and not a larger integer is refused as unreadable. | "Do nothing when unsure"; nothing released wrote one. A string `"1"` loaded before. | No. |
| Squawk 0034 left out of the leg. | The rule against folding out-of-scope defects in. | No: see Process. |
| The flight's review took two cycles. | A new assertion could not fail. | n/a |

## Key Learnings
- "Read, not run" inspection evidence is a lead. In three flights of this mission the scaffolded spec was corrected at leg design each time: a stale count and two inferences (flight 01), a second failing exit and a method that reported success without asking (flight 02), and here a test said not to exist.
- A claim that something is missing is the cheapest kind to check and the most expensive to believe.
- A test's name is a claim too. Asking what source change makes it fail, and making that change, found five weak assertions across two flights that reading did not.
- A lock that can be taken from its holder is a hint, not a guard. Protection that does not depend on it (here, age) is worth more than protection that assumes it.
- A check placed where every write must pass is worth more than one at startup: `refresh()` gave refusal before writing for free.
- A version check defends only the builds that carry it. It has to ship, everywhere, before the first format change it is meant to catch.

## Test Metrics
Run for this debrief by the Developer, at `6438db1`.

- **Unit suite**: 18 files passed, 1 skipped (the gated Docker file); 500 passed, 18 skipped, 0 failed; 1.65 s. Flight 02: 447 passed, 18 skipped, 1.64 s. Flight 01: 396 passed, 1.63 s. The 53 new tests cost nothing measurable. Slowest unchanged: 1005 ms ("leaves the project unchanged when the server does not start"), 202 ms, 103 ms, 56 ms, 54 ms. Summed test times of the files this flight touched, recorded for the first time: `proxy` 47 tests, 893 ms; `registry` 39 tests, 50 ms; `server` 100 tests, 1262 ms. The sweeps now run in every `App.start()` and do not show.
- **Default Docker suite**: 16 passed, 2 skipped (the pressure cases), 0 failed; 154.2 s. Flight 02: 154.5 s. Flight 01: 151.6 s. No case added. Per case, against flight 02, all within 0.3 s: Go CLI install 16.4 s; timeout kill 2.2; clone failure 1.1; proxied MCP server 9.9; host environment value 2.3; `refresh_mcp` 4.4; empty-valued variable 2.8; uninstall 0.4; rebuild on another image 17.0; failed install ends offline 2.1; the six idle-timeout cases 17.9, 15.4, 11.6, 19.0, 17.7 and 12.6. "Short execs between polls" (19.0 s) remains the closest to its limit.
- **Pressure cases**: not run. Nothing they cover changed.
- **Hosted check**: 17 s and 14 s for the job; 500 passed against a floor of 480.
- **Flakes**: none, in three Docker runs, many unit runs and two hosted runs.

## Methodology Observations
All under mission-control 1.2.3. Where an observation repeats one from an earlier flight of this mission, it says so.

- **routine-maintenance, as the source of a scaffolded flight: a finding's evidence asserted that a test did not exist, and it did.** The inspection's evidence for finding 5 was marked as read, not run. The flight skill's scaffold carried it into the spec as fact, with a fix list, a checkpoint and an adaptation criterion built on it. agentic-workflow Phase 2a ("gather ground truth") caught it before a leg was written. Cost: no rework; the spec's framing, one checkpoint and the leg list had to be reinterpreted in the flight log. **Third flight in a row** in which leg design corrected the scaffolded spec's evidence (flight 01: a stale count and two inferences; flight 02: a second failing exit and a fail-open in `setNetwork`).
- **agentic-workflow, Phase 2d: the flight-end review reads tests and does not try to break them.** Cycle 1, told to read every added line, found one assertion that could not fail. Cycle 2 confirmed. The debrief's Developer then found three more cases that pass for the wrong reason. **Second flight in a row** (flight 02: two weak assertions found at debrief). Expected: nothing different from the skill's wording. Cost: one fix cycle (about 57,000 tokens and a re-review of about 47,000), and a squawk for the three.
- **agentic-workflow, Phase 2 (out-of-scope defects found mid-flight): followed, and one result was arguably worse for it.** The rule is to log and defer, with two exceptions (a grounding defect in the flight's path; a defect that fails the squawk gate). Squawk 0034 is one condition in the method the leg was editing, in the same family of data loss as the finding, and it met neither exception, so it was left out. Cost: a known way to lose the registry is open in a pull request that edits those lines. Recorded because the rule has no case for "same lines, same family".
- **agentic-workflow, Flight Director Decision Log, against the flight-log format: deviations go to the Notes and the Deviations section stays empty.** The skill says to log orchestration decisions under Flight Director Notes. The log's format has separate Deviations and Decisions sections, and no phase prompts the Flight Director to fill them. **Second flight in a row** that the debrief had to fill Deviations in. Cost: a reader looking under Deviations at landing finds nothing.
- **agentic-workflow, Phase 2b and 2d: every leg uncommitted until the flight's end (second flight in a row).** Consequences this time: the argv experiment had to be scheduled as the first edit of the flight so that an empty diff could prove it was undone; the fix cycle's experiment needed a saved copy of the method to compare against; every spawn carried a list of forbidden git commands. No loss occurred.
- **agentic-workflow, Phase 2d to Phase 3: no place for verification that needs a pushed branch (third flight in a row).** The hosted run was recorded in a second commit (`6438db1`).
- **agentic-workflow, Phase 2d step 3, against the crew file: who commits (third flight in a row).** A Developer was spawned to commit (about 40,000 tokens). It caught a miscount in the Flight Director's file list (19 paths described as 18) and proceeded on the list.
- **agentic-workflow, Phase 2a steps 3 and 4 (design review, and re-review after substantive changes): worked.** Leg 1 took two passes; the first removed a mechanism (the lock) and the second found the revision had left a failure of the directory listing uncovered and a guard that would not have guarded. Leg 2 took one.
- **agentic-workflow, Phase 2a (risk tier): leg 2 was tiered high "on doubt" for a ten-line change.** The review found three inconsistencies in the leg and one wrong statement about existing behavior. Recorded as the "when in doubt, tier high" line paying off.
- **sortie, Verb Plan: the operator asked to log a sortie for later, and the skill has no way to do only that.** Plan runs qualify, charter gate, create, design. Its gate says to stop and recommend a mission when a criterion fails, and two were in doubt. The Flight Director created the artifact at `planning` with a draft charter and the doubt written at its head, did not run the charter gate or the design, and recorded that in the sortie's log. Expected by the skill: either a full plan or a stop. Cost: an artifact in a state the skill does not describe (`planning`, charter not agreed).
- **squawk, Verb Log: two squawks were written without invoking the skill.** The skill's text was loaded in the session and its steps were followed (gate checked aloud in the flight log, evidence gathered, next id). Recorded because the project's instructions say skills are invoked, and the difference left no trace except here.
- **flight-debrief, Phase 2 (Developer instruction to run the full suite): the Docker suite had run on the identical tree about 40 minutes earlier (third flight in a row).** Cost: about 2.5 minutes. Value this time: per-case times to compare with flight 02's, all within noise.
- **flight (scaffolded), carried input from a debrief: one suggestion was wrong.** Flight 02's debrief wrote into this flight's spec "consider doing the sweep while holding the registry lock". It was labeled as input, not decision, and the design review overturned it. Recorded as the label doing its job.

## Recommendations
1. **Merge #13 once this debrief is on it, then run `/mission-control:mission-debrief`.** Every criterion of mission 01 will be met in code. The mission's outcome sentence is truer in some clauses than others, and the mission debrief is where to say so: the check reports but does not block (no ruleset on `main`); interrupted installs are reconciled only after seven hours and only at a start; the sweeps act only after an hour and only at a start.
2. **Do squawk 0034 before anything else touches `src/registry.ts`,** and with it the other open squawks in one turnaround. 0034 is small, in the same lines as this flight, and a real way to lose the registry.
3. **Take what this flight learned about the registry into sortie 04** (written into its artifact with this debrief): the lock is not a guard as it stands; the version check must be everywhere before a format change ships; a process on the old format fails every call the moment a new build writes; an install in flight at that moment cannot record its own failure; the check provides no migration.
4. **Change how new tests are reviewed.** Add to the Reviewer's prompt in `.flightops/agent-crews/leg-execution.md`: for each new test, name the change to the source that would make it fail, and for any that is not obvious, make that change, run the test, and undo it by editing. This is the one process change two flights of evidence point to.
5. **Treat an inspection's "read, not run" evidence as a lead in any scaffolded flight**, and re-verify every claim that something is missing before designing on it. Three flights, three corrections.

## Action Items
- [ ] Operator: merge #13 once this debrief is on it.
- [x] Logged as squawk [0035](../../../../squawks/0035-startup-and-sweep-tests-pass-for-the-wrong-reason.md): three weak cases in this flight's tests (`shutdown` not waiting; sweep isolation in one direction only; the directory case passing through a logged failure).
- [x] Logged as squawk [0036](../../../../squawks/0036-lock-release-removes-a-lock-it-no-longer-holds.md): the registry lock's release removes a lock it no longer holds. The steal itself (taking the lock from a live writer after 5 seconds) is design and goes to sortie 04.
- [x] Squawk [0034](../../../../squawks/0034-registry-file-that-is-not-an-object-loads-as-empty.md) raised to `grounding` by the operator: to be completed before any further work on `src/registry.ts`.
- [x] The Reviewer prompt in `.flightops/agent-crews/leg-execution.md` now asks, for each new test, which source change makes it fail, and to try it where that is not obvious (operator's decision at this debrief).
- [x] Sortie 04 updated with what this flight learned about the registry.
- [x] The flight log's Deviations section filled in.
- [ ] After #13 merges: check off mission criteria 3 to 5 and this flight's "Code merged"; then the mission debrief.
- [ ] Operator, from flight 01: ruleset on `main`; publish `maintenance/2026-11-15.md` or not.
