# Flight Log: Install Failure and Interruption Paths

**Flight**: [Install Failure and Interruption Paths](flight.md)

## Summary
Completed on 2026-11-16 (landed and debriefed the same day). Four legs completed the same day, with no deviation that changed a leg: failed installs end off the network, stale `installing` records are reconciled at startup, shutdown is bounded, and `disconnectMcp` refuses when the sandbox is gone. Unit suite 447 passed (396 before); Docker suite 16 passed.

### Flight Director Notes
- 2026-11-16: The operator said to start flight 2 after pull request #9 (the flight 01 debrief) merged. Flight set to `in-flight`; branch `flight/02-install-failure-paths` cut from `main` at `7257c17`.
- Crew file `.flightops/agent-crews/leg-execution.md` loaded and well formed. Developer and Reviewer on Sonnet.
- **Leg plan changed from the flight's tentative list**, within what the flight allows ("folding 4b's cases into the legs that change the behavior they test"). A tests-only leg would have pinned behavior that the leg before it had just changed, so 4b's cases go into the first leg. The first tentative leg carried two separate pieces of work, so it is split. Four legs: `network-off-on-failed-install` (4a first half, all of 4b), `reconcile-stale-installs` (4a second half), `bounded-shutdown` (4c), `disconnect-mcp-guard` (4d, and the hosted check's test floor). The flight's leg list is updated.
- Leg `network-off-on-failed-install` designed from a read of `Installer.install`, `Docker.setNetwork` and `hasNetwork`, `set_project_network`, and the three test files it touches. Two things the flight spec did not have:
  - The recipe-failure exit (not only the `catch`) leaves the sandbox online when the caller asked for `network: true`. The flight's decision (off after any failed install) covers it; the leg changes both exits.
  - `Docker.setNetwork(container, false)` reports success when Docker could not be asked at all, because `hasNetwork` returns `false` for any failed inspect. A record written `network: false` on that basis is the same fail-open the finding is about, and `set_project_network` would not be called to repair a record that already says "off". The leg makes `setNetwork(…, false)` throw when the daemon does not answer. It is a change to a shared method, limited to an error condition.
- Risk tier: **high**. The leg changes network and registry lifecycle on a security-sensitive surface, and one shared method with other callers. Design review by a Developer before implementation.
- Design review of leg 1 (one Developer, Sonnet): **approve with changes**. It confirmed the `setNetwork` claim by tracing `run` (a dead daemon resolves with a non-zero code; only a missing binary rejects) and found no caller of `setNetwork` or `hasNetwork` that behaves differently outside the error condition. Taken into the leg: `setNetwork` needs its own inspect result, not `hasNetwork`'s boolean, or it cannot tell "attached to nothing" from "could not ask" (high); the scripted double in `test/docker.test.ts` needs settable replies before the four cases can be written (high); "`destroy` was called" is vacuous for the rollback because the install always calls it once at its start, so the cases assert two calls (medium); the test doubles' additions are spelled out and kept off the shared `FakeDocker` (medium); a cheaper image for the Docker case; one README sentence. Three existing behaviors it pointed at are listed in the leg as out of scope. No second review pass: every change is the reviewer's own recommended fix, and none alters the design. Leg set to `ready`.
- Leg 1 landed with `[LAND:leg]`: 415 passed, 18 skipped (the new skip is the gated Docker case). I read the `src/` diff: both failure exits go through `takeOffline`, and `setNetwork(…, false)` probes the daemon only when the inspect failed. Left for the flight-end review: the comment "From here on the project's code only runs with the network policy the caller asked for" now sits above the failure branch instead of the lines it describes.
- Leg `reconcile-stale-installs` designed. The flight asked leg design whether the record carries a better ownership signal than age. It does not: no process id, host or heartbeat, and the container's state does not settle it (a live install has no container while it clones, and can have a stopped one while it pulls a second image). Age it is. The flight's "7200" is one recipe run; an install can run two, plus clone, pulls and discovery, so the limit in the leg is `2 × max(7200, installTimeoutSec) + 3 h`: seven hours by default. Two more calls made in the leg: when Docker does not answer at startup nothing is changed, so the next start retries (marking a record `failed` with the sandbox possibly still attached would end the retries); and the write is guarded, so a record another process has replaced in the meantime is not overwritten. The guard needs one new `Registry` method; no field is added to the record.
- Risk tier for leg 2: **high** (lifecycle change, several processes on one registry, a new method on a shared class). Design review by a Developer.
- Design review of leg 2, first pass (Developer, Sonnet): **approve with changes**, two high. (1) The window in which reconciliation could detach a container another process is building in was not "a few milliseconds": staleness was judged once, before a reachability check of up to 15 s and serial detaches of up to 90 s each. The leg now refreshes and re-checks each record immediately before its detach. (2) Building the guarded write by letting `Registry.mutate` skip on a falsy return would have changed `delete` (its arrow returns `false` for an absent slug). The leg now asks for a separate `Registry.update(slug, fn)`. Also taken: the write is built from the record under the lock, not from the earlier copy; the `App` keeps the reconciliation's promise so the startup tests can await it instead of polling (a poll passes vacuously for a fresh record); the limit is described as covering any realistic install, since with every step at its limit an install can outlast it (about 27,000 s against 25,200 s). The reviewer agreed with changing nothing when Docker does not answer.
- Second pass (a fresh Developer, narrower brief), because the first pass changed the leg substantively: **approve with changes**, none high. Taken: warnings are appended to those the record has under the lock, not replaced by the copy's; a shadowed parameter name; two criteria that only reading can check are marked so. Leg set to `ready`. That is the second and last design review cycle for this leg.
- Open question from the review, not taken into the leg: reconcile again when a later tool call finds Docker back, instead of waiting for the next start. It is behavior beyond the finding; raised with the operator at the end of the flight.
- Legs 3 and 4 drafted (status `planning`) while the reviews ran, since neither depends on leg 2's code. Each gets its citation audit against the tree before it is marked `ready`.
- Leg 2 landed with `[LAND:leg]`: 437 passed, 18 skipped. I read `reconcileStale`, `Registry.update` and the `App.start()` change: the sequence per record is refresh and re-check, detach, write under the lock, as the leg has it; `put` and `delete` are untouched (the write lines moved into a private `persist()`).
- Leg `bounded-shutdown`: citations re-checked, set to `ready`. Risk tier: **low**. A new module with no consumer other than the entry file, and one handler replaced in `src/index.ts`; no shared interface, no registry or sandbox state. No design review; the flight-end Reviewer covers it. Because nothing tests `src/index.ts`, the leg has a hand check on a scratch build outside the repository, with its own data directory.
- Leg 3 landed with `[LAND:leg]`: 445 passed, 18 skipped. Its hand check ran on a scratch build with its own data directory: exit 0 within 8 ms of one `SIGTERM`, and one shutdown for two. The exit-1 path on a hung close is shown by unit test only; a real hung close was not provoked.
- Leg `disconnect-mcp-guard`: citations re-checked, set to `ready`. Risk tier: **low**. Three lines in one method, bringing it in line with the three sibling methods beside it; the only changed outcome is on a missing sandbox, where it now refuses. The leg starts with the reproduction the flight asked for. It also raises the hosted check's test floor, one number. No design review.
- Leg 4 landed with `[LAND:leg]`: 447 passed, 18 skipped. **The defect the inspection reasoned out is real**: against the unchanged code, `disconnect_mcp_server` on a project whose sandbox was gone returned success and stored the record with its commands, tools and servers emptied. The hosted check's floor is now 430 (was 350).
- All four legs landed, nothing committed. Flight review: one Reviewer (Sonnet), given the legs and the diff and none of the Developers' reports. It is asked to run the Docker suite once (`npm run test:docker`), as the flight's Verification requires before the pull request is marked ready; the fork-pressure cases are not run, since the watchdog script, those cases and the default images are untouched.
- Flight review: `[HANDOFF:confirmed]` on the first pass, no blocking issue. The Reviewer went through each leg's criteria against the diff, found no path where a container stays attached while the record says `network: false`, and found no vacuous test (it said it did not read every added line of `test/installer.test.ts` closely). Its runs: typecheck clean; unit suite 447 passed, 18 skipped; **Docker suite 16 passed, 2 skipped (the fork-pressure cases), 0 failed, 153 s**, nothing left behind. That is the local Docker run the flight's Verification asks for.
- After the review, two wording fixes of mine and the Reviewer's, made by the Developer that commits and checked by me in the diff: the comment "From here on the project's code only runs with the network policy the caller asked for" moves back to the lines that apply the policy; and the README's last clause about `project_info` is made exact (before reconciliation it says the install "was started by another session or was interrupted"). The Reviewer's one artifact note, unticked criteria in legs 2 to 4, is fixed here: the criteria are ticked on the strength of its leg-by-leg pass.
- The flight's Verification also says "by hand, once: start an install with a build that fails, then `docker inspect` the sandbox". Not done as a separate hand run: leg 1's Docker case does exactly that against the real daemon (attached during the build, no network after, record `failed` and `network: false`), and it passed in the Reviewer's run. `project_info` prints the record's `network` field.
- Local rules for the crew, stated in every spawn: no `npm install`, `npm ci` or `npm run build` in this checkout (the operator's live instance runs from its `dist/`); no call to any `mcp-everything` tool; no existing container touched; scratch files outside the repository.
- Carried from the flight 01 debrief (recommendation 2): the hosted check's Typecheck and Unit-test steps have not been seen red on the runner. To be shown with throwaway pull requests against this flight's branch once its pull request is open, as flight 01 did for the Install step.

---

## Leg Progress

### network-off-on-failed-install
**Status**: completed
**Started**: 2026-11-16
**Landed**: 2026-11-16

#### Changes Made
- `src/sandbox/docker.ts`: a private `inspectNetworks` runs the inspect once; `hasNetwork` wraps it with the same meaning. `setNetwork(container, false)` now throws (`Failed to disable network for <container>: …`) when the inspect failed and `assertAvailable` says the daemon does not answer; with a reachable daemon a failed inspect means the container is gone and it returns. The probe runs only when the inspect's exit code is not 0. `setNetwork(…, true)` is unchanged.
- `src/install/installer.ts`: new private `takeOffline(record)`: on success `record.network = false`; on a throw `record.network = true` and one warning naming `set_project_network`; never throws. Used at both failure exits. The recipe-failure branch no longer applies `wantNetwork` (the success path applies it after the branch, as before); the `catch` calls it in the `sandboxCreated` branch after `record.error` is set. The no-sandbox branch is unchanged.
- `src/server.ts`: one clause each in the `install_project` description and its `network` property. `README.md`: one sentence under step 4.
- Tests: `test/installer.test.ts` (ScriptedDocker gained `probeError`, `setNetworkFails`, `removeContainerFails`, `destroyFails`; new describe "install failure paths", 14 cases); `test/docker.test.ts` (settable replies; 5 cases for `setNetwork(…, false)`: the four in the leg plus one where both the inspect and the probe time out); `test/integration/docker.test.ts` (one case). `test/helpers.ts` untouched.

#### Verification
- `npm run typecheck` clean. `npx vitest run --testTimeout 20000`: 415 passed, 18 skipped (before: 396 passed, 17 skipped). The extra skip is the new Docker case, which is gated like its neighbours.
- Seen to fail against the `src/` of `7257c17` (stashed with `git stash push -- src/`, restored afterwards): 8 of the new installer cases (recipe exit, recipe timeout, second-attempt pull failure, `removeContainer` failure, throw after the policy was applied, `setNetwork` throwing once, `setNetwork` throwing every time, throw followed by a failed turn-off) and 3 `setNetwork` cases (gone container with a reachable daemon, daemon not answering, probe timing out). The no-sandbox, success and `uninstall` cases and the two `setNetwork` cases that pin existing behavior pass on both sides, as intended.
- Docker case "leaves the sandbox off the network even when network was requested": passed alone in about 2.9 s wall clock (2.5 s reported by vitest), on `alpine/git:latest` (`cfg.docker.probeImage`); no fallback to `golang:1` was needed. No `mcpe-it-*` container or volume was left behind. The rest of the Docker suite was not run.
- `grep -n "offline" src/server.ts README.md`: the other hits (lines 879, 911) are about connecting an MCP server and remain true.

#### Notes
- A discovery failure cannot be produced by a throwing `exec` (discovery swallows exec errors), so the "throw after the policy was applied" case replaces the installer's `discover` with one that throws.
- Seen, not touched (the leg's three out-of-scope behaviors): the first-attempt `createContainer` failure with a container Docker did create; `removeContainer` succeeding then `createContainer` failing on the second attempt, so "The sandbox was kept" is untrue; `discover` throwing after the proxy opened sessions.

### reconcile-stale-installs
**Status**: completed
**Started**: 2026-11-16
**Landed**: 2026-11-16

#### Changes Made
- `src/registry.ts`: new `update(slug, fn)`. Under the lock and after the re-read it calls `fn` with the current record; a returned record is stored (file and map), `undefined` writes nothing and returns `false`. The write moved into a private `persist()` that `mutate` also calls; `put` and `delete` are otherwise untouched.
- `src/install/installer.ts`: exported `staleInstallLimitSec(cfg)` (`2 * max(7200, installTimeoutSec) + 10800`, with the reasoning and what it does not cover) and a private `isStaleInstall`. New `reconcileStale(now, log)`: refresh, collect stale records, return `[]` without touching Docker if none; `assertAvailable`, and on a throw log one line and return `[]`; then per record: refresh and re-check status and `installedAt`, `takeOffline` on a copy, `registry.update` that re-checks under the lock and writes the current record with `status`, `error`, `errorLog`, `network` changed and the added warning appended to the locked record's warnings; one log line per change; a throw is caught per record.
- `src/server.ts`: `App.start()` keeps the reconciliation's promise in `reconciling` (rejection caught and logged, `??=` so a second `start()` does not begin another). `shutdown()` and `stop()` do not wait for it.
- `README.md`: one bullet next to the shared data directory passage.
- Tests: `test/registry.test.ts` (5 cases), `test/installer.test.ts` (new describe "stale installs at startup", 14 cases; ScriptedDocker gained `availableCalls`, `unavailable`, `onAvailable`, `onSetNetwork`), `test/server.test.ts` (3 cases over a `FakeDocker` subclass whose `assertAvailable` resolves).

#### Verification
- `npm run typecheck` clean. `npx vitest run --testTimeout 20000`: 437 passed, 18 skipped (before: 415 passed, 18 skipped).
- All 22 new cases were run before the implementation and failed (missing `update`, `staleInstallLimitSec`, `reconcileStale`, `reconciling`); all pass after. No stash was used.
- No test waits on real time: `reconcileStale` takes `now`, and records are seeded relative to it. The server cases await `app.reconciling`.

#### Notes
- The docker suite was not run and no Docker case was added.

### bounded-shutdown
**Status**: completed
**Started**: 2026-11-16
**Landed**: 2026-11-16

#### Changes Made
- `src/shutdown.ts` (new): `SHUTDOWN_DEADLINE_MS = 15_000` (measured against the 10 s limit of the proxy's kill step) and `boundedShutdown({ close, exit, deadlineMs, log? })`, which returns a handler. The first call arms a timer (not unref'd) and runs `close()` (a synchronous throw counts as a rejection). Settling either way clears the timer and exits 0; the timer firing logs one line and exits 1. An `exited` guard prevents a second `exit`; later calls do nothing.
- `src/index.ts`: the one handler, with close step `app.shutdown()` then `app.server.close()`, `process.exit`, the constant and the stderr logger, registered for `stdin` end, `SIGINT`, `SIGTERM`. `main().catch` untouched. `App.shutdown` untouched; installs in flight are not awaited.
- `test/shutdown.test.ts` (new, 8 cases, fake timers): normal, rejecting, sync-throwing, hung (nothing at deadline minus 1 ms, exit 1 at the deadline, one log line), settle after the deadline, second call while pending and after finishing, the constant.

#### Verification
- `npm run typecheck` clean. `npx vitest run --testTimeout 20000`: 445 passed, 18 skipped (before: 437 passed, 18 skipped).
- Hand check on a scratch build (`npx tsc -p tsconfig.build.json --outDir <scratch>/shutdown-build`, `node_modules` symlinked, own `MCPE_DATA_DIR` and `MCPE_NAME_PREFIX=mcpe-it-shutdown-`, stdin held open): one `SIGTERM` exited 0 after 8 ms; two `SIGTERM`s 100 ms apart exited 0 after 106 ms (the 100 ms is the gap). Scratch build, symlink and data directory removed.

#### Notes
- The exit-1 path on a real hung close was not run by hand; it is covered by the fake-timer case only.

### disconnect-mcp-guard
**Status**: completed
**Started**: 2026-11-16
**Landed**: 2026-11-16

#### Changes Made
- `src/install/installer.ts`: `disconnectMcp` calls `await this.requireSandbox(project)` after its two input checks and before `closeProject`, and ends with `return this.finish(record)` in place of `this.registry.put(record); return record;`. Three lines changed.
- `test/server.test.ts`: new describe "disconnect_mcp_server when the sandbox is gone" (2 cases) beside the existing disconnect case: the refusal, and the two input errors first with no Docker call. The existing case is unmodified.
- `.github/workflows/ci.yml`: the floor `350` to `430` and the comment's `396` to `447`. Nothing else.

#### Verification
- The reproduction was written first and run against the unchanged `disconnectMcp`. It reproduced: with `docker.exists = false` and execs exiting 1, the call returned without an error and the stored record went from commands `[{demo, registered}]`, tools `[demo__add, demo__whoami, demo__hang, demo__mixed, demo__demo_build]`, `mcpServers` `[api]` and `warnings` `[]` to commands `[]`, tools `[]`, `mcpServers` `[]` and `warnings` `["No executables were discovered. ..."]`, with `proxy.size` 1 going to 0. The registered command and every tool were lost, the sessions were closed, and nothing said the sandbox was gone.
- After the change the same test passes: the error is the `requireSandbox` text, the stored record is deeply equal to the one before, `proxy.size` stays 1.
- `npm run typecheck` clean. `npx vitest run --testTimeout 20000`: 447 passed, 18 skipped (before: 445 passed, 18 skipped). The existing disconnect case passes unmodified.
- Floor: 447 passing, so the multiple of 10 between 15 and 24 below is 430. The workflow's count step run locally (`RUNNER_TEMP` in a scratch directory, JSON report from the workflow's unit-test command) printed `447 tests passed (floor 430)`. The YAML parses.

#### Notes
- The handler prefixes the thrown message with `Error: `, so the test compares against that.
- Nothing else seen outside the leg.

---

## Decisions

---

## Deviations

Filled in at the debrief. During the flight these were recorded only in the Flight Director Notes, which is not where a reader looks for them.

### A shared method's behavior changed: `Docker.setNetwork(container, false)`
**Planned**: the flight spec has the `catch` of `install` turn the network off, best effort.
**Actual**: `setNetwork(container, false)` itself now throws when the container's networks cannot be read and the daemon does not answer. It used to return as if the network were off.
**Reason**: a record written `network: false` on an unanswered question is the fail-open the finding is about.
**Impact**: `set_project_network(enabled: false)` and the install paths now report an error in that condition. No caller behaves differently when Docker answers.

### A public method added to `Registry`: `update(slug, fn)`
**Planned**: the flight spec expected reconciliation to need no new registry surface beyond, at most, a field (reserved for the operator).
**Actual**: one method that changes a record from what the file holds under the lock, and skips the write when the updater returns nothing. No field added.
**Reason**: the reconciliation's write must not replace a record another process changed.

### Leg list restructured
**Planned**: four legs, one of them tests only (4b).
**Actual**: four legs, 4b folded into the first, and the first split in two.
**Reason**: see the Flight Director Notes of 2026-11-16.

### Staleness limit of seven hours
**Planned**: "older than the longest install allowed (`timeout_seconds` is clamped to 7200)".
**Actual**: `2 × max(7200, installTimeoutSec) + 10800` seconds.
**Reason**: 7200 is one recipe run; an install can run two, plus clone, pulls and discovery.

---

## Anomalies

---

## Session Notes

### 2026-11-16 — commit, hosted runs and landing (Flight Director)
- Commit `c0828bf` (`flight/02: failed and interrupted installs end offline; bounded shutdown`), made by a Developer from an exact file list after the review confirmed, together with the two wording fixes noted above. Branch pushed; draft pull request #10 opened.
- **Green**: run 43923117497 on pull request #10, every step passed. From its log: 18 test files passed, 1 skipped; "447 tests passed (floor 430)"; "dist/index.js is packed". The hosted check does not run the Docker suite; that ran locally in the review (16 passed).
- **The two steps of the check never seen red on the runner** (flight 01 debrief, recommendation 2), shown with throwaway pull requests against this flight's branch, each closed without merging, branches deleted locally and on the remote:
  - Typecheck: pull request #11, run 43923322308, failed in about 11 s. Install passed, Typecheck failed (`test/ci-red-typecheck.test.ts(2,7): error TS2322`), every later step skipped. A type error in a test file is caught by Typecheck and by nothing before it.
  - Unit tests: pull request #12, run 43923448811, failed in about 16 s. Install and Typecheck passed, Unit tests failed (`FAIL test/ci-red-unit.test.ts > fails on purpose`), the count step and later steps skipped.
  - Still shown only locally: the Minimum passed tests step failing on a suite that mostly skips.
- Documentation: the README gained one sentence on the network after a failed install and one bullet on the startup reconciliation; the `install_project` description and its `network` property say the same. `CLAUDE.md` describes Flight Control only and needs nothing.
- Flight set to `landed`; flight 2 checked off in the mission. The mission's second success criterion and this flight's "Code merged" stay open until pull request #10 merges.
- For the operator, from this flight:
  - **A registry record carries no owner.** The startup reconciliation therefore goes by age (seven hours by default) and waits for the next start when Docker is not reachable. A process id and host in the record would let a start reconcile an interrupted install at once; it is a registry schema change, which the flight reserved for the operator. Not proposed as work here, only recorded.
  - Three existing behaviors seen in leg 1 and left alone, none logged as a squawk yet: a first-attempt `createContainer` that fails after Docker created the container can leave a container with no record; on a second attempt a removed container followed by a failed create leaves a kept record whose advice says "The sandbox was kept"; a throw from discovery leaves proxied sessions open until the next reinstall or uninstall.

### 2026-11-16 — debrief (Flight Director)
- Debriefed on the flight branch, before merge, so the debrief joins pull request #10: [flight-debrief.md](flight-debrief.md). Developer and Architect interviews on Sonnet. No human interview: the log had no gap that only the operator could fill.
- The Developer re-ran both suites at `77dc425`: unit 447 passed, 18 skipped, 1.64 s; Docker 16 passed, 2 skipped, 154.5 s, with per-case times recorded for the first time.
- From the debrief: the Deviations section above was filled in; flight 03 (still `ready`) gained a note on startup work with several processes on one data directory; four squawk candidates are put to the operator.
- The operator confirmed the four squawk candidates, the status change and the commit: squawks 0029 to 0032 logged as `open`, `routine`; flight set to `completed`; the debrief committed to this branch so it is part of pull request #10.

### 2026-11-16 — after the merge (Flight Director)
- The operator merged pull request #10 (`661db3e`) with the debrief on it. The check ran on the push to `main` (run 43931795421, success). Mission criterion 2 and this flight's "Code merged" are checked off; the two artifact edits are committed with flight 03.
- The debrief's recommendation 3 (ownership of a registry record) is logged as [sortie 04](../../../../sorties/04-ownership-on-a-shared-machine/flight.md), at the operator's request, for after this mission.

