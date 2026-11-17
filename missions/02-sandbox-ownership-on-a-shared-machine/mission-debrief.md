# Mission Debrief: Sandbox Ownership on a Shared Machine

**Date**: 2026-11-16
**Mission**: [Sandbox Ownership on a Shared Machine](mission.md)
**Status**: completed
**Duration**: 2026-11-16 - 2026-11-16 (logged as sortie 04, escalated, agreed, flown as one flight of five legs and debriefed in one day)
**Flights Completed**: 1 of 1 (a second flight was dropped by the operator before it was designed)
**Plugin version**: mission-control 1.2.3 throughout (1.2.4 was available and not installed)

This mission had one flight, so much of what follows restates the [flight debrief](flights/01-owned-sandboxes/flight-debrief.md), which holds the detail, the test numbers and the evidence. What is added here: the outcome against the mission's own sentence, criteria and constraints; the planning that came before the flight; and the Architect's reading of the mission against what mission 01 left.

## Outcome Assessment

### Success Criteria Results
All six are met by the code in pull request #17 (`df7fa8d`). They stay unticked in the mission until it merges.

| Criterion | Status | Notes |
|-----------|--------|-------|
| 1. Two installations that share one Docker daemon and install the same repository each end up with their own working sandbox, and neither install changes the other's | Met, with a stated limit | Run against real Docker: two installations on two data directories install the same project, each runs a tool, and the first's container id, state and networks are unchanged by the second. Limit: both ran in one process, on Linux. |
| 2. An installation acts only on sandboxes it owns, and refuses each operation, not only removal; a sandbox from before the change is acted on as today | Met, with a stated limit | Every method of the Docker layer is tested against every class, and a test fails when a method is in no list. Against real Docker: a tool call, `sandbox_exec` and the network setting are refused; a reinstall builds beside the other's sandbox; an uninstall leaves it. Limit: a volume has no id in Docker, so it is checked by name and removed by name. |
| 3. Both hold for two installations that configured nothing | Met | The two test installations are built with the name prefix unset. |
| 4. A project installed before the change keeps working until it is reinstalled; one reinstall gives it an owned sandbox | Met, with one part shown only in the unit suite | A sandbox with no owner label is run in, described and uninstalled against real Docker. The reinstall over such a sandbox is traced step by step in the unit suite and has no real-Docker case. |
| 5. The operator can find out which installation owns a sandbox; one from before the change shows as unowned | Met | The owner label is on container and volume; `list_projects` states the installation's id; `project_info` says whose the sandbox is. When Docker cannot be asked, `project_info` says so without the reason, and can wait up to 30 seconds. |
| 6. The README says what an installation is, where its data directory is, how sandboxes are named, what to do on upgrading, and what is not covered | Met, with three gaps | Read against the code three times. Missing: what to do about a refused id file; that losing the id file disowns every project; the 30-second wait. Logged as squawk 0038. |

### Overall Outcome
The mission achieved its outcome in code, and the operator confirmed at this debrief that it is complete. It is not yet true on the operator's machine: that takes an upgrade of both installations and one reinstall of each existing project, and the first run of this code on Windows.

The outcome sentence says: "Two agentic systems on one machine, each running its own mcp-everything against the same Docker, can install, update and remove projects without touching each other's sandboxes." The accurate version of what was built, in the Architect's wording:

> Two installations of mcp-everything, each with its own data directory and a generated id, that share one Docker daemon and both run this build, make sandboxes named and labelled with their own id, and will start, run in, change or remove only sandboxes that carry it. For another installation's sandbox they refuse; an uninstall leaves the sandbox in Docker and removes only its own record. A sandbox made before the change is unowned, is treated as belonging to whichever installation lists it, and stays exposed to the other until its project is reinstalled. It is a protection against accidents, enforced by mcp-everything and not by Docker.

Where the two differ:

- **"Two agentic systems"** means two installations: two data directories. Two systems that share one data directory are one installation, by the operator's decision.
- **"Each running its own mcp-everything"** means this build, on both sides. An installation on an older build still treats every sandbox named `mcpe-<slug>` as its own.
- **"The same Docker"** was tested as one daemon on Linux with two installations in one process. Not two processes, and nothing on Windows, where one of the operator's two installations runs.
- **"Without touching each other's sandboxes"** holds for sandboxes made after the change. `rea`, which both of the operator's registries list today with one container, is the live exception until it is reinstalled on each side.

**The constraints held.** The registry's format is unchanged (`src/registry.ts` is not in the diff). Tool names and variable names are unchanged. Nothing rests on the registry lock: the id file is created with a hard link. No criterion depends on Windows and the README claims nothing there.

**One constraint is understated.** It says a single installation that shares Docker with nobody sees no change beyond its sandboxes' names and a small cost per operation, plus three named changes on paths where something has already gone wrong. The Architect's reading of the code adds these, on ordinary paths:

- Every start now creates or reads `installation-id`, and a bad file or an unwritable data directory stops the process.
- `list_projects` begins with a new line; `project_info` ends with one and asks Docker one question.
- Two tool descriptions changed, so a client's cached tool list differs.
- A reinstall renames the sandbox, so a proxied session held open by another session of the same installation drops and reopens.

And these, on paths where something has gone wrong: a reinstall on unchanged names whose first removal fails keeps the record; a removal while Docker is not answering now fails where it returned quietly; a container that mcp-everything did not make, sitting at a record's name, is now refused; an uninstall can succeed while leaving a sandbox. None is a regression. The list in the mission is a record of what was known at agreement and is left as written.

The outcome was still the right goal at the end. It is narrower than the charter the work began with, and the narrowing is why it could be met in one flight.

## Flight Summary
| Flight | Status | Key Outcome |
|--------|--------|-------------|
| 01 [Owned Sandboxes](flights/01-owned-sandboxes/flight.md) | completed | An installation id beside the registry; sandboxes named and labelled with it; the Docker layer classifies before every operation and acts on the id it checked; uninstall and reinstall let go of a sandbox that is not theirs; `list_projects` and `project_info` show ownership; the README section. Five legs (three planned), one review with four minor findings, two fixed before the commit. |
| 02 Carrying existing sandboxes forward | dropped before design | Would have let an installation claim an existing sandbox in place. Dropped by the operator at flight 1's approval: reinstalling a project once does the same. |

Across the mission: unit suite 515 to 833 tests (1.65 s to 1.78 s); Docker suite 16 to 22 cases (154 s to 206 s, the difference being three more installs); hosted check 19 s; no flake in any run. One commit of 22 files, +4765 / -281. About sixteen crew agents. The operator's four sandboxes were listed before and after every Docker run and never differed. Five squawks logged (0037 to 0041), one closed (0031); thirteen are open.

## What Went Well
- **The mission interview found the real problem.** The draft charter spoke of several agentic systems, owners, unique ids, where the registry lives, and sharing. The operator's description was two installations whose registries cannot see each other, sharing one Docker daemon and one set of names. That moved the centre from the registry to the sandbox, and four decisions in one round of questions (an owner is an installation; no sharing; existing projects keep working; accidents only) set the scope.
- **The viability check's main claims held.** The registry's format did not have to change. The check belonged in the Docker layer. Its count of call sites was right. That removed a format migration, a version bump and a lock-dependent upgrade from the plan before any flight was drawn.
- **The reconnaissance read the operator's machine and found the mission's case alive on it.** One project listed by both registries with one container. It also explained a maintenance finding (two containers the inspected registry did not list): they were the other installation's.
- **Scope went down at every gate.** Five flights sketched for the draft charter; two agreed; one flown. A display name, an acceptance leg, a behavior test and a fix for a race between sessions were each offered and declined. Nothing was added.
- **Every design review changed something that mattered.** The flight's first pass found an ordering fault that would have orphaned every reinstalled sandbox. A leg review found that a timed-out inspect would have read as "the container is gone". Another found that the planned safeguard for the Docker tests guarded a name when the danger was the data directory.
- **The operator's real sandboxes were protected by construction.** Tests that issue removals refuse to proceed unless their data directory is one they made; the Flight Director read that code before its first run; the container ids were compared after each run.
- **This mission fixed two of the inconsistencies mission 01's debrief listed.** `setNetwork(false)` no longer reads a failed inspect as "gone", and `Docker.state` no longer answers "missing" for "could not find out". The rule that "no" must never stand for "could not find out" now has a place in the code: two error types and one resolve step.
- **The split of decisions was right**, in the operator's judgment at this debrief: about ten were put to the operator, and the rest were made, recorded and reported.
- **The flight's weight was about right**, in the operator's judgment at the flight debrief, for a change that decides what gets removed on a machine holding real sandboxes.

## What Could Be Improved
- **The viability check undersold the cost.** "No restructuring of `Installer` is needed" was true as a prerequisite and missed what the change would do to it: a checked reference carried through three callers, an install sequence that needed phases because a reinstall now changes names, and about thirty places that catch an error and had to be given a decision each. The method mission 01 chose not to restructure is now the debt that most wants it. The check also did not run Docker, so the exact wording of Docker's errors, which a rule now rests on, was only seen in the flight.
- **The leg count was wrong by two.** Three planned, five flown; both splits at a leg's design review. Cheap, because no code existed, and predictable from the spec's own numbers.
- **The flight's test estimate was wrong by a factor of six.** "Forty to fifty cases touched" became 318 new cases. The estimate counted existing tests to move and not the tables the guard needed.
- **One protection is narrower than the flight log claims.** Discovery stops with an error when Docker "could not be asked", but the real Docker layer raises that from a command only in a narrow case. A daemon outage in the middle of a discovery still reads as "no commands found". The tests inject an error the real class rarely produces.
- **The step every existing project will take has no real-Docker test.** A reinstall over a sandbox from before the change is unit-tested only. The operator chose not to log it as a squawk; it stays a recommendation.
- **A planned verification could not be run.** The flight's check by hand on the built server would have opened the operator's real registry. It was planned without asking that question.
- **Three of mission 01's inconsistencies are unchanged, and three were added.** Unchanged: the reconciliation's unguarded refresh; a failed install writing a whole record with `put` (more such writes were added on the install path); `takeOffline` recording a guess when it could not ask. Added: the reporting method that discards why a check failed; "could not be asked" being a typed error from an inspect and an ordinary failed result from a command; the put-back of an old record at a failed reinstall, which loses a concurrent edit the same way the accepted stale write does.
- **The record still has no owner field.** The id lives beside the registry, by design, so that older builds cannot drop it. The price is that nothing compares a record's names with the installation's id: lose the id file and every owned project is silently disowned at the next start.
- **The squawk list is longer again.** Eleven were open at the end of mission 01. Two were completed before this mission, one was closed by it and five were logged by it: thirteen are open, and the turnaround mission 01's debrief asked for has not happened.
- **Two debriefs for one flight.** The Architect was interviewed twice and this artifact restates most of the flight's. The operator has no strong view on whether a sortie would have served; it is recorded as it happened.

## Lessons Learned

**Technical**
- When two parties cannot see each other's records, ownership belongs on the thing they share.
- Check the thing, then act on the handle that was checked. A name can be given to another container between the check and the act; an id cannot.
- A failure to ask is never an absence. That needs a type, not a convention, and it needs to reach every way of asking: here it reaches an inspect and not a command.
- Identity kept beside a file that older builds rewrite survives them; identity kept inside it would not. The cost is that the two can drift apart unnoticed.
- Protection that reads labels protects only against builds that write them. It has to be everywhere before it is relied on. Mission 01 learned the same about its version gate.
- A name that changes turns an old lost update into a lost sandbox. Before any future change to what a record's names mean, answer the stale-write question first.
- Two variables for one fact will disagree, and a method edited by three legs is where they did.
- A test double should fail only in ways the real thing fails. Twice in this mission a double could do something the real class cannot (raise a typed error from a command; forget a volume).

**Process**
- Ask the operator to describe their own machine before designing from a charter. One paragraph replaced five clusters of decisions with one.
- For a design near real data, put the safeguard on the route by which harm would arrive, and have someone other than the author read the destructive code before its first run.
- Record the state of a live machine when work starts on it. It changed between planning and execution.
- Count a leg per kind of risk when drafting a flight: a guard; a value carried through callers; what each caller does with a refusal; tests against a live daemon. That count was five.
- A viability check that does not run the external system should say which of its claims depend on that system's behavior, so the flight knows what to run first.
- Do not plan a verification step that cannot be run where the flight flies.
- Save a test run's whole output.

**Domain**
- The operator's ordinary setup is two installations on one Docker daemon, one inside WSL and one on Windows. "Several installations" is this project's normal case, as "several processes on one data directory" was found to be in mission 01, and nothing in the suite runs on Windows.
- The product's default name for a sandbox was the same for everyone. Defaults shared by every installation are a collision waiting for the second installation.

## Methodology Feedback
All under mission-control 1.2.3. The mission had one flight, so every recurrence count is "1 of 1"; where mission 01's debrief recorded the same thing, that is said, since the count across missions is what a later sweep needs. Each finding restates one in the [flight debrief](flights/01-owned-sandboxes/flight-debrief.md) unless marked as new here. Nothing is reported anywhere.

### Methodology observations
Each reproduces from the methodology alone and cost something observable.

- **flight, Guidelines (Leg Identification: "default to few, large legs", "1-4 legs typically"), against agentic-workflow Phase 2a step 3: a design reviewer split two legs because each was too large to review in one pass.** The flight skill sizes legs by decision and risk; the reviewer's ground was reviewability. Cost: two leg artifacts redrafted, the leg list edited twice, and two legs that entered implementation without a design review of their own because the skill has no case for a leg split out of a reviewed one. **1 of 1 flights.** Not recorded in mission 01.
- **agentic-workflow, Phase 2d to Phase 3: no step for verification that needs a pushed branch.** The hosted check could only run after the commit and the push, and was written into the flight log at the debrief. **1 of 1 flights.** Mission 01: 3 of 3.
- **agentic-workflow, Phases 2b and 2d: all legs stay uncommitted until the flight's end.** Cost: 4,765 added lines in one commit and one review; a list of forbidden git commands in every spawn; trial edits undone by hand against saved copies. No loss. **1 of 1 flights.** Mission 01: 2 of 3.
- **agentic-workflow, Flight Director Decision Log, against the flight-log format's Deviations section.** Flight-level deviations went to the Notes; the section held only the Developers' entries until the debrief filled it. **1 of 1 flights.** Mission 01: 2 of 3.
- **flight-debrief, Phase 2: the Developer is told to run the full suite regardless of what just ran.** The Docker suite had run on the identical tree under two hours earlier. Cost: 3.5 minutes on a daemon that holds the operator's sandboxes. It had value this time (per-case times for six new cases; two test ids an earlier run lost). **1 of 1 flights.** Mission 01: 3 of 3.
- **squawk, Verb Complete: no route for a squawk that other work has already fixed.** Squawk 0031 was fixed by the flight's review fix. The verb spawns a Developer and a Reviewer on its own branch; there was nothing to implement. It was closed from the flight's records with the flight's Reviewer as sign-off, on the operator's word. Cost: a squawk closed by a route the skill does not describe. **1 of 1 flights.** Not recorded in mission 01.
- **mission-debrief, for a mission of one flight (new here).** The skill runs the same phases whatever the number of flights: a second Architect interview, a second human interview, a second artifact. A sortie's single debrief does the mission's part as well; a one-flight mission has no such form. Cost: one more Architect interview (the flight debrief's Architect was continued, about 30,000 further tokens), four more questions to the operator, and an artifact that mostly restates another. Offset: the mission-level interview found that a constraint's list of behavior changes was incomplete, which the flight debrief had not. **Once, this mission.**

### Local fixes
Friction in this project's own configuration.

- **`.flightops/ARTIFACTS.md`, the Location rows for the two debriefs** read `mission-control:flight-debrief.md` and `mission-control:mission-debrief.md`. The directory tree in the same file and every debrief in the project use `flight-debrief.md` and `mission-debrief.md`, and those were followed. It reads as a skill's name substituted into a file name when the project was initialized or migrated. Not edited by hand: the project's rule is that methodology files are changed by `/mission-control:preflight-check` or `/mission-control:init-project`. Check whether it survives the update to 1.2.4; if it does, it is a methodology observation for the next debrief (cost so far: none).
- **The debrief crew file's Developer prompt** could carry two rules that were given by hand this time: save a test run's complete output; and on a committed tree, undo a trial edit by restoring the file from the commit. The second would have avoided a corrupted file at the flight debrief. Not changed; the operator's call.
- **Who ticks a leg's acceptance criteria** is still only in the spawn prompts (carried from mission 01).

### Local lessons
Real, and either not reproducible from the methodology alone or without an observable cost.

- A second design pass was skipped on three legs, on the Flight Director's judgment that the changes were the reviewer's own fixes. The skill asks for one after substantive changes and does not distinguish the two cases. No cost seen.
- The flight spec's second design pass raised a high-severity issue that, under the two-pass cap, went to the operator unreviewed. The operator declined it. No cost seen.
- The spec's check by hand was not covered by the apparatus audit the flight skill asks for. The Flight Director's miss; the skill's text covers it.
- Escalating sortie 04 left `sorties/` ending at 03, so a scan for the next number gives 04 again. Noted in the flight log; no cost yet.
- A sortie that failed "fits one flight" as chartered became a mission that fit one flight once narrowed, of five legs, which is still beyond a sortie's soft limit. The gate's answer was right for the work as it flew.
- The mission was agreed at two flights and reduced to one at the first flight's approval. The approval gate doing its job.
- The change made after mission 01 to the Reviewer's prompt (for each new test, which source change makes it fail) worked: sixteen tried, sixteen caught. A debrief Developer still found three survivors.
- A gate added by the Flight Director between writing destructive test code and running it. Not in the skill; worth repeating near real data.
- The high tier on a leg whose risk was to something outside the repository paid off: its design review found the safeguard that did not guard.
- The mission was set to `completed` at this debrief with its criteria unticked, because the criteria are ticked when the pull request merges. Mission 01 did the same.

## Action Items
- [x] Operator: merge #16 and then #17, or #17 alone (it carries #16's two commits). *(Done: #16 merged as `ea16e9a` and #17 as `a7eabc0`, both squashed, on 2026-11-17 UTC. The hosted check passed on each push to `main`; run 44012617791 on `a7eabc0`.)*
- [x] After #17 merges: tick the six criteria here in the mission and "Code merged" in the flight.
- [ ] Operator, to make the outcome real: upgrade both installations; on the Windows side run `project_info` on an existing project first (read-only; it is the first run of this code on Windows); then reinstall each existing project in each installation. `rea` is in both registries: the first side to reinstall it removes the shared sandbox and the other must then reinstall too.
- [ ] **A squawk turnaround.** Thirteen are open. The Architect's order, in four groups: housekeeping (0026, 0028, 0039); startup (0040, then 0038, with 0027); words then tests (0041, then 0037, 0029, 0035); failure paths (0030, 0032, 0033, after any split of `Installer.install`, or their lines move again). None needs to be `grounding`. 0040 is worth doing before the Windows side is relied on.
- [ ] For the next planning conversation in this area, in the Architect's order of importance. None needs a mission.
  - Split `Installer.install` before anything else changes it: three extractions and one state value, no change in behavior.
  - A real-Docker case that reinstalls over a sandbox from before the change.
  - A warning at startup when a record's names carry an id that is not this installation's. It adds behavior and needs the operator's word.
  - Guarded writes of a record, so that a stale write cannot put old names back. Worth a sortie only if several sessions of one installation are in real use.
  - Discovery during a daemon outage: recognize it, or keep it as a recorded limit.
- [ ] `/mission-control:routine-maintenance` is the usual next step after a mission debrief. The Architect's advice for it: look first at `src/install/installer.ts` and `src/sandbox/docker.ts` for structure, at the test doubles wherever one can do what the real class cannot, and at whether the hosted check should run the unit suite on Windows; do not re-audit the ownership classification, the README's installation section, or anything the thirteen squawks already hold.
- [ ] Carried from mission 01, not started: a test with two real processes on one data directory; a process-level test of `src/index.ts`; what the Node floor claim rests on.
- [ ] Operator: mission-control 1.2.4 is available (1.2.3 installed); update through `/plugin`, then `/mission-control:preflight-check`, and see whether the Location rows in `.flightops/ARTIFACTS.md` are corrected.
- [x] Mission set to `completed`, on the operator's confirmation at this debrief.
