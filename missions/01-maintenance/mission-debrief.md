# Mission Debrief: Maintenance

**Date**: 2026-11-16
**Mission**: [Maintenance](mission.md)
**Status**: completed
**Duration**: 2026-11-16 - 2026-11-16 (scaffolded on 2026-11-15 by the maintenance inspection; three flights flown, debriefed and merged in one day)
**Flights Completed**: 3 of 3
**Plugin version**: mission-control 1.2.3 throughout (1.2.4 was available and not installed)

## Outcome Assessment

### Success Criteria Results
| Criterion | Status | Notes |
|-----------|--------|-------|
| 1. Every pull request and every push to `main` runs install, typecheck, unit tests and build on a hosted runner; `engines`, the README and a Node version file state the same floor (finding 7) | Met | Job `check`, 14 to 19 s. Each of Install, Typecheck and Unit tests has been seen red on the runner. The check reports and does not block: there is no ruleset on `main`, and the operator decided at this debrief that none is wanted. The floor (22.12) is stated in three places and tested only at the newest 22.x. |
| 2. After an install fails or is interrupted, the sandbox is off the network, its record says so, and the record does not stay `installing`; shutdown cannot hang; `disconnectMcp` does not store an emptied record; the failure branches have unit tests (finding 4) | Met, with a stated limit | A failed install ends offline at once, at every failure exit. An interrupted one stays as it was until a start that comes more than seven hours after the install began and finds Docker reachable. Shutdown exits within 15 s. The emptied record was reproduced and fixed. |
| 3. A test fails if a value appears in a proxied launch's command line or the env file is not private; env files left by a crash are removed at startup (finding 5) | Met | The first half was already true before the mission: the inspection's evidence was wrong. Four small gaps closed. Leftovers are removed once more than an hour old. |
| 4. A registry file written by a newer version is refused with a clear message and never rewritten (finding 6a) | Met | The data loss was reproduced first. The refusal protects only builds that carry it. |
| 5. Registry temp files left by a crash are removed at startup (finding 6d) | Met | Once more than an hour old, without taking the registry lock. |

### Overall Outcome
The mission did what it was scoped to do, and the operator confirmed at this debrief that the outcome is the one wanted: a bounded maintenance mission, with the stronger guarantees left to the ownership design.

Its outcome sentence reads more strongly than what was built, clause by clause. The accurate version, in the Architect's wording:

- "A change to `main` is checked before it reaches the people who install from it" → *a change to `main` is typechecked, unit-tested, built and pack-checked by a hosted job that reports and does not block.* Advisory by the operator's choice.
- "A failed or interrupted install no longer leaves a sandbox online" → *a failed install ends offline; an interrupted one is found at the next start at least seven hours later.*
- "The state mcp-everything leaves on disk is reconciled when it starts" → *at start, stale `installing` records, old env files and old registry temp files are cleaned up.* A container with no record, and a record with no container, are not.

The limits all come from one fact that every flight ran into and none was chartered to change: a registry record has no owner, and the registry's lock can be taken from a live writer. The mission worked around both with age rules (seven hours, one hour, one hour) and said so in the code. That is honest and it is not a design. It is the subject of the work logged as sortie 04.

The mission was still the right goal at its end. Its third flight delivered what the design work will stand on: the version gate, which has to be everywhere before the registry's format changes.

## Flight Summary
| Flight | Status | Key Outcome |
|--------|--------|-------------|
| 01 [CI Gate](flights/01-ci-gate/flight.md) | completed | One hosted job on every pull request and push to `main`; Node floor 22.12 stated consistently; Dependabot configured. One leg, one review pass, no deviation. |
| 02 [Install Failure and Interruption Paths](flights/02-install-failure-paths/flight.md) | completed | Failed installs end offline at both failure exits; `setNetwork(false)` no longer reports success unasked; stale installs reconciled at startup; bounded shutdown; `disconnectMcp` guard. Four legs, one review pass. Unit suite 396 to 447. |
| 03 [Local State Hygiene and Secret Hand-Off Tests](flights/03-local-state-and-secret-handoff-tests/flight.md) | completed | Crash leftovers swept at startup; a newer registry refused and left untouched; four gaps in the hand-off tests closed. Two legs, two review cycles. Unit suite 447 to 500. |

Across the mission: unit suite 396 to 500 tests with no measurable change in run time (1.63 s to 1.65 s); Docker suite 15 to 16 cases (151.6 s to 154.2 s); hosted job 14 to 19 s; no flake in any run. Eleven squawks logged (0026 to 0036), none completed; one sortie logged.

## What Went Well
- **The plan held.** Three flights were scaffolded and three were flown, in the planned order, with none added, removed or diverted. The order mattered: flight 01's check ran on flights 02 and 03, and its floor was raised twice as the suite grew.
- **Reading the code before designing a leg corrected the plan every time.** Flight 01: a stale test count and two inferences. Flight 02: a second failing exit of `install`, and a method that reported success when Docker had not answered. Flight 03: a test the inspection said did not exist. None of these cost rework, because each was found before a leg was written.
- **Design reviews of high-risk legs changed designs.** Flight 02's found that reconciliation could detach a neighbor's live build over a window of minutes, and that the planned guarded write would have changed `Registry.delete`. Flight 03's removed a lock that proved nothing and would have stalled startup. A second pass after substantive revision found a new fault each time it was run.
- **Defects were reproduced before they were fixed.** The emptied record in `disconnectMcp` (marked "inferred" by the inspection) and the version-2 registry rewritten as version 1 were both shown against the old code first. A consistency change and a precaution became two defect fixes with evidence.
- **The Docker suite was run locally before every pull request was marked ready**, as flight 01's debrief asked, since the hosted check does not run it. It never failed.
- **Each debrief changed the next flight.** Flight 01's put the Docker run and the test floor into flights 02 and 03, and had two check steps proven red. Flight 02's carried the lessons of startup work into flight 03's spec, one of which was then rightly overturned. Flight 03's changed the Reviewer's prompt.
- **The level of autonomy was right**, in the operator's judgment at this debrief: decisions that were the crew's to make were made, recorded and reported in a status note, and questions were kept for what was the operator's.

## What Could Be Improved
- **The inspection's evidence was treated as fact by the flights scaffolded from it.** Three flights, three corrections. Where the evidence was marked "read, not run" it was a lead, and the flight specs carried it as ground truth, with fix lists and checkpoints built on it. Finding 5 was half wrong.
- **Reviews read new tests and passed assertions that could not fail.** Six were found: one by a review, five at debriefs after reviews had confirmed (squawks 0029 and 0035). Every one was found by asking which change to the source would make the test fail. The Reviewer's prompt now asks that.
- **The mission ends with more open squawks than it began with.** It started at zero, after a turnaround, and logged eleven. Seven are small defects the flights found beside their work; two are test fixes; two concern the Node floor. A maintenance mission that leaves a longer list than it found is doing its job of finding things, and the list now needs a turnaround before anything is built on it.
- **Startup work accreted.** Three flights' worth now sits in four places (`App`, the proxy module, `Registry`, `Installer`), with three age rules justified three ways. Each addition was reasonable; together they want one owner. The Architect's advice is a narrow extraction as the first step of the next work, not a general restructuring.
- **The rules the flights followed are not followed everywhere.** The Architect read the mission's additions together and found: the reconciliation re-checks under the lock while the sweeps act on a bare `lstat`; `takeOffline` records "online" as a safe guess where the stated rule was to record what is known; `setNetwork(false)` treats any failed inspect as "the container is gone" when the daemon answers, so a record can say "off" for a container that was never looked at; `reconcileStale` calls `registry.refresh()` unguarded at its top and guarded inside its loop; a failed install writes with `put` where the reconciliation writes with the guarded `update`.
- **`Installer` and `server.ts` grew** (to 788 and 964 lines), in a mission that had decided not to restructure them. That decision stands; the growth is the cost.
- **Flight logs' Deviations sections were empty at landing in two of three flights**, with the deviations in the Flight Director Notes.
- **The maintenance report stayed uncommitted for the whole mission.** Five pull requests carried links to it that did not resolve. The operator was asked several times and decided at this debrief: it is published with this debrief, unchanged except for a note at its head.
- **Sortie 04 was logged as a sortie and is a mission.** The Architect's reading agrees with the doubt recorded when it was logged.

## Lessons Learned

**Technical**
- A value that answers "no" for both "there is none" and "I could not find out" will be read as "there is none". `hasNetwork` was fixed for one caller; `Docker.state` and the inspect inside `setNetwork` still answer that way.
- A check placed where every write must pass (`Registry.refresh`) is worth more than one at startup.
- A version gate defends only the builds that carry it. Ship it everywhere, then change the format.
- Protection that does not depend on the registry lock (age, here) is worth more than protection that assumes it, until the lock is fixed.
- Work that runs at startup on a directory several processes share: check again immediately before acting; write from the state under the lock; do nothing when the answer is unknown; give tests a promise to await; say in a comment what the rule does not cover.
- One definition of a file name, shared by the code that writes it and the code that sweeps it.

**Process**
- Re-verify every "X is missing" and every "inferred" in an inspection before designing on it. It is one grep.
- Reproduce before fixing whenever a finding's effect was reasoned and not observed.
- For each new test, name the source change that makes it fail; try it when that is not obvious.
- A correction that only shrinks the work can proceed and be reported at once; one that changes a criterion or widens risk goes to the operator first.
- With every leg uncommitted until a flight's end, plan experiments so they can be undone by editing and checked with an empty diff.
- Record a deviation as a deviation when it is made.

**Domain**
- The product's safety promises are about failure paths, and failure paths are where its tests were thinnest. The mission added about a hundred unit cases there.
- "Several processes on one data directory" is the normal case for this operator, not an edge case, and nothing in the suite runs two real processes against one registry.

## Methodology Feedback
All under mission-control 1.2.3. Every finding below restates observations already recorded in the three flight debriefs; the flights are named so that a later sweep counts each occurrence once. Nothing here is reported anywhere.

### Methodology observations
Each reproduces from the methodology alone and cost something observable.

- **agentic-workflow, Phase 2d to Phase 3: no step for verification that needs a pushed branch.** The order is review, commit, draft pull request, land. Hosted runs can only follow the push. Cost: a second commit in every flight to record them. **3 of 3 flights** (01, 02, 03).
- **agentic-workflow, Phase 2d step 3, against the default crew file: who commits.** The skill lists the commit as a Flight Director step; the crew file's protocol has a Developer spawned for it. The crew file was followed. Cost: one spawn of about 40,000 tokens per flight to run `git add` and `git commit` from a list. **3 of 3 flights.** (The crew file is the project's to change; the disagreement between the two texts is the methodology's.)
- **routine-maintenance into flight (scaffold): inspection evidence marked as read or inferred is carried into the flight spec as ground truth.** agentic-workflow Phase 2a corrected it each time before a leg was written. Cost: a spec whose evidence, fix list or checkpoint had to be reinterpreted in the flight log; in flight 03, a finding half wrong. **3 of 3 flights.**
- **flight-debrief, Phase 2: the Developer is told to run the full suite regardless of what just ran.** Flight 01 had changed no source or test; in flights 02 and 03 the Docker suite had run on the identical tree within the hour, in the flight review. Cost: about 2.5 minutes each time. **3 of 3 flights.**
- **agentic-workflow, Phase 2d: the single flight-end review reads new tests and does not try to break them.** Cost: two weak assertions shipped in flight 02; one fix cycle and three more weak cases in flight 03; two squawks. **2 of 3 flights** (02, 03; flight 01 added no tests).
- **agentic-workflow, Phases 2b and 2d: all legs stay uncommitted until the flight's end.** The crew file's Review prompt says "changes on the flight branch relative to its base" when nothing is committed, and from the second leg on any agent's `git stash` or `git restore` would destroy earlier legs. Cost: prompt text in every spawn, and experiments arranged around it; no loss. **2 of 3 flights** (02, 03; flight 01 had one leg).
- **agentic-workflow, Flight Director Decision Log, against the flight-log format's Deviations section.** The skill sends decisions to the Notes; nothing prompts filling Deviations. Cost: an empty section at landing, filled at the debrief. **2 of 3 flights** (02, 03).
- **agentic-workflow, Phase 2, out-of-scope defects found mid-flight.** In flight 02 the rule (log as a squawk, defer, note the id) was not followed, because it was unclear whether each item passed the squawk gate; three items had no id for the length of the flight. In flight 03 it was followed, and one item (squawk 0034) was left out of a leg that edited the same lines for the same kind of defect. Cost: items without ids; then a known data-loss path left open. **2 of 3 flights**, in opposite directions.
- **routine-maintenance, Phases 7 and 8: nothing says when the maintenance report and the scaffolded mission are committed.** Cost: links that did not resolve across five pull requests in a public repository, and one question put to the operator several times. **Recorded once** (flight 01), and it lasted the whole mission.
- **sortie, Verb Plan: no way to log a sortie for later without planning it.** The operator asked for exactly that. The artifact was created at `planning` with a draft charter and the gate's doubt written at its head. Cost: an artifact in a state the skill does not describe. **1 of 3 flights** (03).

### Local fixes
Friction in this project's own configuration, and fixed or fixable here.

- **Reviewer prompt** in `.flightops/agent-crews/leg-execution.md`: now asks, for each new test, which source change makes it fail, and to try it where that is not obvious. Done at the flight 03 debrief on the operator's decision.
- **Who ticks a leg's acceptance criteria**: not said by the skill or the crew file. Since flight 03 the spawn prompt tells Developers not to; the Flight Director ticks after the review. Could be written into the crew file's Implement prompt.
- **Who commits**: the crew file could be changed so the Flight Director commits artifacts-and-code from the reviewed tree, saving a spawn per flight. Not changed; the operator's call.

### Local lessons
Real, and either not reproducible from the methodology alone or without an observable cost.

- A security-sensitive leg was tiered low because an earlier phase had fixed its design (flight 01). No cost seen.
- A squawk turnaround leaves no test metrics; they were recorded one flight late (flight 01).
- The scaffolded leg list had a tests-only leg, which the leg-sizing rule calls a smell; the flight allowed folding it (flight 02).
- A flight left to leg design a decision whose better answer it had reserved for the operator (flight 02).
- Legs with no dependency on the one in review were drafted ahead and audited before `ready` (flights 02, 03). Worked.
- Two squawks were written without invoking the skill, whose steps were followed (flight 03).
- The Flight Director does not edit source, so a Developer was spawned to create scratch branches (flights 01, 02). The project's rule; its cost is tokens.
- Tiering a ten-line leg high "on doubt" found four faults in the leg (flight 03). Worked.
- Carried input from a debrief was labeled as input, and the next flight's design review overturned one item (flights 02 into 03). Worked.

## Action Items
- [x] Mission criteria 3 to 5 and flight 03's "Code merged" checked off after pull request #13 merged; the check ran on that push to `main` (run 43941422193, success).
- [x] The maintenance report [2026-11-15](../../maintenance/2026-11-15.md) published with this debrief, on the operator's decision, with a note at its head. The links to it now resolve.
- [x] Ruleset on `main`: closed. The operator does not want one; the hosted check is advisory by choice.
- [ ] **A squawk turnaround before any new work.** Eleven are open. The Architect's order: 0034 (grounding) with 0036, both in `src/registry.ts`; 0033 with 0032 (cleanup when something throws); 0030 with 0031 (wording around `takeOffline`; keep 0031 to wording); 0029 with 0035 (five weak assertions); 0027; 0026 then 0028 (the Node floor). The Architect would also make 0036 `grounding`, since the next design rests on the lock. The operator's call.
- [x] **Sortie 04 is a mission.** When it is picked up, escalate it (`/mission-control:sortie escalate 04`) and run the mission interview. The Architect's sketch and the decisions that are the operator's to make first are written into its artifact. *(Follow-up, 2026-11-16: escalated to [mission 02](../02-sandbox-ownership-on-a-shared-machine/mission.md) and moved there as its first flight. The operator narrowed the scope at the interview to two installations sharing one Docker daemon; the rest of the sketch is listed in that mission as not taken.)*
- [ ] **The one test worth having before that design**: two real processes on one data directory writing to the registry while a third reconciles, asserting no lost write. It needs no Docker, so it can run in the hosted check, and it tests the lock the design depends on.
- [ ] Carried, not started: a process-level test of `src/index.ts` when the suite can build (flight 02); what the Node floor claim rests on, a second job on 22.12 or a README statement (flight 01).
- [ ] Operator: mission-control 1.2.4 is available (1.2.3 installed); update through `/plugin` when convenient, then `/mission-control:preflight-check`.
- [ ] Operator: the remaining items from the inspection that were never part of this mission: secret scanning, push protection and Dependabot alerts; where `v0.3.0` should point; the merged branches.
