# Squawk 0032: A throw from discovery during an install leaves proxied sessions open

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
During an install, discovery starts the project's MCP servers through the proxy to list their tools. If something after that throws (discovery itself, or the registry write that follows), the `catch` marks the project `failed` and, since flight 02, takes the sandbox off the network, but it does not stop those servers. Their sessions stay open in the proxy for a project the caller was just told failed, until a reinstall, an uninstall or the idle reaper. Seen in leg 1 of flight 02 and left alone as existing behavior; sorted in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md).

In the `catch`, when a sandbox was created, close the project's sessions (`proxy.closeProject`, best effort, never masking the original error), as `install` already does at its start.

**Scope gate**: closing the sessions is the whole squawk. If the fix needs a decision about what `failed` means for a project that was usable before a reinstall, stop and escalate to the design sortie.

## Evidence
- `src/install/installer.ts:311 — "await this.discover(record, []);"` inside `install`'s `try`; `discoverMcp` calls `this.proxy.listTools(record.container, …)`, which opens a session per server.
- `src/install/installer.ts:318` — the `catch`'s kept-sandbox branch: `takeOffline`, `registry.put`, nothing for the proxy.
- Read, not run. Flight 02's case "a step fails after the policy was applied" already replaces `discover` with one that throws; a variant that opens a session first and asserts `proxy.size` is 0 afterwards would show it.

## Corrective Action
In `install`'s `catch` (`src/install/installer.ts`), the kept-sandbox branch (`sandboxCreated`) now calls `this.proxy.closeProject(container).catch(() => {})` before `takeOffline`, so any sessions discovery opened are closed whichever step threw afterwards. It is best effort: a failing close is swallowed and the original error stays the record's `error`. Only the kept-sandbox branch needed it: the other branch (no sandbox created) never reaches discovery, so no session can exist, and it destroys the container anyway. The non-zero-recipe-exit path returns before discovery, so it has no sessions either. No interface or `failed` semantics changed.

## Verification
Two new tests in `test/installer.test.ts` (flight 02's "sandbox is kept" group): a `discover` replacement that opens a real proxy session via `proxy.listTools` and then throws leaves `proxy.size` 0 and `record.error` the original message; and a `closeProject` that rejects (after the install's own first call) leaves the original error, `network: false` and the failed record. Mutation checks: removing the close call fails the first test; making it unguarded fails the second. Restored afterwards. `npm run typecheck` and full `npm test` pass.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: the kept-sandbox branch was judged the right one (the other cannot have sessions, and the recipe-failure path returns before discovery); removing the close and making it unguarded each failed its case.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
