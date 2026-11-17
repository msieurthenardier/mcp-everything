# Flight Debrief: Owned Sandboxes

**Date**: 2026-11-16
**Flight**: [Owned Sandboxes](flight.md)
**Status**: landed (set to `completed` at the end of this debrief, on the operator's confirmation)
**Duration**: 2026-11-16 - 2026-11-16 (logged as a sortie, escalated, designed, flown in five legs, reviewed and debriefed in one session)
**Legs Completed**: 5 of 5
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
The flight did what its objective asks. In pull request #17, as one commit (`df7fa8d`, 22 files, +4765 / -281):

- **An installation has an identity.** Eight lowercase hexadecimal characters in a file named `installation-id` beside the registry, created once and never rewritten. Two starts at once on an empty data directory end with the same id.
- **What it creates carries that identity.** A new sandbox is named `<prefix><id>-<slug>` and its container and volume carry the label `mcp-everything.owner=<id>`. Two installations that configured nothing can no longer produce the same name.
- **The Docker layer checks before it acts.** Every operation resolves a name with one inspect, classifies the answer from its labels (this installation's, another's, from before ownership was recorded, not mcp-everything's), and acts on the container id it checked. A sandbox that is another's or not mcp-everything's is refused. "Docker could not be asked" is its own error and is never read as "not there".
- **Uninstall and reinstall have a way out.** Asked to uninstall a project whose sandbox is not this installation's, the record and tools are removed, the sandbox is left, and the result says which parts were left and whose they are. A reinstall builds beside such a sandbox under its own names and warns.
- **Existing sandboxes behave as before.** A sandbox with no owner label is acted on as it was, and one reinstall of its project replaces it with an owned one.
- **The operator can see who owns what.** `list_projects` begins with the installation's id; `project_info` ends with one line saying whose the sandbox is; the README gives the Docker commands.

### Mission Criteria Advanced
This is the mission's only flight and it reaches all six criteria. They are met by the code in pull request #17 and stay unchecked in the mission until it merges.

| Criterion | Result | Shown by |
|-----------|--------|----------|
| 1. Two installations that install the same repository each have a working sandbox, and neither changes the other's | Met | Docker suite, real daemon: two installations on two data directories; the first's container id, running state and networks compared after each of the second's steps |
| 2. An installation acts only on what it owns, and refuses each operation, not only removal | Met | Unit suite: a generated table of every guarded method against every class, and a test that fails when a method of the Docker layer is in no list. Docker suite: a tool call, `sandbox_exec` and the network setting refused; reinstall and uninstall leave the other's sandbox |
| 3. Both hold with nothing configured | Met | The Docker suite's two installations are built from an environment with `MCPE_NAME_PREFIX` removed |
| 4. A project from before the change keeps working until it is reinstalled; one reinstall gives it an owned sandbox | Met, with one part shown only in the unit suite | Docker suite: a sandbox made by hand with no owner label is run in, described and uninstalled. The reinstall over such a sandbox is traced in the unit suite and is not run against real Docker (see Not Shown) |
| 5. The operator can find out who owns a sandbox | Met | Owner label read from a real container and volume; the `project_info` line; the id line |
| 6. The README says what an installation is, how sandboxes are named, what to do on upgrading, and what is not covered | Met, with three small gaps | Read against the code by the review and by both debrief interviews (see Documentation) |

### Checkpoints
All nine of the flight's checkpoints are met. Two were met differently from how they were written:

- "The operator's five container ids unchanged": four, not five. The other installation uninstalled one project between the reconnaissance and the start of execution. The four were compared after every Docker run, seven runs in all, and never differed.
- "A tool call makes no more Docker round trips than today": shown by the Docker suite's time, not counted. 154 s before the flight, 158.5 s while every command still resolved by name (leg 2), 153.7 s once one check was carried through an operation (leg 3).

### Not Shown
- **The check by hand on the built server.** The spec asked for one. No crew member was allowed to start the built server, because on this machine it would open the operator's real registry. Both halves of the check are asserted by tests. The operator's first use of the new build is that check.
- **Anything on Windows.** The operator's second installation runs there. See Technical for what is most likely to differ.
- **A reinstall over an existing old-style sandbox, against real Docker.** This is the step the operator will take for every existing project after upgrading. The unit suite traces its order; the Docker suite covers its parts separately (uninstalling an old-style sandbox; installing under new names) and not together.
- **Two real processes.** The Docker suite runs two installations in one process on two data directories. They share only Docker and the file system, which is what two installations share.
- **Two sessions of one installation.** The accepted race (a stale write putting old names back after a reinstall) has no test and no guard, by the operator's decision.
- **Discovery when Docker stops answering mid-run**, as the real Docker layer reports it. See Technical, first item.

## What Went Well
- **The reconnaissance found the real case on the real machine.** Listing slug, container and status from the two registries showed that every sandbox was listed by at least one of them, which explained a maintenance finding, and that one project (`rea`) was listed by both as `ready` with a single container. The mission's problem was live, and the design was checked against it.
- **The mission interview narrowed the work before any design.** The draft charter had five clusters of decisions and a registry format change. The operator's actual case (two registries that cannot see each other, one Docker) moved the centre to the sandbox, and the Architect's viability check showed the registry's format need not change. The five flights sketched for the draft charter became one.
- **The Architect's first pass caught an ordering fault that would have orphaned every reinstalled sandbox.** As first drafted, a reinstall wrote the new names and then removed what was at the new names: nothing. The old sandbox would have stayed, running and unlisted.
- **Design reviews by a Developer changed three legs for the better.** Leg 1: a reinstall that could not remove the old sandbox would have returned a record naming a container never made. Leg 2: "not there" was decided too loosely, so a timed-out inspect would have read as a container that is gone. Leg 4: the safeguard for the two-installation tests guarded the wrong thing.
- **The safeguard finding deserves its own line.** The draft protected the operator's sandboxes by asserting that a test installation's id has the right shape. The leg 4 review pointed out that the danger was not a name but the data directory: a test that built its configuration without one would open the operator's real registry, whose id also has the right shape. The tests now refuse to proceed unless their data directory is one they made, under the temporary directory, with an empty registry.
- **A gate before the first destructive run.** For leg 5 the Developer wrote the Docker cases and stopped. The Flight Director read every guard and every removal in the new cases before they ran against a daemon holding the operator's sandboxes.
- **The operator's sandboxes were never touched.** Seven runs of the Docker suite, more than seventy source changes tried against the unit suite, and the same four container ids and four volumes at the end as at the start.
- **Tests were tried, not only read.** Each Developer listed, per test, the source change that makes it fail, and tried a share of them. The Reviewer tried sixteen more, ten from the "reasoned only" lists. Every one was caught. The debrief's Developer tried twelve and three survived (see Technical); two of those three are in places the legs' own lists had flagged as weak.
- **The coverage test.** The set of methods on the Docker layer must equal three written lists (guarded, reports only, touches no sandbox). A method added later cannot skip the guard unnoticed. It caught a method the Developer added as an experiment.
- **Simplicity was chosen four times, by the operator, and held.** The id alone with no display name; no acceptance leg; a scripted test and no behavior test; no fix for a race that needs two sessions and one user does not have. A second flight was dropped at approval.

## What Could Be Improved

### Process
- **The flight was specified with three legs and flew five.** Both splits were made at a leg's design review, because the leg was too large to review in one pass. No code existed at either split, so the cost was two leg drafts reworked and the spec's leg list edited twice. The spec showed the seams beforehand: its third leg joined three things (what a refusal means to each operation, the two-installation tests, the README); the first design pass had already said "leg 2 was too large"; and the spec itself counted 22 call sites and forty to fifty test cases to touch. The real numbers were 318 new unit cases.
- **`Installer.install` was edited in three legs.** Leg 1 gave it phases and a copy of the old record, leg 3 the checked reference, leg 4 the refusal branches. The one finding of the flight's review that was a false statement to the operator (a failed rebuild saying the sandbox "may still be online" when it was gone) came from two variables for one fact, set in different legs. The Developer's view is that one leg should have owned that method's sequence.
- **Three legs had no second design pass and two had no design pass of their own.** The method asks for a second pass when a review's changes are substantive. For legs 1, 2 and 4 the Flight Director took the review's fixes as given and skipped it, at about a hundred thousand tokens each. Legs 3 and 5 were the second halves of reviewed legs and were not reviewed again after the split. The flight-end review then found four minor issues and no blocking one, so the saving cost nothing visible this time.
- **The flight spec's second design pass was not itself reviewed.** It was the second of the two passes the method allows. It raised one high-severity issue and several of medium severity; they went into the spec and to the operator, who declined the high one.
- **A verification step was written that could not be run here.** The spec's check by hand on the built server was planned without asking where a built server would look for its registry on this machine. The Docker suite's apparatus was audited at planning; this step was not.
- **A saved output lost what it was saved for.** Leg 5's Developer piped the Docker suite's output through `tail` and lost the two test ids the run printed. The debrief's run saved the whole output: the ids were `0745822e` and `4c99937b`, and both left nothing behind.
- **The flight log's Deviations section had entries for legs 2 to 4 and none for the flight.** What changed at the flight's level (five legs, the changed rules, the gate, the check not done) was in the Flight Director Notes. Filled in with this debrief. The same was true of the last two flights of mission 01.
- **The spec has stale text.** The Technical Approach still says "Three legs"; the prerequisites say 500 unit tests (515 at the start of execution) and five sandboxes (four). The leg list was kept current. The spec is a record and is left as it is.
- **The operator's view of the weight.** Asked at this debrief how five legs, about sixteen crew agents and seven runs of the Docker suite felt for a day-old project with one user, the operator answered: about right.
- **A debrief rule cost a repair.** The Developer's trials at this debrief were told to undo each source change by editing and never with git, a rule carried from the flight, when nothing was committed. One undo matched the wrong place and corrupted `src/installation.ts`; the Developer saw a non-empty diff and repaired it. On a committed tree, restoring the file from the commit is the safe undo.
- **The live machine changed during planning.** One of the operator's projects was uninstalled by the other installation between the reconnaissance and execution. Recording the container ids at the start of execution, not at planning, is what made the later comparisons meaningful.

### Technical
In order of importance. None is critical.

- **Discovery's protection against "Docker could not be asked" is narrower than the flight log says.** Leg 4 made discovery stop with the error instead of recording "no commands found". Its tests inject that error into a command. The real Docker layer raises it from a command only in one case: the container looked stopped, and the inspect that follows failed. When the daemon stops answering in the middle of a discovery, `docker exec` fails with an ordinary non-zero result, which discovery reads as "no", as it did before the flight. So a project can still be recorded as ready with no tools after a daemon outage. The flight spec's own wording (a command on a held reference that fails because Docker stopped answering is a plain failure, read as "no commands found") describes what the code does; the flight log's leg 4 entry overstates it. The README does not make the claim. Closing it means recognizing the Docker client's own "cannot connect" failure, a second rule that reads message text; that is a design decision.
- **`Installer.install` should be split before the next change to it.** About 225 lines, three state variables for two facts, and a failure branch with four exits whose correctness depends on all of them together. Both interviews recommend the same three extractions, with no change in behavior: retiring the old sandbox; the build attempts; settling a failure. The Architect adds one state value in place of `phase`, `sandboxCreated` and `sandbox`. Mission 01 chose not to restructure this method; this flight is what made that worth revisiting.
- **No real-Docker case reinstalls over an old-style sandbox.** The flight review's fourth finding, deferred here. Both interviews say to add it: about 17 seconds in a suite of 206, on names that carry the suite's own prefix. A volume still in use, or a label that Docker formats differently, would pass the unit suite.
- **A lost `installation-id` with the registry kept disowns every owned project, silently.** A missing file is regenerated, by design. The new id owns nothing: every project made since the change is then refused, an uninstall leaves its sandbox, a reinstall builds beside it. The README covers a copied registry without its id file, which is the same outcome, and does not name this one. It could be detected cheaply at startup, because an owned record's names carry the id they were made under. That adds behavior, so it is a recommendation and not a squawk.
- **"Not there" rests on the English text of Docker's error.** The rule needs a clean non-zero exit, no timeout, and the words "no such container", "object" or "volume". The Architect's reading: the wording is stable and not localized, and a mismatch fails closed (every absent name becomes "could not be asked": first installs fail, uninstall keeps its record, nothing is touched wrongly, the message shows what Docker said). Only a local run of the Docker suite would catch a change of wording; the hosted check does not run it. A sounder second signal exists (a listing filtered on the exact name, where an empty answer means absent) at the price of one more call on a path that has already failed.
- **Windows, from the code alone.** Nothing ran there. Most likely to differ, in the Architect's order:
  1. The inspect's format string now contains literal double quotes, passed through to `docker.exe`. If quoting mangles it, every operation reports that Docker's answer could not be read. Loud, immediate, and nothing is touched.
  2. The id file's temporary file is removed in a `finally` with `fs.rmSync(temp, { force: true })`. A scanner briefly holding the file would turn a successful creation into a failed start. The next start succeeds.
  3. The id is read as valid with one trailing line feed removed and nothing else. A file restored by hand with Windows line endings, or with a byte-order mark, stops the process as invalid, and the error message invites exactly that kind of restore.
  The first thing to do on the Windows side is `project_info` on an existing project: it is read-only and exercises the format string, the label parsing and the Windows client at once.
- **Three tests pass with the behavior they guard broken** (found by the debrief's Developer; each was tried):
  - `Installer.uninstall` given the container's name as its volume: all 272 tests of the two files that cover it pass. The shared test double records only the container it was asked to destroy.
  - `connectMcp` checking the sandbox after closing proxied servers instead of before: all pass. `refreshMcp` has the same order and is protected, by a server test.
  - The id module's sweep of stale temporary files with its `isFile` check removed: all pass, because removing a directory fails and the failure is swallowed. Squawk 0035 records the same weakness in two other sweeps.
- **One state is worded three ways, in three places.** The Docker layer's refusal says a sandbox "is from before sandboxes had owners"; the installer's warnings and `project_info` say it "was made before ownership was recorded". A shown owner label is cut to 64 characters in one and to 40 in the other two. The classification itself is one function, as designed.
- **`project_info` cannot say why a check failed.** The reporting method turns every failure into "could not be checked, because Docker did not answer" and discards the reason. It can also wait up to 30 seconds on a hung daemon.
- **Smaller.** `hasNetwork` is called by nothing in `src/`. Every method of the Docker layer now has two behaviors, by name and by reference, and a gone container returns "missing" for one and throws for the other. A volume is classified by name and removed by name, since Docker gives volumes no id, so that one check and act are not on the same handle. The comment above the hosted floor says 831 tests; the suite has 833.
- **Open squawks this flight touched.** 0031 (the advice "the sandbox was kept" when no container exists) is fixed by the review's fix: the record is now deleted on that path, a unit case pins it, and the squawk's own scope gate had reserved that decision for this work. 0027 (startup errors print a stack trace) is worse: a bad `installation-id` file is a new startup error, with a careful message under a stack trace. 0035 gains a fourth case. 0029, 0030, 0032 and 0033 are unchanged; their cited lines moved.

### Documentation
- The README's new section states each limit the operator accepted, truthfully. Three things are missing:
  1. What to do about an `installation-id` file the process refuses. The error says to restore or delete it; the README says only that the file is never rewritten. It also does not say the file must be exactly eight lowercase hexadecimal characters and at most one line feed.
  2. That losing the id file while keeping the registry gives the installation a new id that owns none of its sandboxes.
  3. That `project_info`'s question to Docker can take up to 30 seconds when the daemon hangs.
- Patterns from this flight are written nowhere but the leg files: act on the id that was checked, never the name; build a message from facts, never from an error's text; a failure to ask is never an absence; the Docker layer's methods are enumerated by a test. A short comment at the head of `src/sandbox/docker.ts` would hold them.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Five legs, not three. | Two legs were too large to review in one pass; each was split at its design review. | Yes: count a leg per kind of risk when a spec is drafted (a guard; carrying a value through callers; what each caller does with a refusal; tests against a live daemon). |
| "Not there" is decided from Docker's own "no such" wording on a clean failure, not by asking whether the daemon answers (DD4). | A timed-out inspect would have read as a container that is gone. Mission 01's debrief had already faulted the pattern the spec pointed to. | Yes. |
| A method given a reference raises "could not be asked" from its own inspect, and discovery rethrows it (DD4, DD8). | Anything weaker would read "could not ask" as "gone". | Yes, with the limit under Technical recorded. |
| The Docker suite's guard is on the data directory; the id's shape is still asserted (DD10). | A test without a data directory of its own would open the operator's registry, whose id has the right shape. | Yes: for any test near real data, guard the route to the data, not a property of a name. |
| The fallback for a file system that cannot hard-link runs on any link failure except "exists" (DD1 said only "cannot link"). | Simpler, and the fallback is an exclusive create that fails honestly. | No. |
| A reinstall on unchanged names puts the record back when its first removal fails, where it deleted the record of a project that was ready. | Found at leg 2's design review, fixed in leg 3. | Yes. |
| The Docker layer gained a method that reports and never refuses, and the coverage test a third list. | `project_info` must never fail because of its question. | Yes. |
| `uninstall` returns what it left, as facts, and the server words the sentence. | The server must not build a sentence from an error's message. | Yes. |
| The baseline was four of the operator's sandboxes, not five. | The other installation uninstalled a project during planning. | n/a |
| No second design pass on legs 1, 2 and 4; no separate design pass on legs 3 and 5. | The changes were the review's own fixes; legs 3 and 5 were halves of reviewed legs. | Undecided: one flight is no basis. |
| Leg 5 had a gate between writing its Docker cases and running them. | Its cases issue removals on a daemon that holds the operator's sandboxes. | Yes, for any first run of destructive test code near real data. |
| The check by hand on the built server was not done. | It would have run on the operator's real registry. | No: do not plan a check that cannot be run where the flight flies. |
| Review findings 1 and 3 were fixed before the commit and re-reviewed; 2 was accepted; 4 was deferred to this debrief. | One was a false statement introduced by the flight; one a README overstatement. | Yes. |
| The flight branch was cut from the planning branch, not from `main`. | Pull request #16 was still open; the spec allowed either. | n/a |
| A conditional write against a stale record (DD11) was designed and removed before approval. | Declined by the operator: one user, a day-old project. | n/a |

## Key Learnings
- When two parties cannot see each other's records, ownership has to be written on the thing they share. Everything else in this flight followed from that sentence, and it came from the operator's description of their own machine, not from the draft charter.
- Check the thing, then act on the handle you checked. A name can be given to another container between the check and the act; an id cannot.
- A safeguard has to stand on the route by which harm would arrive. The first safeguard for the Docker tests checked a property that the dangerous case also had.
- A test double should fail only in ways the real thing fails. The discovery tests inject an error into a call that the real class almost never raises it from, so they pin a path that is mostly unreachable, and the log's claim grew from the tests and not from the class.
- Two variables for one fact will disagree. The review's one real finding was that.
- A method edited by three legs is reviewed three times in part and not once whole.
- The cheapest moment to split a leg is its design review. Both splits here cost a redraft and nothing else.
- Record the state of a live machine when work starts on it, not when it is planned.
- Protection that reads labels only protects against builds that write them. Both installations have to be upgraded, and each existing project reinstalled, before the outcome is real on the operator's machine.

## Test Metrics
Run for this debrief by the Developer, at `df7fa8d`, once each. Typecheck and build clean.

- **Unit suite**: 20 files, 19 passed and 1 skipped (the gated Docker file); 833 passed, 24 skipped, 0 failed; 1.78 s. Before the flight: 515 passed, 18 skipped, 1.65 s. Mission 01, flight 03: 500 passed, 1.65 s. So 318 more tests cost 0.13 s. The six more skipped are this flight's Docker cases.
  - By file: `server` 148 tests, 1317 ms (flight 03: 100 tests, 1262 ms); `proxy` 55 tests, 961 ms (47 tests, 893 ms); `installer` 124 tests, 235 ms; `installation` (new) 21 tests, 102 ms; `registry` 54 tests, 64 ms; `docker` 202 tests, 58 ms.
  - Slowest, unchanged since flight 03: 1005 ms ("leaves the project unchanged when the server does not start"), 205 ms, 106 ms, then five between 53 and 56 ms.
  - The id module's two-second wait is replaced in its tests, so nothing sleeps.
- **Default Docker suite**: 22 passed, 2 skipped (the pressure cases), 0 failed; 206.3 s. Before the flight: 16 cases, 154.2 s. On the final tree at landing: 204.05 s.
  - The sixteen older cases sum to 152.8 s, each within 0.3 s of flight 03's figure. "Short execs between polls" (19.3 s) is still the closest to its limit.
  - The six new cases sum to 51.4 s: first installation installs, 16.4 s; second installs beside it, 16.5 s; three operations refused, 0.2 s; reinstall beside the other's sandbox, 17.0 s; uninstall lets go, 0.3 s; a sandbox from before the change, 1.0 s. Three of them install the same small project; that is the fifty seconds.
  - The two test installations were `0745822e` and `4c99937b`. Nothing carrying either id, the suite's prefix or a temporary data directory remained.
- **The operator's sandboxes**: the four containers and four volumes listed before and after the run, identical to the ids recorded at the start of execution, each with an empty owner label.
- **Pressure cases**: not run. Nothing they cover changed.
- **Hosted check**: 19 s on `df7fa8d` (run 43986471387); 833 passed against a floor of 810.
- **Flakes**: none, in seven Docker runs and many unit runs across the flight and this debrief.
- **Trials at this debrief**: twelve source changes against the unit suite; nine caught, three survived (see Technical). Tree byte-identical to the commit afterwards.

## Methodology Observations
All under mission-control 1.2.3. Recorded, not judged. Where an observation repeats one from mission 01's debriefs, it says so.

- **flight, Guidelines (Leg Identification: "default to few, large legs", "1-4 legs typically"), against agentic-workflow Phase 2a step 3 (design review): the spec's three legs became five, both splits made by a design reviewer who found a leg too large for one pass.** The flight skill sizes legs by decision and risk and says volume alone never justifies a boundary; the reviewer's ground both times was that the leg could not be reviewed as one piece (a rewritten layer, a new test double and forty moved cases, plus the carrying of a new value through three callers). Expected: the leg list to hold. Cost: two leg artifacts redrafted, the spec's leg list edited twice, legs 3 and 5 entering implementation without a design review of their own. No code was reworked.
- **agentic-workflow, Phase 2a step 4 (re-review if substantive changes were made): skipped on three legs by the Flight Director's judgment, with the reason logged.** Each review returned "approve with changes" with high-severity items. The skill says to spawn a second pass after substantive changes. The Flight Director applied the review's own fixes and went on, at a saving of about a hundred thousand tokens a leg. Cost: none observed; the flight-end review found no blocking issue. Recorded because the skill's wording gives no way to tell "the reviewer's own fixes, applied as written" from "a redesign".
- **agentic-workflow, Phase 2a: no case for a leg split out of a reviewed leg.** Legs 3 and 5 were tiered high and had no design review, because their content had been reviewed as half of a larger leg. The skill's steps would have reviewed each again. Cost: none observed.
- **flight, Phase 5b (max two design review cycles): the second pass raised a high-severity issue and it went to the operator unreviewed.** The second Architect found that a stale write could undo a reinstall. The cap meant the revision carrying that fix (DD11) was not reviewed. It went to the operator with the spec, and the operator declined it. Expected by the skill: escalate to the human when issues persist after two rounds, which is what happened. Cost: none; recorded because the second pass found something as serious as the first.
- **flight, Phase 4 (premise-audit the apparatus on both axes): done for the scripted test, not for the spec's check by hand.** The Verification section asked for a check on the built server. On the operator's machine a built server opens the operator's real data directory, so no crew member could run it. Expected: the audit to cover every verification step, including the ones a person performs. Cost: one planned verification not done, replaced by test assertions and the operator's first use.
- **agentic-workflow, Phase 2b and 2d: every leg uncommitted until the flight's end (the third flight in this project to record it).** This time: 4,765 added lines in one commit and one review; every spawn carried a list of forbidden git commands; each Developer undid its trial edits by hand and compared files with saved copies. At this debrief the same rule, carried onto a committed tree, led to a corrupted file that had to be repaired by hand. No loss.
- **agentic-workflow, Phase 2d to Phase 3: no place for verification that needs a pushed branch (fourth flight in a row).** The hosted check ran after the commit and the push. It was recorded in the flight log at this debrief.
- **agentic-workflow, Flight Director Decision Log, against the flight-log format: flight-level deviations went to the Notes and the Deviations section held only the Developers' entries (third flight in a row).** Filled in at this debrief.
- **agentic-workflow, Phase 2d (the flight-end review tries tests): the change made after mission 01 worked.** The project's Reviewer prompt asks, for each new test, which source change makes it fail, and to try it where that is not obvious. The Reviewer tried sixteen and all were caught. The debrief's Developer still found three survivors in twelve, in places no acceptance criterion pointed at.
- **flight-debrief, Phase 2 (the Developer runs the full suite): the Docker suite had run on the identical tree under two hours earlier (fourth flight in a row).** Cost: 3.5 minutes on a daemon that holds the operator's sandboxes. Value this time: per-case times for six new cases, and the two test ids the earlier run had lost.
- **sortie, Verb Escalate: worked as written, and left the sortie sequence with a gap that a scan cannot see.** Sortie 04 was moved into the mission, so `sorties/` ends at 03 and "scan for the next number" gives 04 again, while mission 01's records speak of "sortie 04". Cost: none yet; a note in the flight log says the next sortie takes 05. The skill does not say what happens to the number of an escalated sortie.
- **sortie, qualification criterion 3 ("fits one flight"), read afterwards.** At escalation the draft charter failed three criteria, one of them "fits one flight". After the mission interview narrowed the work, the mission fit one flight, of five legs. A sortie's soft limit is two legs, so a mission was still the right vehicle. Recorded because the criterion was failed for the charter as drafted and the work that flew was a different size.
- **mission, Phase 5 (flight breakdown), with flight Phase 6: the mission was agreed at two flights and reduced to one at the first flight's approval.** The second flight existed to spare the operator a reinstall of five projects. The operator dropped it once the first flight's design showed a reinstall did the same. Cost: text written for the second flight's benefit removed from the first flight's spec. Recorded as the approval gate doing its job.
- **init-project (the project's `.flightops/ARTIFACTS.md`): the Location row for the flight debrief reads `mission-control:flight-debrief.md`, and for the mission debrief `mission-control:mission-debrief.md`.** The directory tree in the same file, and every existing debrief, use `flight-debrief.md` and `mission-debrief.md`. It reads as a skill name substituted into a file name. Expected: the file name. Cost: none; the tree and the existing files were followed.
- **squawk, Verb Complete: no way to close a squawk that other work has already fixed.** Squawk 0031 was fixed by this flight's review fix. Complete spawns a Developer and a Reviewer on a branch of its own; there was nothing to implement. The Flight Director wrote the corrective action and verification from the flight's records, named the flight's second Reviewer as the sign-off, and closed it on the operator's word. Expected by the skill: its own turnaround. Cost: a squawk closed by a route the skill does not describe.
- **agentic-workflow, Phase 2a step 3, on a machine with live data: the leg 4 design review was the control that mattered.** A Developer reviewing a test design before it was written found that the planned safeguard did not stand between the tests and the operator's registry. Recorded as the high tier paying off on a leg whose risk was to something outside the repository.

## Recommendations
1. **Before relying on this: upgrade both installations, then reinstall each existing project in each.** Start on the Windows side with `project_info` on an existing project, which is read-only and is the first run of this code on Windows. `rea` is listed by both registries: whichever installation reinstalls it first removes the sandbox the other is using, and the other must then reinstall too.
2. **Add the missing real-Docker case: a reinstall over an old-style sandbox.** It is the one step every existing project will take, and it is shown only in the unit suite.
3. **Split `Installer.install` before anything else changes it**, as the first leg of the next flight in this area or as a piece of work of its own: three extractions and one state value, no change in behavior, with the unit suite's order traces as the net.
4. **Decide about a lost id file.** Either warn at startup when a record's names carry an id that is not this installation's, or say in the README that deleting `installation-id` disowns every project. The first adds behavior and needs the operator's word.
5. **Leave the discovery limit as a recorded limit unless daemon outages become real.** The honest statement is the flight spec's: a command that fails because Docker stopped answering is a plain failure. Closing it needs a second rule that reads Docker's message text.

## Action Items
- [x] Operator: merge #16 and then #17, or #17 alone (it carries #16's two commits). *(Done: #16 merged as `ea16e9a` and #17 as `a7eabc0`, both squashed, on 2026-11-17 UTC. The hosted check passed on each push to `main`; run 44012617791 on `a7eabc0`.)*
- [ ] Operator, after merging: upgrade both installations; `project_info` on the Windows side first; reinstall each existing project in each installation.
- [x] After #17 merges: tick "Code merged" in the flight and the six criteria in the mission.
- [x] Logged as squawk [0037](../../../../squawks/0037-tests-pass-with-the-guarded-behavior-broken.md): three tests pass with the guarded behavior broken (the volume `uninstall` names; `connectMcp`'s order; the id module's `isFile` check).
- [x] Logged as squawk [0038](../../../../squawks/0038-readme-gaps-on-the-installation-id-file.md): README gaps (a refused `installation-id` file and its exact form; a lost id file with the registry kept; `project_info` waiting up to 30 seconds).
- [x] Logged as squawk [0039](../../../../squawks/0039-ci-floor-comment-states-an-old-count.md): the comment above the hosted floor says 831 tests; the suite has 833.
- [x] Logged as squawk [0040](../../../../squawks/0040-id-file-reader-rejects-windows-line-endings.md): the id file's reader rejects Windows line endings and a byte-order mark, and a failed removal of its temporary file fails a creation that succeeded (inferred from the code, not run).
- [x] Logged as squawk [0041](../../../../squawks/0041-one-sandbox-state-worded-three-ways.md): one wording for a sandbox from before the change, and one length for a shown owner label.
- [ ] Not logged, by the operator's choice at this debrief: a real-Docker case that reinstalls over an old-style sandbox (flight review, finding 4). It stays as recommendation 2.
- [x] Squawk [0031](../../../../squawks/0031-failure-advice-says-sandbox-kept-when-container-is-gone.md) closed as fixed by `df7fa8d`, on the operator's word.
- [x] Squawks [0027](../../../../squawks/0027-startup-errors-print-a-stack-trace.md) and [0035](../../../../squawks/0035-startup-and-sweep-tests-pass-for-the-wrong-reason.md) annotated with what this flight added to each.
- [x] Flight set to `completed`, on the operator's confirmation at this debrief.
- [x] The flight log's Deviations section filled in at the flight's level; the hosted run and this debrief's run recorded there.
- [ ] Not squawks, for the next planning conversation in this area: the split of `Installer.install`; a startup warning for a lost or mismatched id; a second signal for "not there"; recognizing a daemon outage inside discovery.
