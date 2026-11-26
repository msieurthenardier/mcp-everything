# Leg: build-stage-reporting

**Status**: completed
**Flight**: [Checking What a Build Installed](../flight.md)

## Objective
The agent and the operator can see what the check after the build did, and what it does not cover. This covers:
- the build stage's report and `security:` line;
- the server's instructions;
- `check_project`'s note;
- `docs/checking.md`.

## Context
- **Flight DD7 (rendering and the `security:` line), DD9 (limits) and DD5 (`check_project`'s note)** are the spec. Also DD10's instruction change at `src/server.ts:39`.
- **Split from leg 2 at design** (2026-11-25). Leg 2 enforces; this leg tells. They are reviewed and committed together.
- **Leg 2 added:**
  - `ScannerSpec.stage`;
  - `ScanReport.build`, and a guard that reads it safely (see its flight-log entry for the name);
  - the helper that selects a stage's scanners.

  Use those, not the raw fields.
- **The report** is a snapshot from install. The docs and the `security:` line say "at install".

## Inputs
- Legs 1 and 2 landed, uncommitted.
- **`src/server.ts`:**
  - `securityParagraph` builds the instructions' "Checks that run on a repository: …" sentence (about lines 49–86, with the scanner list at about 58–60);
  - the instructions' "finish the build yourself with sandbox_exec, then run discover_tools" sentence (about line 39);
  - `renderReport` (about 499), used by `describe(…, true)`'s "checks at install:" (about 1107), the source-stage blocked-install error (about 1404) and `check_project` (about 1465);
  - `securityLine` (about 1030).

## Outputs
- `src/server.ts`: instructions, `renderReport`, `securityLine`, and `check_project`'s line.
- `docs/checking.md`; and the README's summary of that chapter, if it lists what the chapter covers.
- Tests in `test/server.test.ts`.

## Acceptance Criteria
- [ ] **`renderReport`** shows the source checks exactly as today. When the guard returns a `build` report, it adds:
  - a line `after the build:`;
  - the build stage's checks, in the same format;
  - a line with its decision's reason.

  So `describe(…, true)` ("checks at install:") and the blocked-install error show the build stage. The line saying that build-stage scanners are configured is not added inside `renderReport`.
- [ ] **The `security:` line** (`securityLine`):
  - with a `build` report: the build stage's counts after the source's, for example `; after the build: N error, N warning, N note`;
  - scanned, no `build` report, and build-stage scanners configured now: `; build output not checked at install`;
  - otherwise exactly as today.

  The existing exact-string tests (about `test/server.test.ts:2495-2555`) keep passing. New cases cover the three variants, including one scanned under `warn`, then build scanners configured, with no `build`.
- [ ] **`check_project`**, when build-stage scanners are configured, adds one line after the report:
  - it names those scanners;
  - it says they run only after a build, so this check did not run them.

  With none configured, the output is unchanged. Unit-tested both ways.
- [ ] **The instructions' scanner sentence** (`securityParagraph`):
  - names source-stage scanners as today ("the operator's scanners: …");
  - names build-stage scanners separately, saying they run after the build and before tools are published;
  - when none is configured at either stage, reads as today.

  `test/server.test.ts` about 2429–2433 is updated for the configured case, and the other `instructionsOf` assertions (about 2380–2426) still pass.
- [ ] **The instructions' "finish the build yourself with sandbox_exec, then run discover_tools" sentence** adds that a project blocked by the check after the build is reinstalled instead. A test pins it.
- [ ] **`docs/checking.md`:**
  - **"Adding a scanner":** documents `stage`, which is `"source"` (the default) or `"build"`, replacing "`stage` is accepted with the value `"source"` and has no effect today". It says that:
    - each entry runs at one stage, so a scanner wanted at both is listed twice under two names;
    - a build-stage scanner sees the sandbox's volume read-only at `/scan`, with working directory `/scan`;
    - the output is at `/scan/.mcpe`, Rust's and CMake's build trees at `/scan/target` and `/scan/build`, the checkout at `/scan/repo`, and the agent's scratch space at `/scan/work`;
    - build-stage scanners have their own `MCPE_SCAN_TIMEOUT` budget, so an install can spend up to twice that on scanners.
  - **The numbered list of what `install_project` does** gains the step after the build. Under `block`, findings at or above the threshold leave the project `failed` and offline with no tools, and `discover_tools`, `refresh_mcp`, `connect_mcp_server` and `disconnect_mcp_server` refuse it until it is reinstalled. Under `warn` they are reported.
  - **The reinstall paragraph** says the check after the build cannot keep the previous version: it has been replaced by then.
  - **`check_project`'s paragraph** says it runs the source stage's scanners only.
  - **"What none of this protects against"** gains DD9's limits, each in one sentence:
    - a process the build left running;
    - building by hand, then `discover_tools`;
    - Go's module cache and Cargo's registry;
    - an image with its own `/opt/mcpe`;
    - older sandboxes;
    - a block on a reinstall;
    - the build network during the scan;
    - files hidden by mode 000;
    - `npm install -g` and `apt-get` installs outside the volume;
    - absolute symlinks that dangle under `/scan/.mcpe`.
  - **A short upgrade note:**
    - projects installed before this version keep working;
    - their build output was never checked;
    - `project_info` says "build output not checked at install" once build-stage scanners are configured;
    - reinstalling checks it.
- [ ] **The README's chapter summary for `docs/checking.md`**, if it lists what the chapter covers, mentions the check after the build. `test/readme.test.ts` passes.
- [ ] **Checks:** `npm run typecheck`, `npm run build`, `npm test` and `npm run test:slow` pass.

## Verification Steps
- **Server tests:** `npx vitest run test/server.test.ts test/readme.test.ts`.
- **Everything else:** `npm run typecheck && npm run build && npm test && npm run test:slow`.
- **Docs:** read the `docs/checking.md` diff against the criteria above.

## Implementation Guidance
1. **`renderReport`.** Factor the per-check loop into a helper used for both stages.
2. **`securityLine`.** It needs whether build-stage scanners are configured now. Use leg 2's helper over `this.cfg.scan.scanners`.
3. **Instructions.** Keep the sentence's current shape and add a clause. Mind the `mode === "off"` branch that already varies it.
4. **Docs.** Keep the surrounding style: plain sentences, exact names, no marketing.
5. **Flight log.** Add a leg entry under Leg Progress.

## Edge Cases
- **A record with a malformed `build`:** the guard reads it as absent, so it renders nothing and the `security:` line treats it as missing.
- **Scanning off now, with a record scanned earlier:** the `security:` line's existing early return (`mode === "off"` at install) is unchanged. "Configured now" uses the current file, as "scanning is currently" does.

## Files Affected
- `src/server.ts`
- `docs/checking.md`, and possibly `README.md`
- `test/server.test.ts`
- The flight log

## Citation Audit
Checked 2026-11-25 against `e2c1765` plus leg 1's working tree, by the leg design review and the Flight Director:
- `securityParagraph`, about `src/server.ts:49-86`, and line 39;
- `renderReport`, about 499, and its callers at about 1107, 1404 and 1465;
- `securityLine`, about 1030;
- `docs/checking.md:129`, the stage sentence;
- `test/server.test.ts`: about 2380–2433 and 2495–2555.

---

## Post-Completion
Completion steps (status transitions, flight-log update, checking off in the parent flight, and commit) are Flight Control protocol, driven by the execution workflow. Not repeated here.
