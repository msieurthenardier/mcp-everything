# Flight Log: Checking What a Build Installed

**Flight**: [Checking What a Build Installed](flight.md)

## Summary
Planned and flown on 2026-11-25. Three legs, no HAT.
- **Leg 1, output on the volume.** New sandboxes keep their build output on the volume they already have: `/opt/mcpe` is a symlink to `/workspace/.mcpe`, cleared on every build attempt, and Ruby gems go there too.
- **Leg 2, the check after the build.** A scanner marked `"stage": "build"` checks that output after a successful build and before discovery runs anything. Under `block` its findings leave the project `failed`, offline and without tools, and it stays blocked until reinstalled.
- **Leg 3, reporting.** The agent is told what ran and what it found, and `docs/checking.md` states what this does not cover. Leg 2 was split into legs 2 and 3 at design.

Results:
- Flight review: confirmed, with one test added for a non-blocking gap.
- Unit tests: 2,957 passed, 72 skipped; the slow project, 115.
- Docker suite: 66 passed after leg 1, and 67 after legs 2 and 3 (0 failed).

---

## Reconnaissance Report

Items from earlier debriefs that touch this flight's scope, checked against `main` at `1034afb` on 2026-11-25.

| Item | Classification | Evidence | Recommendation |
|---|---|---|---|
| Flight 4 debrief, rec. 1a: the build-output volume goes through `classifySandbox` and `refuseUnless` | confirmed-live, reshaped | DD1 adds no new volume. The new Docker call that mounts the sandbox's volume for a scanner is the new surface; `requireVolumes` (`src/sandbox/docker.ts`) is the gate it goes through | Carried as DD8 |
| Flight 4 debrief, rec. 1b: a new way to obtain a `SandboxRef`, and the bypass tables updated in the same leg | confirmed-live | No new `SandboxRef` source is planned. The scanner method takes a volume name. `test/sources.ts` and `test/docker-bypass.test.ts` list the Docker calls | Carried as DD8, leg 2 |
| Flight 4 debrief, rec. 1c: decide what a reinstall does over a `before` sandbox | already-satisfied | `retireOldSandbox`, `src/install/installer.ts:676-686`: a `before` sandbox always has the old-style name, so `renamed` is true; the refusal is caught, the sandbox left in place, and `leftInPlaceWarning` added. Tested in `test/installer.test.ts` ("leaves it alone, builds under its own names…", the `before` volume case) | Retired; recorded in the flight's Open Questions. Presented to the operator at planning |
| Flight 4 debrief, rec. 5: call graph and normalized diff for split or move legs | not applicable | This flight has no split or move leg | None |
| Flight 4 debrief, action item: trim `mission.md`'s flight 5 entry of the old flight 4 text | confirmed-live | `mission.md`, Flights, flight 5 entry | Done at planning |
| Flight 3 debrief, rec. 3: state the in-process outbound path for a new stage | satisfied by design | The build stage calls no outside service from mcp-everything; a scanner's network is its own `network` and `hosts`, as at the source stage (DD4) | None |
| Flight 3 debrief, rec. 4: sample data shapes at planning | done | Python venv and Ruby gems through the symlink probed in throwaway containers on 2026-11-25 (flight Open Questions); Go and npm are installed by the Docker suite | None |
| Mission open question: "Moving build output onto a volume" | resolved here | DD1–DD3 | Check it off in `mission.md` when the flight lands |

Known from earlier debriefs, for this flight's runs:
- **Docker suite:** about 670–725 s.
- **One intermittent unit failure** has not been named (flight 4 debrief, recommendation 4). Note any failure's name if it recurs.
- **The CI floor** is still 867 passing tests (squawk 0062, open).

---

## Leg Progress

### Leg 1: output-on-the-volume
- **Status**: landed (Developer; Docker suite to be run by the Flight Director).
- **Changed:**
  - `src/sandbox/scripts.ts`: `OUTPUT_DIR`, `GEM_DIR`.
  - `src/install/recipes.ts`: exported `outputStep({ output, prefix })` (single-quoted paths, parent from `path.posix.dirname`), called by `PRELUDE` after `set -e` and before `mkdir -p ${BIN_DIR}`; contract comment updated.
  - `src/sandbox/docker.ts`: `GEM_HOME=/opt/mcpe/gems`, and `PATH` is `bin:gems/bin:venv/bin:cargo:go:<image>`.
  - `test/docker.test.ts`: environment and prelude-order pins. `test/docker-shell.test.ts`: five real-shell cases (no prefix, dangling link, link to another directory, regular file, real directory), each seeding `stale`.
  - `test/integration/docker.test.ts`: `readlink`/executable assertions in both gron installs; retry debris moved to `/workspace/.mcpe/bin`, and `readlink /opt/mcpe` asserted after the retry. Typechecks; not run.
  - `docs/security-model.md`: the `runsc` passage.
- **Verified:** `npm run typecheck`, `npm run build` clean; `npm test` 2909 passed, 71 skipped; `npm run test:slow` 115 passed. No failures or flaky tests seen.
- **Notable:** the retry test's fake first attempt skips the prelude, so only the second attempt's prelude clearing removes `stale`.

### Leg 2: build-stage-scanners
- **Status**: landed (Developer; Docker suite to be run by the Flight Director).
- **Changed:**
  - `src/scan/types.ts`: `ScannerSpec.stage?`, `BuildReport`, `ScanReport.build?`, and the guard **`buildReport(scan)`** (exported from `src/scan/types.ts`, for leg 3's `src/server.ts`). It returns `scan.build` only when it is an object whose `checks` is an array and whose `decision.verdict` is `"build"` or `"block"`; otherwise `undefined`.
  - `src/scan/scanners-file.ts`: `stage` parsed (`"stage" must be "source" or "build"`), returned only when given.
  - `src/sandbox/docker.ts`: `runScanner` follows `spec.stage`: build is `requireVolumes([{ role: "none" }])` and `/scan`; otherwise staging and `/scan/repo`.
  - `src/install/installer.ts`: private `scannersFor(stage)` (used by `checkClone` with `"source"` and the stage with `"build"`); `finishInstall` takes `replaced` (`before?.status === "ready"`, from both callers); the stage and its block branch sit right after the failed-build branch; public `assertNotBlocked(project)`, called first in `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp`.
  - `src/server.ts`: `refresh_mcp`'s `failed` gate and the failed-install advice say "blocked after the build" for a blocked project (through `buildReport`); every other failure is unchanged.
  - Tests: `test/scan-scanners-file.test.ts`, `test/docker.test.ts` (a "at the build stage" block under `runScanner`; the `CASES` table is keyed by method name and checked against the class's methods, so the build stage is not a second row but its own cases, with a comment on the row), `test/docker-bypass.test.ts` (the row's text), `test/installer.test.ts` (`FakeDocker.runScanner` now returns `scannerResults` by spec name and records `scannerRuns` with the volume, spec and exec count; a new `the check after the build` describe), `test/server.test.ts` (advice, `refresh_mcp` and `discover_tools` on a blocked project), `test/integration/docker.test.ts` (a new describe, below).
- **Docker case** ("the check after the build", written, typechecks, not run):
  - own directory `mcpe-it-bst-*`, own name prefix `<suite prefix>bst-`, own `scanners.json` with one `stage: "build"` scanner on `ALPINE` (`entrypoint: "sh"`) that lists `/scan/.mcpe/bin` and prints one `error` result naming the entries;
  - one `it`: gron under `block` (BLOCK_AT `error`) is `failed`, `scan.build.decision.verdict` is `block`, the finding names `gron`, `tools` is empty, `networkState` is `off`, and `discover_tools` is an error with the record still `failed`; then a second App on the same directory, under `warn`, reinstalls it: `ready`, `gron__gron` present, `scan.build` holds the finding. Then `uninstall_project`, `noRoleLeft()` and `objects()` are both empty.
  - `afterAll` mirrors the scan-mode cases': uninstall what the registry lists, then remove anything still carrying this describe's installation id, through the checked removers only (names under the suite's prefix), and assert nothing is left.
- **Record: the stage's throw path.** A throw out of `runScanners` at the stage (a refusal, an unusable volume) is not caught there. It reaches `settleFailure` like any throw out of `finishInstall`: the record is `failed`, with no `scan.build`, so `assertNotBlocked` does not hold it (a later `discover_tools` would work). Accepted: it cannot happen for the install's own volume (the gate admits it). The comment at the stage says so; a unit test pins the behaviour (a refusal scripted for the build scanner). A scanner that merely fails or times out never throws: `runScanners` reports it as a `failed` check.
- **Record: allowed on purpose on a blocked project.** `set_project_network` and `sandbox_exec` are unchanged. Neither runs the project's programs through discovery, and a blocked, networked sandbox is reachable only through `sandbox_exec`, the agent's own act. No code change. (`call_project_tool`, `listTools` and `find_project_tools` need `ready`; `uninstall_project` works as for any failed project.)
- **Verified:** `npm run typecheck`, `npm run build` clean; `npm test` 2948 passed, 72 skipped; `npm run test:slow` 115 passed. No failing or flaky tests seen. (Skipped is 72, one more than leg 1, the new Docker describe.)
- **Notable:**
  - `docs/checking.md` still says `stage` has no effect today; that and every rendering, `security:` line, instruction and `check_project` note are leg 3's.
  - The block error is `The check after the build blocked the install: <decision.reason>.` plus, when the replaced record was `ready`, ` The previous version was replaced before the build and is not restored.`
  - No path other than the four methods calls `discover` (grep of `discover(` confirmed).

### Leg 3: build-stage-reporting
- **Status**: landed (Developer; Docker suite not run, no Docker assertion needed a change).
- **Changed:**
  - `src/scan/types.ts`: exported `scannersAt(scanners, stage)` (absent `stage` means source); the installer's private `scannersFor` now calls it, so the rule lives in one place.
  - `src/server.ts`: `renderReport` shows the source checks as before and, when `buildReport` returns a report, `after the build:`, the build's checks (shared helper `renderChecks`) and an indented line with its decision's reason. `securityLine` adds `; after the build: N error, N warning, N note`, or `; build output not checked at install` when there is no (valid) build report and build-stage scanners are configured now; the early `not scanned` return is unchanged. `check_project` adds `Build-stage scanners (<names>) run only after a build, so this check did not run them.` after the report when any are configured. `securityParagraph` names source scanners as before and build-stage ones in a separate sentence ("run on the build's output, after the build and before tools are published: ..."); the "must be reinstalled" clause only under `block`; with no scanner at either stage it reads as before, and with build scanners only it omits the "no scanners of their own" clause. The "finish the build yourself" sentence adds that a project blocked by the check after the build is reinstalled instead.
  - `docs/checking.md`: new step 5 in the install list, `stage` documented under "Adding a scanner" (including `/scan` layout and the separate timeout budget), the reinstall paragraph, `check_project`'s paragraph, DD9's ten limits, and an upgrade note. `README.md`: the chapter summary mentions the build stage.
  - `test/server.test.ts`: `make` in "what the agent is told about security" takes a scanners-file string; new cases for the instructions (both stages, build only, none, the reinstall sentence), the `security:` line (build counts, not checked, malformed build as absent, unchanged without build scanners), verbose rendering, and `check_project`'s note both ways.
- **Verified:** `npm run typecheck`, `npm run build` clean; `npm test` 2956 passed, 72 skipped; `npm run test:slow` 115 passed; `test/readme.test.ts` passes. No failing or flaky tests seen.
- **Notable:**
  - The blocked-install error for a source-stage block is unchanged (that report has no build part); the build-stage block shows through `describe(…, true)` in the install result.
  - The `security:` line says "build output not checked at install" even when scanning is off now, following the leg (configured now, no build report).
  - The Docker suite asserts none of the changed strings.

---

## Decisions

---

## Deviations

---

## Anomalies

### Two auto-named containers gone after leg 1's Docker run
**Observed**: Two containers were in the list before the run and absent after: `strange_pascal` and `strange_tesla`, Docker's random names, not mcp-everything's. Nothing else differed.
- Docker's event log no longer held anything from before the run, so their image and what removed them are unknown.
- Every `docker rm` in `src/` and `test/integration/` targets mcp-everything's own objects, by id or by a name the gate checks.
- Earlier flights saw other tools of the operator's create and remove objects on this daemon (flight 4: `afp-reh-probe-twin-*`).
- The FD's planning probes used `--rm` and had finished hours before the snapshot.

**Severity**: cosmetic
**Resolution**: identified by the Flight Director after the legs 2 and 3 run, which showed the same churn (`awesome_buck` and `serene_ritchie` gone; `priceless_stonebraker` new, and already gone moments later). Watching the daemon for 15 s caught `busy_khorana`, image `mymusic-runtime:1b155a6043d5`, `Dead` and then removed. Another of the operator's projects starts and removes short-lived, auto-named containers on this daemon. Not mcp-everything's; nothing to do.

---

## Session Notes

### Flight Director Notes
- **2026-11-25, planning.** The operator asked for the smallest shape ("I don't want to over engineer it"). They chose:
  - accepting a build-stage block on a reinstall;
  - moving Ruby gems too;
  - no HAT.
- **2026-11-25, premise checks.** The Flight Director's own containers, run with `--rm` and anonymous volumes. Volume and container lists were the same before and after.
- **2026-11-25, design review 1** (Architect, Sonnet): approve with changes. All applied.
  - **High: a build-stage block is undone by `discover_tools`.** It has no status gate, and `finish()` sets the record `ready`. The server's own advice suggests that path. Confirmed by the FD in `src/server.ts` and `src/install/installer.ts`. This became DD10.
  - **Medium:** applied as follows.
    - The build stage's working directory is `/scan`, not `/scan/repo` (DD4).
    - The source stage gets only source-stage scanners (DD4).
    - `runScanner` picks the role from `spec.stage` (DD4, DD8).
    - `securityLine` gives the build stage's counts, and says when the build output was not checked (DD7).
  - **Low:** applied as follows.
    - The prelude's sequence is pinned (DD1).
    - The block branch keeps the build's refusal warnings (DD6).
    - Four limits were added (DD9).
    - The retry test proves the clearing.
  - **Not applied: splitting leg 2.** That would split by task type.
  - **Kept: `unreachableBlock`.** Its behavior is now stated deliberately.
  - **Answers to the Architect's questions:**
    - a `warn` finding needs no extra warning, because the `security:` line carries the counts;
    - the job display stays "installing" during the build stage.
- **2026-11-25, design review 2** (Architect, Sonnet): approve with changes. All applied. This is the second and last review cycle.
  - **Medium:**
    - DD10's check moved into the installer: `assertNotBlocked` at the top of `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp`.
    - The server instruction at `src/server.ts:39` is added to the text that changes.
  - **Low:**
    - `ScannerSpec.stage` is optional, and absent means `source`.
    - DD5 skips the stage when `record.scan` is unset.
  - **Question answered:** `set_project_network` on a blocked project stays allowed (DD10).
- **Status → `ready`**, pending the operator's approval of the spec.
- **2026-11-25, execution start.** `/mission-control:agentic-workflow flight 05 mission 03`.
  - Phase file `.flightops/agent-crews/leg-execution.md` loaded and valid.
  - Flight → `in-flight`.
  - 2 legs, no HAT.
- **Leg 1 (`output-on-the-volume`) designed, and tiered high-risk.** It changes where every new build writes its output (hard to reverse), and touches the gVisor docs. A Developer design review was spawned.
  - Found while designing: the `/opt/mcpe` link itself is in the container's layer, so gVisor's default overlay still needs `--overlay2=none`. The leg updates that passage of `docs/security-model.md`.
  - The prelude clears `/workspace/.mcpe` even when the image has its own `/opt/mcpe`. Otherwise a retry on such an image would leave the first attempt's output for leg 2's scanner.
- **Leg 1 design review** (Developer, Sonnet): approve with changes. All applied. The leg is `ready`.
  - The step is rendered by one function, `outputStep`, which the real-shell test runs with `sh -ec`.
  - The retry debris needs its own `mkdir`.
  - The uncontained gron assertions go before the reinstall.
  - A regular-file case was added, and every case seeds stale output.
  - The citation was corrected: no existing test pins the `PATH` or the prelude.
  - The warning text names the check after the build.
  - **Flight DD1 was reordered** to match the leg: the clearing always runs. Annotated in `flight.md`.
  - The changes were small, so there was no second review.
- **Leg 2 designed, and tiered high-risk** (a security-sensitive surface and a new blocked state). Design review (Developer, Sonnet): approve with changes.
  - **The split.** The leg was **split into leg 2 `build-stage-scanners` (enforce) and leg 3 `build-stage-reporting` (tell)**, along the review's proposed boundary. `flight.md`'s leg list is annotated.
  - **High: the test double could not return a result.** `FakeDocker.runScanner` in `test/installer.test.ts` always throws, so no unit test could make a scanner succeed. Leg 2 now extends it.
  - **Medium, applied as follows:**
    - The Docker case uses `ALPINE` with `entrypoint: "sh"` and its own scanners file. The scan-mode cases' file would block at the source stage.
    - The "previous version was replaced" sentence appears only when the replaced record was `ready`, so two blocks in a row do not claim a lost version.
    - The pinned tests are named: `test/server.test.ts`, about 1021, 2429 and 2495–2555; the gate rows in `test/docker.test.ts`.
    - A throw out of the stage stays an ordinary failed record, which is not held. It is stated as accepted, because it cannot happen on the install's own volume.
  - **Low:**
    - `dataDir` is passed to `runScanners`;
    - the wall-clock is now up to twice `MCPE_SCAN_TIMEOUT` (docs, leg 3);
    - the ordering test and the malformed-guard test are added.
  - The changes are within the review's own proposals, so there was no second review. Legs 2 and 3 are `ready`.
- **Leg 1 checkpoint: Docker suite** (`npm run test:docker`, FD): 66 passed, 5 skipped, 0 failed, 801 s.
  - The new assertions held: gron's binary is on the volume behind the link, in both the uncontained and the contained install; the retry clears `stale`.
  - Object lists: unchanged apart from the two auto-named containers under Anomalies.
- **Legs 2 and 3 checkpoint: Docker suite** (FD): 67 passed, 5 skipped, 0 failed, 1258 s.
  - The new case, "the check after the build", passed: blocked under `block`, with `discover_tools` refused; `ready` with the finding after a reinstall under `warn`.
  - The run took about 460 s longer than leg 1's 801 s. The new case does two real gron installs, and its scanner pulls `ALPINE` when not cached.
  - Object lists: only the auto-named churn of another project (Anomalies). No mcp-everything object was left or removed.
  - The FD read the new case's cleanup before its first run. It removes only objects labelled with its own fresh installation id, through the checked removers that require the suite's prefix.
- **Flight review** (Reviewer, Sonnet) spawned over all three legs.
- The review's non-blocking item (the unknown-build-verdict line in `buildReport` was untested) was fixed with a server test, "treats a build report with an unknown verdict as absent"; removing the verdict line was confirmed to fail it.
- **Committed** as `f76be81` (all three legs, the review fix, the artifacts), pushed. Draft PR #34 opened. The first push failed with a transient access error; the retry succeeded.
- **Landed.** Flight → `landed`. In `flight.md`, the criteria, checkpoints, the Docker prerequisite and the completion checklist are checked, except "Code merged". Flight 5 is checked off in `mission.md`; the mission's criteria and open questions are left to its debrief, as for flights 1–4. No CLAUDE.md change is needed: there is no new command or variable. The scanners file gains `stage`, documented in `docs/checking.md`. `[COMPLETE:flight]`.
- **Debriefed** (`/mission-control:flight-debrief`, 2026-11-25).
  - Developer and Architect interviews held. There was no interview with the operator: the log answered its questions.
  - Squawks 0063 (Docker suite timings) and 0064 (integration suite contributor note) were logged with the operator's OK.
  - Flight → `completed`.
