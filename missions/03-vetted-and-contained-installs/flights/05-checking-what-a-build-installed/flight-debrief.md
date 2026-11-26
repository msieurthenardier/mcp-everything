# Flight Debrief: Checking What a Build Installed

**Date**: 2026-11-25
**Flight**: [Checking What a Build Installed](flight.md)
**Status**: landed
**Duration**: 2026-11-25 (planned, flown and debriefed the same day)
**Legs Completed**: 3 of 3. Planned as two; leg 2 was split at design.
**Plugin version**: mission-control 1.2.4

## Outcome Assessment

### Objectives Achieved
- **Build output on the volume.**
  - New sandboxes keep their build output on the volume they already have: `/opt/mcpe` is a symlink to `/workspace/.mcpe`, made afresh on every build attempt, and `GEM_HOME` is `/opt/mcpe/gems`.
  - No path constant changed, so discovery, the recipes and `PATH` are untouched, and older sandboxes keep working.
  - The Docker suite checks that gron's binary lands at `/workspace/.mcpe/bin/gron`, in both the uncontained and the contained install, and that a retry clears the first attempt's output.
- **A check after the build.**
  - A scanner marked `"stage": "build"` runs after a successful build, over the sandbox's volume read-only at `/scan` (working directory `/scan`), and before discovery runs anything.
  - Under `block`, findings at or above the threshold leave the project `failed`, offline and without tools.
  - `discover_tools`, `refresh_mcp`, `connect_mcp_server` and `disconnect_mcp_server` refuse it until it is reinstalled (DD10).
  - Under `warn`, the findings are stored and reported.
- **Reporting.**
  - Install results and `project_info` show the build stage's report.
  - The `security:` line adds its counts, or says "build output not checked at install".
  - The server's instructions name build-stage scanners separately, and `check_project` says they did not run.
  - `docs/checking.md` documents the stage, its ten limits and the upgrade note.
- **Checkpoints.** All met:
  - leg 1's Docker run;
  - legs 2 and 3's Docker run, with the new case blocked under `block` and ready with the finding under `warn`;
  - the flight review, confirmed.

### Mission Criteria Advanced
- **"With scanning on, what a build installed is checked before its tools are published, and generated tool descriptions … are checked."** Its second half was flight 3; this flight completes the criterion.
- **"A project already installed under that slug is left working as it was."**
  - Unchanged for the check before the build.
  - The check after the build cannot keep the previous version on a reinstall: it has been replaced by then (DD6, the operator's choice).
  - The mission debrief should record this carve-out against the criterion's wording.
- **"Which scanners run … are always visible to the agent"**, and **the README criterion's** build-stage and upgrade parts.
- **Mission open questions** closed in substance:
  - "Moving build output onto a volume": `/opt/mcpe` and gems are moved; Go's and Cargo's caches deliberately are not;
  - "Existing sandboxes after upgrading", for the build stage: by reinstall;
  - the `stage` part of "The scanner contract".
- **The mission's flight list is now all checked (flights 1–5).** Its criteria and open questions are still unchecked, as for flights 1–4: they are left to the mission debrief.

## What Went Well
- **The premise was checked before it was designed on.**
  - The Flight Director ran throwaway containers at planning: a Python venv with a pip console script, and Ruby gems from both `bundle install` and `gem install`, through the symlink.
  - That turned DD1's main risk into a fact before any leg was written. The Docker suite later confirmed Go through the link.
- **"Don't over-engineer" held in the code.** `src/` grew by about 200 lines:
  - no new Docker object, no new ownership surface;
  - no build-beside-and-switch, no migration of old sandboxes;
  - no registry version bump, no HAT.

  The specification grew instead: 10 DDs and 10 stated limits, mostly in answer to review findings. That was the right place for the growth.
- **Design reviews found real defects before code** (the Architect's count: each of DD1, DD4 and DD10 needed an amendment):
  - **Flight design review 1 found the block was one call deep.** `discover_tools` has no status gate, `finish()` sets `ready`, and the server's own advice told the agent to call it. That became DD10.
  - **Review 1 also found the scanner's working directory wrong.** `/scan/repo` would have scanned the checkout, not the output.
  - **Review 2 moved DD10's check into the installer**, so every caller meets it, and found the instruction at `src/server.ts:39`.
  - **Leg 1's review reordered DD1's clearing**, so a retry on an image with its own `/opt/mcpe` cannot leave stale output for the scanner.
  - **Leg 2's review found that `FakeDocker.runScanner` could never return a result.** It always threw, so no unit test could have made a scanner succeed. It also found the "replaced" sentence wrong after two blocks in a row.
- **Every leg ran clean.** No leg failed a check, no Developer needed a second spawn, and the flight review confirmed on its first pass.
  - The Reviewer made six mutations. Each made at least one test fail, and each was reverted with the diff stat checked.
  - The one line no test observed, the guard's verdict check, got a test proven to fail without it.
- **Destructive Docker code was read before it ran.** The Flight Director read the new Docker case's cleanup before its first run. It removes only objects labelled with its own fresh installation id, through the checked removers.
- **The anomaly was identified, not just recorded.** Auto-named containers vanished across both Docker runs. Watching the daemon for 15 s caught one (`busy_khorana`, image `mymusic-runtime`): another of the operator's projects. It is closed in the log with evidence.

## What Could Be Improved

### Process
- **The leg split came one review late.**
  - Flight design review 1 suggested splitting leg 2. The Flight Director declined, calling it a split by task type.
  - Leg 2's design review made the better argument, enforcement against reporting being a risk boundary, and the split happened then.
  - Cost: one leg artifact was rewritten. In between, `docs/checking.md` said `stage` "has no effect today" while the code said otherwise; harmless, because the flight committed as one.
  - The "enforce vs tell" boundary is worth recognizing at flight design next time.
- **The test double was found at leg design, not flight design.** The flight's verification plan assumed installer unit tests could script a scanner's result; the fake could not. Naming which doubles must return real results belongs in the flight's technical approach.
- **No per-case Docker timings.**
  - The suite took 801 s after leg 1 and 1258 s after legs 2 and 3, against flight 4's 670–724 s. The new case does two real gron installs, which explains much of the second step but not obviously all of it. Nothing separates new-case cost from drift (Docker Desktop's cache, the registry, the network).
  - Leg 1's step (about +80–130 s) has no clear cause in the diff.

### Technical
- **A throw out of the build stage is fail-open for DD10.**
  - If `runScanners` throws at the stage, the install fails through `settleFailure`: `failed`, with no `scan.build`, so `assertNotBlocked` does not hold it. A daemon error during the volume inspect would do it; an ownership refusal cannot happen there.
  - The server's ordinary failed-install advice then suggests repairing with `sandbox_exec` and `discover_tools`, which would publish unchecked output.
  - Leg 2 accepted it because a refusal cannot happen on the install's own volume. That argument covers ownership, not a daemon that fails to answer.
  - It is consistent with the documented limit that a build repaired by hand is not rechecked. But here the build succeeded and the check did not happen.
  - Fixing it means choosing fail-closed for a stage that errored. That sits against the mission constraint that a failed scanner never blocks, so it needs a design decision (Recommendation 1).
- **"Blocked" is implicit.** It is derived from `scan.build.decision.verdict`. A second cause of holding a project would have to extend `assertNotBlocked` and the advice branch. A small `isHeld(record)` would stop that.
- **`finishInstall` keeps accreting.** It gained a positional `replaced` boolean and a block ending that duplicates the failed-build ending, including the refusal-warning push. It is readable now; it is a candidate for extraction if another stage is added.
- **The build-stage scanner also sees the source and the agent's scratch space.** `/scan/repo` and `/scan/work` sit beside `/scan/.mcpe`. Scanner authors must know this; it is documented.
- **The `/workspace/.mcpe` and `/scan/.mcpe` paths** are in a constant (`OUTPUT_DIR`) in source, but literal in tests and docs. Acceptable for tests that pin the contract.

### Documentation
- **The integration suite's own-installation convention is undocumented.** Each destructive describe has its own data directory and installation id, labels every object with it, and removes only through the checked removers that insist on the suite's prefix. It has been practice since flight 4 and is written nowhere a contributor would find it (flight 4's action item "a contributor note on the three test entry points…" is the same gap).
- **No README or CLAUDE.md change was needed.** There is no new command or environment variable; the scanners file gains `stage`, documented in `docs/checking.md`.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|---|---|---|
| Leg 2 split into legs 2 (enforce) and 3 (report) at leg design | Too large for one pass; enforcement and reporting have different risk | Yes: look for the enforce/tell boundary at flight design |
| DD1's clearing moved out of the link branch, so it always runs | A retry on an image with its own `/opt/mcpe` would leave stale output for the scanner | Yes: check retry and fallback paths for any shell prelude at design |
| DD10 added at flight design review 1, then moved into the installer at review 2 | A block undone by one `discover_tools` call; any caller must meet the check | Yes: when adding a state, list every path to `ready` and every path that runs the project's programs |
| `FakeDocker.runScanner` extended to return results | It always threw, so the leg's criteria were untestable | Yes: name the doubles a leg needs at flight design |
| `replaced` sentence only when the previous record was `ready` | Two blocks in a row would claim a lost version | No: a one-off refinement |
| Non-blocking review item fixed: a test for the guard's verdict check | The Reviewer's mutation found it unobserved | Yes: already the crew prompt's practice |

## Key Learnings
- **Verify a design's empirical premise with throwaway containers at planning.** About five minutes of `docker run --rm` settled DD1 and DD2 before anything was built on them.
- **A new state needs its exits audited, not only its entry.** The block was correct where it was set, and undone one call later. Grepping every caller of `discover(` and `finish()` is cheap and found the full set.
- **Put a guard at the layer every caller crosses.** DD10 in the server would have left `refresh_mcp` and `disconnect_mcp_server` open. In the installer it covers everything, including callers that do not exist yet.
- **"Smallest shape" moves complexity into stated limits.** That is honest only if the limits are written where the operator reads them. Here they are in `docs/checking.md`, ten of them.
- **Test metrics.** Measured on `HEAD` (`91018b8`), one run each, by the debrief Developer:

  | Run | Passed | Skipped | Failed | Vitest | Wall |
  |---|---|---|---|---|---|
  | `npm test` | 2,957 | 72 | 0 | 5.71 s | 7.24 s |
  | `npm run test:slow` | 115 | 0 | 0 | 24.99 s | 27.9 s |
  | `npx vitest run` | 3,072 | 72 | 0 | 29.12 s | 32.2 s |

  Typecheck took 0.86 s and the build 1.4 s.
  - **Against flight 4:**
    - `npm test`: 2,907 passed in 4.15 s, so +50 tests and about +1.5 s. This run started cold.
    - `test:slow`: 110 passed in 17.0 s, so +5 tests (the real-shell cases) and about +8 s. That is not explained by five `sh` runs; machine load is likely and unmeasured.
    - The combined run: 3,017 passed in 18.9 s, so +55 tests and about +10 s, most of it the slow project.
  - **Skips:** 71 → 72, the new Docker-gated describe.
  - **Flakes:** none. The intermittent unit failure from flights 3 and 4 did not recur and is still un-named.
  - **Docker suite** (Flight Director; Docker 29.8.2, Docker Desktop on WSL2):
    - after leg 1: 66 passed, 5 skipped, 0 failed, 801 s;
    - after legs 2 and 3: 67 passed, 5 skipped, 0 failed, 1258 s;
    - flight 4, for comparison: 66 passed, 670–724 s;
    - object lists: unchanged apart from another project's auto-named churn.

## Methodology Observations
Plugin version 1.2.4 for all of the following.

- **Two reviews in a row disagreed about splitting a leg, and the skills give no tie-breaker.**
  - *Where:* `/mission-control:flight` Phase 5b, then `/mission-control:agentic-workflow` Phase 2a.
  - *What happened:* the flight design review suggested splitting leg 2. The Flight Director declined, reading the leg guidance ("never by task type") as against it. The leg design review then argued the same split on risk grounds, and it was taken.
  - *What was expected:* guidance that "enforcement vs reporting" of one feature is a risk boundary, not a task-type split.
  - *Cost:* one leg artifact rewritten; one review cycle's argument repeated.
- **The flight skill's verification step does not ask which test doubles the plan depends on.**
  - *Where:* `/mission-control:flight` Phase 4 ("Validation approach") and Phase 5b. The `FakeDocker.runScanner` gap passed two flight design reviews and was found by leg 2's design review.
  - *What was expected:* a planning prompt to name the doubles or fixtures whose capabilities the acceptance criteria assume, with the same "can it act / can it observe" audit the skill already asks of behavior-test apparatus.
  - *Cost:* a high-severity leg review finding, and the fake's extension added to leg 2's scope.
- **The `[HANDOFF:review-needed]` signal for leg design is emitted by the Flight Director, and the signal table attributes it to the Developer.**
  - *Where:* `/mission-control:agentic-workflow` Phase 2a step 6 and the Handoff Signals table.
  - *What happened:* the Flight Director emitted it on finalizing each leg's design, as step 6 says.
  - *What was expected:* one attribution.
  - *Cost:* none this flight; a possible source of confusion for a reader of the log. Recorded, not judged.
- **The debrief interview prompt does not point the Developer at the leg files.**
  - *Where:* `/mission-control:flight-debrief` Phase 2, the crew file's "Debrief Interview" prompt.
  - *What happened:* this flight's Developer read only the diff, the debriefs and the test runs, and said it could not judge leg-spec accuracy.
  - *What was expected:* the prompt asks about leg-spec accuracy, so it should name the leg files and flight log to read.
  - *Cost:* the "Leg Spec Accuracy" input came from the Architect and the Flight Director only.

## Recommendations
1. **Decide what a check that could not run means for DD10** (Technical; important). On a throw at the build stage, record `scan.build` with a `failed` check and a verdict that holds the project. That would be fail-closed for an errored stage, as opposed to a failed scanner. This contradicts the mission constraint that a failed scanner never blocks, so it is the operator's call: carry it to the mission debrief, or into a sortie if wanted. Not a squawk: it needs that decision.
2. **Record the build-stage carve-out against the mission criterion in the mission debrief.** "Left working as it was" now holds for the check before the build only. Also close the mission's open questions answered by flights 1–5, and confirm whether the isolation-runtime criterion was ever verified with `runsc` installed.
3. **Make the Docker suite print per-describe timings** (squawk 0063), and consider letting the new case share one build between its two modes. One build is not enough as it stands: a reinstall is the behavior under test for `warn`. The suite went from about 700 s to 1258 s, and nothing tells new-case cost from drift.
4. **Name the intermittent unit failure** (carried from flight 4, recommendation 4). `npm test` now takes about 6 s, so a loop of 20 runs under CPU contention costs two minutes.
5. **Write down the integration suite's own-installation convention** (squawk 0064) (own data directory and id, label filter, checked removers only), with flight 4's note on the three test entry points: a short contributor section in `CLAUDE.md` or a `test/integration/README.md`.

## Action Items
- [ ] Mission debrief (`/mission-control:mission-debrief`): Recommendations 1 and 2; assess every criterion and open question.
- [ ] Docker suite timings (Recommendation 3): **squawk 0063**.
- [ ] Intermittent unit failure (Recommendation 4): a squawk once named.
- [ ] Contributor note on the integration suite, with flight 4's note on the three test entry points (Recommendation 5): **squawk 0064**.
- [ ] Later, if another stage or hold arises: `isHeld(record)`, and extracting the block ending from `finishInstall`.
- [ ] Merge PR #34 (the operator's call).
