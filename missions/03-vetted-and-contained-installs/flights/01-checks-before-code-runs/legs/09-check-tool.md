# Leg: check-tool

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Add the `check_project` tool — clone and check a repository without building or running anything from it, whether or not installs are scanned — on its own job key, with one report renderer shared with `install_project`'s block wording.

## Context
- Flight DD7 (operator, 2026-11-21: it runs when asked, scanning on or off). Split from the first draft of `agent-view-and-docs` at its design review (2026-11-22); leg 10 (`security-status-and-docs`) does the instructions, the `security:` line and the README.
- Leg 7 provides `checkClone` (the checking stage, touching no record); leg 8 the server's job stages, record-less job lookup and the inline block wording.
- Job keys: every existing lookup builds its key from a repository id (`github:owner/name`, lower-cased). A check's key is `check:<that id>`, which no repository id can equal (an id has no `check:` prefix), so no install lookup, refusal, `ownerLine` or leg 8 lookup can match it. The design review listed every consumer of `jobs` in `src/server.ts` (the install join and creation, `project_info`, `sandbox()`'s refusal, the five `jobs.has` refusals); none enumerates the map.

## Inputs
- Legs 1–8 landed.
- `src/install/installer.ts` — `checkClone`, `installChecked`.
- `src/server.ts` — `META_TOOLS`, the `install_project` handler and job pattern, leg 8's block wording.

## Outputs
- `src/install/installer.ts` — `check(params, log)`.
- `src/server.ts` — `check_project`; `renderReport` (or similar) used by `install_project`'s block wording and `check_project`.
- Tests: `test/installer.test.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`.

## Acceptance Criteria
- [ ] `Installer.check(params, log)` calls `checkClone` and returns `{ kind: "checked"; report }` or `{ kind: "check-failed"; reason }`; the staging volume is always removed; it makes no registry read or write. It runs the built-in check and every configured scanner whatever `cfg.scan.mode` is; the report's decision uses the configured mode (under `off` its reason is "scanning is off").
- [ ] `check_project` in `META_TOOLS`, always listed: `repo` (required), `ref`, `submodules`, `wait_seconds` (as `install_project`'s), `additionalProperties: false`, annotation `openWorldHint: true`; its description says it clones and checks without building or running anything from the repository, and that it works whether or not installs are scanned. Validation as `install_project` (repository parsing with the configured hosts; `validateGitRef`).
- [ ] It runs as a job keyed `check:<repo id lower-cased>`, with progress, `wait_seconds` and the job outliving the call, as installs do; a second call for the same repository joins it. Its `.finally` does not announce a tool-list change (a check changes no tools).
- [ ] Result: the repository, the commit checked, each check through the shared renderer, and what an install would do now: off → "Installs are not scanned at present; the operator turns scanning on with MCPE_SCAN."; `warn` → "An install would build and report these findings."; `block` → "An install would not be blocked by scanning." or "An install would be blocked: <reason>.". A `check-failed` result is an error result with its reason.
- [ ] The shared renderer produces, per check, its name, status, counts, notes and kept findings (`level ruleId location: message`). `install_project`'s block wording uses it; **leg 8's tests pass unchanged** (the renderer reproduces leg 8's content; if a leg 8 assertion pins text the renderer cannot reproduce, stop and report rather than edit the test).

**Tests**
- [ ] Unit: `check()` (staging removed on success and failure; no registry access; runs under `off`); `check_project`'s schema, validation, job key, joining, no tool-list announcement; not joined by `install_project` and the converse; **while a check of an installed repository is in flight, `project_info`, `call_project_tool`, `sandbox_exec` and `uninstall_project` of that project behave as with no job**; the result wording in each mode and for a failure; the renderer gives the same text in both tools for the same report.
- [ ] Integration (**gated before its first run**; suite prefix; a fresh temporary data directory): with scanning off, `check_project` of `tomnomnom/gron` returns a commit, a `build-hooks` check whose notes say `go install` runs nothing from the repository, and "Installs are not scanned at present", and leaves no role-labelled container or volume of that installation (polled) and no registry record.
- [ ] `npx vitest run` passes; typecheck clean; build succeeds; after the gate the Docker suite passes; the operator's containers and volumes are unchanged.

## Verification Steps
- `npx vitest run`; `npm run typecheck`; `npm run build`; gate; `npm run test:docker` saved whole; operator's objects compared with the flight log.
- Trials (exact edits, undone by editing, compared after each undo): (1) key the check's job by the plain repository id (expected: caught by the converse-isolation case); (2) make `check()` return early when scanning is off; (3) announce a tool-list change when a check ends. Report each outcome.

## Edge Cases
- A check and an install of the same repository at once: separate jobs, separate staging volumes.
- A scanners file configured with scanning off: `check_project` runs them; installs do not.

## Files Affected
- `src/install/installer.ts`, `src/server.ts`; `test/installer.test.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
From the first draft's design review (2026-11-22): `this.jobs` is used only in `src/server.ts` — `get` in the install join and `project_info`, `has` in `sandbox()` and five tools, `set`/`delete` in the install handler — each keyed by a repository id lower-cased; nothing enumerates it. Legs 7–8's names are from their artifacts; follow the code.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
