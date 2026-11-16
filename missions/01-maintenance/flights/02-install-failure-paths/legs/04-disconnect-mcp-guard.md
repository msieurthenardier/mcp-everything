# Leg: disconnect-mcp-guard

**Status**: completed
**Flight**: [Install Failure and Interruption Paths](../flight.md)

## Objective
Make `disconnectMcp` refuse, like its three siblings, when the project's sandbox no longer exists, instead of storing a record with its commands and tools emptied; and raise the hosted check's minimum test count to match the suite this flight leaves.

## Context
- Finding 4d of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md), as restated in the flight's Technical Approach. Its effect was reasoned by the inspector, not observed: **reproduce it in a unit test before changing the code.** If it does not reproduce, record that and make the change for consistency only.
- Flight divert criterion for this leg: the fix must not change what `disconnect_mcp_server` returns in the normal case.
- Last leg of the flight. The flight's Verification section puts the hosted check's test floor in "the leg that adds tests"; it is done once, here, after every leg's tests exist.
- The operator's live mcp-everything instance runs from this checkout's `dist/` and `node_modules/`. Never run `npm install`, `npm ci` or `npm run build` here.

Ground truth, read on 2026-11-16 (symbols, since earlier legs moved the lines):

- `Installer.disconnectMcp` (`src/install/installer.ts`): checks that the named server exists and that its origin is `registered`, then `await this.proxy.closeProject(project.container)`, builds a record without that server, `await this.discover(record, [])`, and ends with `this.registry.put(record); return record;`. It never calls `requireSandbox`.
- Its siblings: `rediscover` begins with `await this.requireSandbox(project)` and ends `return this.finish(record)`; `connectMcp` does the same around its own work; `refreshMcp` validates the variables, then `requireSandbox`, then `closeProject`, and calls `this.finish(record)`.
- `requireSandbox` throws `Sandbox for <slug> no longer exists; reinstall it with install_project(reinstall: true).` when `docker.ensureRunning` returns `false`.
- `finish` sets `status = "ready"`, clears `error` and `errorLog`, stores and returns the record.
- `discover` swallows every exec error (`.catch(() => null)`) and treats a non-zero exit as "not there". Against a container that does not exist every `docker exec` exits non-zero, so discovery keeps no registered command, finds no executable, and sets `record.commands = []`, `record.tools = []` and the "No executables were discovered" warning. `disconnectMcp` then stores that.
- Reachability of a non-`ready` record here: `install` builds a fresh record without `mcpServers` on every install and reinstall, so a record that is `installing` or `failed` has no registered server, and `disconnectMcp` stops at "has no MCP server named" before the lines that change. Ending with `finish()` therefore sets `status: "ready"` on a record that already is.
- The handler (`src/server.ts`, `case "disconnect_mcp_server"`) passes the project and the name through and prints `describe(updated, true)`.
- Tests: `test/server.test.ts` — "disconnect_mcp_server stops the server, forgets its secrets and removes its tools" covers the normal case through the `App`; "stops nothing when the sandbox no longer exists" (under `refresh_mcp`) shows how a sibling's guard is tested: `docker.exists = false`, then assert the error text and `proxy.size`. `FakeDocker.exec` answers exit 0 whatever `exists` says, so a faithful missing sandbox in a test needs both `docker.exists = false` and `docker.next = { code: 1, … }`.
- `.github/workflows/ci.yml`, step "Minimum passed tests": `const floor = 350;` under a comment that begins "396 tests pass as of 2026-11-16".

## Inputs
- Legs 1 to 3 landed, uncommitted, in the working tree.

## Outputs
- `src/install/installer.ts` — `disconnectMcp`.
- `test/server.test.ts` (or `test/installer.test.ts`) — the reproduction and the guard's cases.
- `.github/workflows/ci.yml` — the floor and its comment.

## Acceptance Criteria
- [x] **Reproduction recorded.** A test seeds a `ready` project that has a registered MCP server, at least one command of origin `registered` and at least one tool, makes the sandbox missing (`exists = false` and execs failing), and calls `disconnectMcp`. The flight log says what the code did **before** the change: whether the stored record lost its commands and tools.
- [x] **Sandbox gone**: `disconnectMcp` rejects with the `requireSandbox` message; the stored record is deeply equal to what it was before the call (the server is still registered, commands and tools intact); the project's proxied sessions were not closed.
- [x] **Input errors come first, as today**: an unknown name and a detected (not registered) server are refused with today's messages whether or not the sandbox exists, with no Docker call.
- [x] **Normal case unchanged**: with the sandbox present, the existing test passes unmodified and the text `disconnect_mcp_server` returns is what it was. The method ends with `finish()`.
- [x] `.github/workflows/ci.yml`: the floor is the multiple of 10 that lies between 15 and 24 below the number of unit tests passing after this leg, and the comment states that number and today's date. Nothing else in the workflow changes.
- [x] `npm run typecheck` is clean. `npx vitest run --testTimeout 20000` passes; the counts are recorded.
- [x] The workflow's own count step, run locally the way flight 01 did (the unit-test command from the workflow with `RUNNER_TEMP` pointed at a scratch directory, then the step's `node -e` script), passes with the new floor.

## Verification Steps
- Write the reproduction test first, with the assertions of the "Sandbox gone" criterion, and run it against the unchanged code. Record the failure output's relevant lines (what the stored record held).
- Make the change; the same test passes.
- `npm run typecheck`; `npx vitest run --testTimeout 20000`.
- Extract the workflow's unit-test and count steps and run them with `RUNNER_TEMP` set to a scratch directory outside the repository; the count step prints "<n> tests passed (floor <floor>)".
- `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/ci.yml` parses.
- `git diff --stat`: only the files under Files Affected, on top of the earlier legs'.

## Implementation Guidance
1. Reproduction test (see criterion). Put it beside the existing `disconnect_mcp_server` case in `test/server.test.ts`, using that file's `connect` helper to register the server if that is the simplest way to get a registered server and an open session; add the registered command and a tool to the seeded record.
2. In `disconnectMcp`: keep the two input checks first; then `await this.requireSandbox(project)`; then `closeProject` and the rest; end with `return this.finish(record);`. Three lines change.
3. Add the two input-error cases with the sandbox missing if no existing case already shows the order.
4. The floor: after the full unit run, compute it from the passed count and edit the constant and the comment.
5. Flight log: under Leg Progress, including the reproduction's result in a sentence of its own.

## Edge Cases
- **The sandbox is stopped, not gone** (idle timeout): `ensureRunning` starts it and returns `true`; the disconnect proceeds as today.
- **The reproduction does not show an emptied record**: do not force it. Record what it showed, make the change for consistency, and keep a test for the guard.
- **A record that is not `ready`**: not reachable here (see Context). Do not add a status check.

## Files Affected
- `src/install/installer.ts` — `disconnectMcp`
- `test/server.test.ts` — reproduction and guard cases
- `.github/workflows/ci.yml` — floor and comment

## Out of Scope
- The wording of the two "sandbox gone" messages (`requireSandbox`'s and `App.sandbox`'s differ); how `discover` treats exec errors; a jobs check in the `disconnect_mcp_server` handler. All carried in the maintenance report.

## Citation Audit
Written on 2026-11-16 from a read of the working tree after leg 1, by symbol. Re-checked after leg 3 landed: `Installer.disconnectMcp` still has no `requireSandbox` call and ends with `this.registry.put(record)`; both named cases exist in `test/server.test.ts`; `.github/workflows/ci.yml` still has `const floor = 350;` under the "396 tests pass" comment. No drift.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
