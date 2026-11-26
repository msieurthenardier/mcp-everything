# Leg: build-stage-scanners

**Status**: completed
**Flight**: [Checking What a Build Installed](../flight.md)

## Objective
A scanner the operator marks `"stage": "build"` checks what a build installed, after a successful build and before discovery runs anything.
- Under `block`, findings at or above the threshold leave the project `failed`, offline and without tools, and it stays blocked until it is reinstalled.
- Under `warn`, the findings are stored and the install goes on.

This leg is the enforcement. Leg 3 (`build-stage-reporting`) is how the agent and the operator are told.

## Context
- **Flight DD4–DD8 and DD10 are the spec for this leg.** Read them in `flight.md`. DD7's rendering and DD9's docs are leg 3's.
- **Split at design (2026-11-25).** The leg design review found the original leg 2 too large for one pass. It was split along enforcement and reporting. Both legs are reviewed and committed together at the end of the flight, so a block never exists without the hold of DD10.
- **Leg 1** (`output-on-the-volume`) put the build output at `/workspace/.mcpe` (`OUTPUT_DIR`), behind an `/opt/mcpe` symlink. See its flight-log entry.
- **What the review confirmed in the code:**
  - In `finishInstall`, after the failed-build branch, everything this leg needs is in scope: `record` (with `record.scan`, set by `installChecked`), `sandbox`, `refused`, `state` and `log`. A block that returns, as the failed-build branch does, never reaches `settleFailure`.
  - `callTool` (`src/server.ts`) is the one catch that turns a thrown `Error` into an error result. `discover_tools`, `connect_mcp_server` and `disconnect_mcp_server` call the installer without catching, so an installer throw becomes an error result with no server change.
  - `discover(` is called only from `finishInstall`, `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp`.
  - `describe(installed, true)` already prints `error:` and "checks at install:".
- **Reachability of the blocked state** (flight design review 2):
  - `call_project_tool`, `listTools` and `find_project_tools` require `ready`;
  - startup reconciliation touches only `installing`;
  - a `failed` record is replaced by the next install.
- **Freshness of `record.scan.build`.** It is a snapshot taken at install. Its source of truth is the volume when checked, and its one rebuild trigger is a reinstall, which replaces the record. Its staleness is unbounded by design.

## Inputs
- Leg 1 landed, uncommitted, on `flight/05-checking-what-a-build-installed`.
- **`src/scan/scanners-file.ts`:** `KEYS` includes `"stage"`; its value check refuses anything but `"source"`.
- **`src/scan/run.ts`:** `runScanners(docker, volume, scanners, { totalTimeoutSec, dataDir, … })` over `ScanDocker.runScanner`.
- **`src/sandbox/docker.ts`:** `runScanner(volume, spec, opts)` requires a `staging` volume, `workdir: "/scan/repo"`.
- **`src/install/installer.ts`:** `checkClone` passes `this.cfg.scan.scanners`. `install` and `installChecked` both have `before` from `openInstall`. `finishInstall` has neither `before` nor `params.reinstall` in a usable form (`state.current` is already `new`).
- **`test/installer.test.ts`:** `FakeDocker.runScanner` (about line 175) is typed `Promise<never>` and always throws (`runScannerError`, or "no scanner expected"). `FakeDocker.exec` returns `code: 0` by default, so a build "succeeds" with no scripting.

## Outputs
- **`src/scan/types.ts`:**
  - `ScannerSpec.stage?: "source" | "build"`;
  - `ScanReport.build?: { checks: CheckOutcome[]; decision: ScanDecision; at: string }`;
  - a guard that reads a stored `build` safely.
- **`src/scan/scanners-file.ts`:** `stage` parsed.
- **`src/sandbox/docker.ts`:** `runScanner` by stage.
- **`src/install/installer.ts`:**
  - one helper that selects a stage's scanners, used by `checkClone` and the build stage;
  - the build stage and its block path in `finishInstall`;
  - `assertNotBlocked`, and its four calls.
- **`src/server.ts`:**
  - `refresh_mcp`'s `failed` gate message for a blocked project;
  - the advice in the `installed.status !== "ready"` branch, for a blocked project.
- **Tests:**
  - unit: `test/scan-scanners-file.test.ts`, `test/docker.test.ts`, `test/docker-bypass.test.ts`, `test/installer.test.ts` (with its `FakeDocker` extended), `test/server.test.ts`;
  - Docker suite: one new `describe` in `test/integration/docker.test.ts`.

## Acceptance Criteria

**Contract**
- [ ] **Parsing `stage`.**
  - `parseScannersFile` accepts `"stage": "build"` and `"stage": "source"`, and returns `stage` on the spec only when given.
  - Any other value is refused with a `ConfigError`, `"stage" must be "source" or "build"`.
  - `test/scan-scanners-file.test.ts` pins the `"built"` refusal (about line 79, `/"stage"/`), which still matches, and gains `"build"` accepted.
- [ ] **One helper selects a stage's scanners**, absent meaning source, such as `scannersFor(stage)`.
  - `checkClone` uses it with `"source"`, so `check_project` and the check before the build never run a build-stage scanner.
  - The build stage uses it with `"build"`.
  - A unit test with one scanner of each stage shows each stage runs only its own, from the `runScanner` calls the fake records.
- [ ] **`runScanner` follows `spec.stage`.**
  - `"build"`: `requireVolumes([{ name, role: "none" }])` and working directory `/scan`.
  - Otherwise, as today: `role: "staging"` and `/scan/repo`.
  - Unit tests: a build spec on a staging volume, and a source spec on a sandbox volume, are each refused before any container is created; a `before`, another's or not-ours volume is refused at either stage.
  - The gate tables in `test/docker.test.ts` gain a build-stage row with `role: "none"`. That means the `runScanner` row about line 821, and the uses about 1756–1811, 2056 and 5285: check each.
  - The `runScanner` row in `test/docker-bypass.test.ts` (about line 95) describes both stages.

**The stage**
- [ ] **When the stage runs.** In `finishInstall`, right after the `if (res.code !== 0) { … return record; }` branch and before any `setNetwork` or discovery:
  - if `this.cfg.scan.mode !== "off"`, `record.scan` is set, and the helper returns at least one build scanner, the stage runs those scanners;
  - it calls `runScanners(this.docker, volume, buildScanners, { totalTimeoutSec: this.cfg.scan.timeoutSec, dataDir: this.cfg.dataDir })` over the record's own volume;
  - it logs "Running the scanners after the build…";
  - it stores `record.scan.build = { checks, decision: decide(this.cfg.scan.mode, this.cfg.scan.blockAt, checks), at: new Date().toISOString() }`.

  A unit test pins the order from the fake's trace: the stage's `runScanner` comes after the build exec and the containment refusal read, and before the first `setNetwork`.
- [ ] **When it does not run.** `record.scan.build` is absent, and `runScanner` is never called with a build spec, in each of these cases (each unit-tested):
  - scanning is off;
  - no scanner has `stage: "build"`;
  - `record.scan` is unset (`install` called directly);
  - after a failed build.
- [ ] **Under `block`, with a finding at or above the threshold** (a unit test for each stated outcome):
  - no `setNetwork` to `open` or contained-run and no discovery exec;
  - the sandbox is taken offline as a failed build's is;
  - the record is `failed`, `putKeeping(record, ["hosts"])` is written, and the record is returned;
  - `record.error` says the check after the build blocked the install, and quotes `decision.reason`;
  - under containment, `refusalWarnings(refused, MAX_REFUSAL_WARNINGS)` are in `record.warnings`;
  - the outcome is `installed` with a `failed` record, as for a failed build.
- [ ] **The "previous version was replaced" sentence.** When the record being replaced was `ready` (`before?.status === "ready"`), `record.error` adds that the previous version was replaced before the build and is not restored. When it was `failed`, or there was none, the sentence is absent.
  - `finishInstall` is given this as a boolean by both callers (`install` and `installChecked`).
  - Unit-tested: a first install, a reinstall over a `ready` record, and a reinstall over a `failed` one (two blocks in a row).
- [ ] **Under `warn`, with findings:** the install goes on to `ready` with tools, and `record.scan.build` holds the findings and a `build` verdict. Unit-tested.
- [ ] **A failed or timed-out build-stage scanner** is `failed` in `record.scan.build.checks`, does not block, and the install goes on. Unit-tested.
- [ ] **A throw out of the stage**, a refusal or an unusable volume from `runScanners`, reaches `settleFailure` as any `finishInstall` throw does. The record is then `failed`, with no `scan.build`, so it is not held.
  - This is accepted because it cannot happen for the install's own volume.
  - The code comment at the stage says so, and the Developer records it in the flight log.

**Blocked stays blocked (DD10)**
- [ ] **A guard for stored values.** For example, `buildReport(scan)` returns `scan.build` only when it is an object whose `checks` is an array and whose `decision.verdict` is `"build"` or `"block"`, and otherwise `undefined`. It lives where `src/server.ts` (leg 3) can import it too.
- [ ] **`assertNotBlocked(project)`** throws when the guard's result has `decision.verdict === "block"`. The message:
  - names the project;
  - says it was blocked by the check after the build;
  - says it can be reinstalled (`install_project` with `reinstall: true`) or the operator can change the policy.
- [ ] **Where it is called:** first thing in `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp`, before any Docker call. Installer unit tests show for each that a blocked record throws, issues no exec, and stays `failed`. A malformed stored `build` (for example, `{ decision: "block" }`) does not throw.
- [ ] **Through the server:**
  - `discover_tools` on a blocked project returns the message as an error, and the status stays `failed` (a `test/server.test.ts` case);
  - `refresh_mcp`'s own `failed` gate says the same for a blocked project. For an ordinary failed project it keeps "Repair the build and run discover_tools…", and the existing test at about `test/server.test.ts:1021` still passes, gaining a blocked row;
  - the advice after a failed install, the `installed.status !== "ready"` branch, says for a blocked project: "Blocked after the build; reinstall, or ask the operator to change the policy." For any other failure it is unchanged.
- [ ] **Allowed on purpose:** `set_project_network` and `sandbox_exec` on a blocked project. Neither runs the project's programs through discovery. No code change; the Developer records it in the flight log.

**Test double**
- [ ] **`FakeDocker.runScanner` in `test/installer.test.ts` can return results.** For example, `scannerResults: Map<string, OneShotResult | Error>` keyed by `spec.name`, returning SARIF on stdout. It records each call's volume and spec, so tests assert the build stage got the record's own volume.
  - Its current behavior stays when nothing is scripted: `runScannerError`, or "no scanner expected".
  - Existing tests keep passing unchanged.

**Docker suite**
- [ ] **A new `describe` in `test/integration/docker.test.ts`**, with its own data directory and its own `scanners.json` holding only one scanner:
  - `stage: "build"`, image `ALPINE` (already used and pulled in that file), `entrypoint: "sh"`;
  - its command lists `/scan/.mcpe/bin` and prints one SARIF result at level `error` whose message names the entries.

  It does not reuse the scan-mode cases' `scanners.json`: that file's source-stage scanner would block before the build.
- [ ] **What the case does:**
  1. An app with `MCPE_SCAN=block`, `MCPE_SCAN_BLOCK_AT=error` installs `tomnomnom/gron`. The record is `failed`, `scan.build.decision.verdict` is `"block"`, a build finding's message contains `gron`, it has no tools, the sandbox is `off`, and `discover_tools` returns an error.
  2. Then an app on the same data directory with `MCPE_SCAN=warn` reinstalls it (`install_project` with `reinstall: true`). It is `ready`, has a `gron__gron` tool, and `scan.build` holds the finding.
- [ ] **Teardown** uses the pattern of the scan-mode cases (about lines 1470–1485): uninstall, then `objects()` and `noRoleLeft()`, leaving nothing.

**Checks**
- [ ] `npm run typecheck`, `npm run build`, `npm test` and `npm run test:slow` pass. `npm run test:docker` passes, run by the Flight Director.

## Verification Steps
- **Unit tests:** `npx vitest run test/scan-scanners-file.test.ts test/docker.test.ts test/docker-bypass.test.ts test/installer.test.ts test/server.test.ts`.
- **Everything else:** `npm run typecheck && npm run build && npm test && npm run test:slow`.
- **Docker suite:** run by the Flight Director, with object lists diffed before and after: `npm run test:docker` (timeout 1800 s).

## Implementation Guidance
1. **Types and guard.** In `src/scan/types.ts`, add `ScannerSpec.stage` and `ScanReport.build`. Put the guard there or in `src/scan/policy.ts`.
2. **Parser.** Change the value check, and add `...(stage !== undefined ? { stage } : {})` to the returned object.
3. **`runScanner`.** `const build = spec.stage === "build"`; pick `role` and `workdir` from it; update its comment. `ScanDocker` and `runScanners` are unchanged.
4. **Installer.**
   - The helper.
   - `checkClone`'s filter.
   - A `replaced: boolean` argument to `finishInstall`, from both callers.
   - The stage and its block branch, right after the failed-build branch, ending as that branch does.
   - `assertNotBlocked`, and the four calls.
5. **Server.** Only `refresh_mcp`'s message and the failed-install advice. Everything else the agent is told is leg 3's.
6. **Test double, then tests**, as in the criteria.
7. **Docker case.** Model it on cases (a)–(c) at about lines 1218–1300 (`ALPINE`, `entrypoint: "sh"`, a `command` of `["-c", …]`, writing SARIF), and the scan-mode cases at about lines 1470–1535 (`appOn`, teardown).
8. **Flight log.** Add a leg entry under Leg Progress, including the two records asked for above: the stage's throw path, and what is allowed on purpose.

## Edge Cases
- **A malformed stored `scan.build`:** the guard reads it as absent, so the project is not held. Tested.
- **The budget runs out:** later build scanners are `not-run` and never block, as at the source stage.
- **A build-stage scanner with `network: true` under containment** gets its own `hosts` egress, as today.
- **A block on a reinstall whose old sandbox was left in place:** both `leftInPlaceWarning` and the block error appear. Fine.
- **A path that calls `discover` without going through the four methods:** none exists today, per the review. If one is found, guard it too and note it in the flight log.

## Files Affected
- `src/scan/types.ts`, `src/scan/scanners-file.ts`
- `src/sandbox/docker.ts`
- `src/install/installer.ts`
- `src/server.ts` (two messages)
- `test/scan-scanners-file.test.ts`, `test/docker.test.ts`, `test/docker-bypass.test.ts`, `test/installer.test.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`
- The flight log

## Citation Audit
Checked 2026-11-25 against `e2c1765` plus leg 1's working tree, by the leg design review and the Flight Director.
- **`src/server.ts`:**
  - `callTool`'s catch, about 769–779;
  - the install advice, about 1413–1418;
  - `discover_tools`, about 1655;
  - `refresh_mcp`'s `failed` gate, about 1710;
  - `connect_mcp_server`, about 1693, and `disconnect_mcp_server`, about 1752.
- **`src/install/installer.ts`:**
  - `checkClone`'s `runScanners`, about 303;
  - `install` passing `before`, about 252, and `installChecked`, about 450;
  - `finishInstall`'s failed-build branch, about 586–601;
  - `rediscover` 971, `refreshMcp` 984, `connectMcp` 1008, `disconnectMcp` 1021.
- **`src/sandbox/docker.ts`:** `runScanner`. Leg 1 moved lines; find it by name.
- **Tests:**
  - `test/installer.test.ts`: `FakeDocker.runScanner`, about 175; an `installChecked` that reaches `installed`, about 2553;
  - `test/docker.test.ts`: gate rows, about 821, 1756–1811, 2056 and 5285;
  - `test/docker-bypass.test.ts`: about 95;
  - `test/server.test.ts`: about 1021;
  - `test/integration/docker.test.ts`: about 1218–1300 and 1470–1535.

---

## Post-Completion
Completion steps (status transitions, flight-log update, checking off in the parent flight, and commit) are Flight Control protocol, driven by the execution workflow. Not repeated here.
