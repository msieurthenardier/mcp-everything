# Flight Debrief: Checking a Project's Own Code Before It Runs

**Date**: 2026-11-22
**Flight**: [Checking a Project's Own Code Before It Runs](flight.md)
**Status**: landed
**Duration**: 2026-11-21 (planning) – 2026-11-22
**Legs Completed**: 11 of 11 (ten autonomous and the HAT)
**Plugin version**: mission-control 1.2.4

## Outcome Assessment

### Objectives Achieved
mcp-everything can now check a repository after the clone and before any of its code runs, and decide by an operator policy:
- **Opt-in switches.** `MCPE_SCAN` (`off`/`on`/`warn`/`block`), `MCPE_SCAN_BLOCK_AT`, `MCPE_SCAN_TIMEOUT` and `MCPE_SCANNERS`; nothing an agent can reach.
- **Operator scanners.** A contract for scanners the operator chooses: any container image writing SARIF to stdout, with an optional `entrypoint` (added at the HAT), a read-only checkout, no network unless asked, credentials by name and redacted from output.
- **A built-in check** of what each recipe will run from the repository, plus a few red flags.
- **Checked installs.** The check happens in a staging clone before anything of an installed project is touched; the build runs on exactly the checked bytes, and a blocked reinstall leaves the project working with one warning.
- **`check_project`**, which works whether or not installs are scanned.
- **A security status the agent always sees**: generated server instructions and a `security:` line.
- **Two changes for every install**: the clone became an owned one-shot container removed by id (fixing a timed-out clone that kept running), and the clone image is pinned by digest.
- **The README** documents all of it, and what none of it protects against.

The HAT with the operator passed every step on real repositories (`remy/nodemon`, `lovell/sharp`, `tomnomnom/unfurl`) with a real Trivy scanner. A warn install reported 12 HIGH and 14 MEDIUM findings; a block reinstall was refused while the installed tool kept running.

### Mission Criteria Advanced
| Mission criterion | This flight |
|---|---|
| Nothing configured: as today, and the agent is told | **Met** for scanning; the containment line says "not contained" until flight 2 changes it |
| Operator turns scanning on, adds scanners; agent cannot change them | **Met** |
| Checked before any code runs; blocking leaves an installed project working; failed scanner does not block | **Met** |
| Built-in list of what the build runs, and dependencies known to be vulnerable or malicious | **Half met**: the build-hooks half; the dependency half is flight 3 |
| Check without installing | **Met** |
| What a build installed and generated tool descriptions checked | Not this flight (flight 3) |
| Network containment; allowed-host failures | Not this flight (flight 2) |
| Stronger isolation runtime, used and requirable | Not this flight (flight 2); the runtime is reported, not required |
| README | **Flight 1's part met**; containment, runtime and outside services remain |

## What Went Well
- **The core sequence was right the first time.** DD6 (check in a staging clone before anything changes, then copy) and DD8 (a separate `installChecked` entry point with an outcome, leaving `install()` and its ~100 unit cases untouched) survived every review and the HAT without a defect in the sequence itself. DD8 came from the flight's second design review; without it, a blocked reinstall would have printed "Generated tools are callable".
- **Leg 1 answered mission 02's debrief.** It split `Installer.install` before anything new touched it; the later checked path reused its pieces instead of copying them. `install()` went from 222 lines to a 21-line body.
- **Trials found real test gaps, every leg.** Making a deliberate source change and requiring a test to fail caught a planned test that could not fail in legs 1 (1b, logged as squawk 0051), 5 (two), and 7 (two: the "other session" wrote through the same `Registry` object). Each was closed with a test that does catch it, except 1b, which leg 1's charter forbade.
- **The Docker gate held.** Every new destructive integration case was read by the Flight Director before its first run on the operator's daemon (legs 4, 5, 6, 8, 9 and the HAT feature). The operator's eleven containers kept their ids through all of it.
- **Security catches at design review, not in production:**
  - `cp -a` under `--cap-drop ALL` cannot preserve non-root ownership, and the planned test would have passed vacuously; trial 7 later proved the fix (`1234:1234` became `0:0` without `CHOWN`).
  - Scanner credentials could be echoed back to the agent, so they are now redacted.
  - A 4096-character line cap was a padding bypass for the red-flag check.
  - The windowed replacement was still bypassable by a payload longer than the overlap.
  - The newline check missed directory names.
- **`check_project` and the HAT.** The operator could check real repositories before any install was touched, and the HAT used exactly that to find the one shipped defect (below).

## What Could Be Improved

### Process
- **The flight was planned at 5 legs, then 6 and 7 at its design reviews, and flew 11.** Four legs were split at their own design reviews: `scan-rules` → +`build-hooks`; `clone-walk` → `owned-clone` + `clone-walk`; `check-before-build` → `checked-install` + `checked-install-server`; `agent-view-and-docs` → `check-tool` + `security-status-and-docs`. Each split separated a pure part from a Docker-touching or hostile-input part. The Architect's reading: the splits were the method working, and the forecast was the error. The legs were listed by subsystem ("scanner", "copy", "sweep") instead of by kind of risk. A leg that pairs an untrusted-input parser or an embedded shell script with a Docker change should have been two legs from the start. Mission 02's debrief already recommended counting a leg per kind of risk; this flight shows it again, more strongly.
- **Embedded shell needed a real-container trial at design time.** Design review found several things the walk script could not do as written in busybox:
  - which pattern matched (needed for the per-pattern cap);
  - links under `-type f`;
  - truncation through `head -c`;
  - a failing `find` inside a pipeline under `set -eu`;
  - newlines in directory names under `-name`.

  The HAT found one more: `-mindepth` disables `-prune`, giving a false "incomplete" on `remy/nodemon`. Leg 5's Developer hand-ran the fragment and found three more bugs. A short real-container trial of any embedded shell, before the leg is written, would have caught most of these at planning.
- **The Flight Director made a mistake of its own that review caught.** It introduced the overlapping-window line scan in leg 3's rewrite, and the second review showed it was still bypassable. A design change made under review pressure needs the same scepticism as the draft it replaces.
- **Flight Director wording beyond the evidence, again** (the recurring lesson of this project's debriefs): "The flight's `sh -c` wrapper advice" (DD2) assumed a shell where there is none; the HAT's first repository (`remy/nodemon`) was chosen on the assumption it had a `postinstall` script, which it did not at that commit (corrected by reading its `package.json`); the flight-log's first account of the `pwned` file overstated the test's blind spot (the flight review showed the walk `cd`s into the fixture first).
- **Leftovers from an aborted run went unnoticed for six legs.** Leg 1's Developer killed a Docker run it had started against a truncated source file. The run left behind:
  - a container and its volume, removed at leg 1's check;
  - four temporary data directories, found only at leg 9;
  - two unlabelled anonymous volumes, left for the operator.

  A post-leg sweep of `/tmp/mcpe-it-*` and of role-less `mcpe-it-*` names belongs in the leg-landing check.
- **Five Developers wrote one flight log.** Appends from the Flight Director and a Developer racing on the same file were avoided only by ordering legs strictly and by the Edit tool's stale-file refusal. Running a leg's design review in parallel with another leg's implementation worked (read-only), and it is where most of the wall-clock was saved.

### Technical
- **The unit suite got 7× slower.** It went from 1.82 s to 13.35 s, almost entirely `test/docker.test.ts` (58 ms → 12.7 s). Its new cases run the real walk script in a local shell over temporary trees; the file-budget case alone is 3.7 s. These are the project's first unit tests that spawn shells and do real I/O.
- **The Docker suite has a new baseline of ~280 s.** It was 206–209 s before. The four runs here were steady at 280–296 s, which also explains sortie 05's 280 s run that its debrief blamed on load.
- **File sizes grew:**

  | File | Before | After |
  |---|---|---|
  | `src/install/installer.ts` | 963 | 1231 |
  | `src/sandbox/docker.ts` | 730 | 1179 |
  | `src/server.ts` | 1048 | 1266 |
  | `src/scan/` (new) | — | 1563, of which `build-hooks.ts` is 973 |

  The installer's remaining weight is the discovery cluster (`discover*`, `foldAliases`).
- **Two entry points.** `install()` (scan off) and `installChecked()` (scan on) share their opening, remainder and failure settlement, so they cannot drift in what they share. They can drift in what each adds, and scan-on is likely to become the path most operators run.
- **The built-in check is a reading aid by design.** It is 973 lines of line-based heuristics, and its approximations are listed in the README: line-based `.npmrc`/`.yarnrc`/`setup.cfg`, unjoined requirements continuation lines, Python backend files only when walked, and pruned directories at any depth.
- **Scanners re-download their databases on every check.** No per-scanner cache (deferred by DD2 to flight 2).
- **`stage` in the scanners file is accepted and unused** until flight 3 adds stages.
- **Squawk 0051 is still accurate.** The Developer's debrief trial showed the swap in `settleFailure`'s branch still passes 376 tests. Its evidence count is stale (128 → 161 installer tests) and the branch gained a `proxy.closeProject` before it.
- **Corrections to the Developer's interview**:
  - The scanners file *does* have an `entrypoint` key (added at the HAT, `11fc4aa`).
  - `MCPE_SCAN_BLOCK_AT=note` *was* verified on the Go and generic paths by the flight review (the built-in check always carries notes).

### Documentation
- **README statements not verified by a run:** the exact Trivy command line beyond the HAT's (`fs --quiet --format sarif /scan/repo` worked), behavior under a real `runsc`, and the red-flag false-positive classes. The `sh -c` wrapper statement is now backed by an integration case (`entrypoint`).
- **Patterns from this flight not yet written down outside the legs:**
  - trials, and adding a test when a trial is not caught;
  - a separate-`Registry` writer for stale-write tests;
  - extracting behavior-preserving seams first, with no test edited;
  - the one-shot owned container with a closed role set;
  - the role-and-owner startup sweep;
  - the Docker gate before a first destructive run.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| 11 legs instead of 5–7; four splits at leg design reviews | Each planned leg carried two kinds of risk | Yes: plan one leg per kind of risk; a hostile-input parser or embedded shell plus a Docker change is two legs |
| `mayRemove` not extended (DD11 amended) | Every new case uses the suite prefix | Yes: widen a safety guard only when a case needs it |
| `pnpm-lock.yaml` and `yarn.lock` read for presence only | They choose the package manager; they can be megabytes | No (specific) |
| The copy container gets `CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `FSETID` | `cp -a` cannot preserve ownership without them | Yes, with the test that proves it (a non-root file and a mode-000 directory) |
| Redaction also before parsing | A cut finding could split a secret | Yes |
| `stagingName` and `removeStagingVolume` added in leg 7 | Leg 6 provided no removal | No; a leg-6 scope gap |
| Leg 8's tests adjusted in leg 10 (four startup cases) | The new unreachable-block log line appears where they asserted silence | No |
| HAT: depth check pruning fixed | `-mindepth` disables `-prune` | Yes: never combine `-mindepth` with `-prune` in a walk |
| HAT: scanner `entrypoint` added through the feature gate | The planned `sh -c` wrapper could not work | Yes: the gate (scope, design review, gated Docker case) worked in under an hour |
| A Developer killed its own Docker run | Its script had truncated a source file | No; the lesson is the exact-edits-only rule, given to every later Developer |

## Key Learnings
- **Count a leg per kind of risk, not per subsystem.** A planner can predict the splits by flagging any leg that combines an untrusted-input parser or embedded shell with a Docker-touching change.
- **Try embedded shell in the real image at design time.** Busybox `find`, `set -eu`, subshell counters and `-mindepth`/`-prune` all behaved unlike the spec's assumptions.
- **A trial that is not caught is a finding, not a failure.** Leg 1's 1b, leg 5's two and leg 7's two showed planned tests that could not fail; each became a test that can, or a squawk.
- **Test a capability's absence, not only its presence.** The copy test passed while ownership was not preserved, because the fixture was all root-owned; only a non-root file made it meaningful.
- **A check against a real repository finds what fixtures do not.** The `-mindepth` defect passed every unit and Docker case and was found on the first real repository with committed `node_modules` in its fixtures.
- **Sharing a daemon with other projects needs evidence, not assumption.** A container of another project (`afp-…`, agent-factory) vanished during a run; the owner-label and suite-prefix guards are what let the flight say, with evidence, that it was not ours.

## Methodology Observations
- **Flight skill, design phase (1.2.4).** The flight was designed with 5 legs, revised to 6 and 7 by its two Architect reviews, and flew 11. Four more splits came at leg design review in `agentic-workflow`. Each split was correct, and there was no rework of code, but each cost a leg rewrite and often a second design review: about eight extra review agents in all. The skill's guidance ("Default to few, large legs; add a boundary only where…") and the crew's lesson from mission 02 ("count a leg per kind of risk") pull in different directions; the planner followed the first. Expected: the flight skill's Leg Identification to name "untrusted-input parsing or embedded shell together with an external-system change" as a boundary. Occurred in this flight's planning and in mission 02 flight 01.
- **Agentic-workflow, leg cycle (1.2.4).** The skill has no step for the Flight Director to check for test leftovers (temporary directories, unlabelled Docker objects) after a Developer aborts a run. Here, four temporary directories survived six legs. Expected: a post-leg check in the leg transition. Cost: small; found by chance.
- **Agentic-workflow, design review cycles (1.2.4).** The "max 2 design review cycles" rule was reached on leg 3 (`build-hooks`) after the Flight Director's own rewrite introduced a new bypass; the second review caught it. The rule worked as a backstop. Recorded, not judged.
- **Squawk skill, mid-flight (1.2.4).** Logging squawk 0051 required leaving the workflow for the squawk skill, which then offered completion steps that did not apply mid-flight. No cost beyond reading; recorded for the sweep.
- **Flight-debrief skill, crew interview (1.2.4).** The Developer interview's report contained two claims already out of date at the time of the debrief (the `entrypoint` key; the Go-path verification), because the interview read the flight log only partly. Corrected by the Flight Director. Expected: the interview prompt to say the HAT's changes are part of the flight. Small cost.

## Recommendations
1. **Plan flight 2 by kind of risk from the start.** At least three: the proxy container and internal networks (Docker, ownership, lifecycle); the three network states in the record and the tools (state machine, possibly a registry `version` bump); and the runtime requirement (a startup preflight before the first one-shot container). Try the proxy's DNS and refusal rules in a real container before writing legs.
2. **Keep the unit suite fast.** Move the real-shell walk cases (about 11 s of `test/docker.test.ts`) into their own file or tag, so the default unit run is back near 2 s and the shell cases run on demand and in the hosted check. Logged as a squawk if the operator agrees (below).
3. **Pull discovery out of `src/install/installer.ts`** (the `discover*` and `foldAliases` cluster) before flight 3 adds stages there; a design decision for flight 3's planning, not a squawk.
4. **Complete squawk 0051 at the next turnaround**, with its evidence refreshed (161 installer tests; `proxy.closeProject` before the two calls).
5. **Write down this flight's patterns** where Developers read them (a short "Docker-layer and test patterns" note in `.flightops/agent-crews/leg-execution.md` or the head of `src/sandbox/docker.ts`): trials, the separate-`Registry` writer, extract-first, the one-shot owned container, the role-and-owner sweep, the Docker gate.

## Action Items
- [ ] Squawk 0051: refresh its evidence; complete at the next turnaround.
- [ ] Candidate squawk: split the real-shell walk unit cases into their own file so the default suite returns near 2 s (operator to confirm).
- [ ] Flight 2 planning: one leg per kind of risk; real-container trial of the proxy before legs are written; update the containment line in the instructions and README.
- [ ] Flight 3 planning: discovery extracted from the installer first; findings accumulated across stages in one `scan` record; the pre-clone dependency check on its own call path.
- [ ] The operator: the two unlabelled anonymous volumes (`530fd2a7…`, `2f223af9…`) left from leg 1's aborted run, to keep or remove.

## Test Metrics
All measured on the flight branch at `11fc4aa`, one run each.
- **Unit suite** (`npx vitest run`): 28 files passed, 1 skipped (the gated Docker file); 1511 passed, 37 skipped, 0 failed; 13.35 s (vitest), about 16 s wall. No flake. Against sortie 05 (890 passed, 24 skipped, 1.82 s) and mission 02 flight 01 (833, 1.78 s): +621 passed, +13 skipped, about 7× slower.
- **Per file**:

  | File | Tests | Time | Before |
  |---|---|---|---|
  | `docker.test.ts` | 300 | 12.7 s | 58 ms |
  | `server.test.ts` | 215 | 1.64 s | 1.32 s |
  | `proxy.test.ts` | 89 | 1.04 s | |
  | `scan-sarif.test.ts` | 31 | 1.03 s | |
  | `scan-build-hooks.test.ts` | 209 | 0.61 s | |
  | `installer.test.ts` | 161 | 0.40 s | |

  The cause of `docker.test.ts`'s growth is the real-shell walk cases (file budget 3.7 s; 5 MB lockfile 1.07 s; byte budget, 40-file cap and depth 0.4–1.4 s each).
- **Docker suite** (`npm run test:docker`, 2 pressure cases skipped each time):

  | Run | Passed | Duration |
  |---|---|---|
  | leg 8 | 33 | 295.6 s |
  | leg 9 | 34 | 280.8 s |
  | flight review | 34 | 286.2 s |
  | HAT `entrypoint` | 35 | 280.4 s |

  Against sortie 05 (22 passed, 208.6 s) and mission 02 flight 01 (206.3 s): +13 cases, +35–40% time; ~280 s is the new baseline. Pressure cases not run (the watchdog script is unchanged).
- **Typecheck**: clean. **Build**: clean.
