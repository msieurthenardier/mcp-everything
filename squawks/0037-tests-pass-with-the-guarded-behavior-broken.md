# Squawk 0037: Three tests pass with the code they guard broken

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
Found by the Developer at the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md), by changing the source at `df7fa8d` and running the unit suite. Each change below left every test passing.

1. **The volume an uninstall removes.** `Installer.uninstall` changed to pass the container's name as the volume. The shared test double records only the container it was asked to destroy, and the installer test's own double drops the volume before it calls the shared one. Today a record's two names are equal, so nothing breaks; a record whose names differ would lose the wrong volume unnoticed.
2. **The order of checks in `connectMcp`.** `requireSandbox` moved to after `closeProject`, so proxied servers are closed for a project whose sandbox is gone. `refreshMcp` has the same order and is protected, by a server test; `connectMcp` is not.
3. **The file check in the id module's sweep.** `stat.isFile()` removed from `sweepTemps`. A directory with a matching name survives anyway, because removing it fails and the failure is swallowed. Squawk [0035](0035-startup-and-sweep-tests-pass-for-the-wrong-reason.md) records the same weakness in the two older sweeps; this is a third sweep.

Make each fail when its behavior is broken: record the volume in the double and assert it where an uninstall and a reinstall remove a sandbox; add a case for `connectMcp` on a missing sandbox that asserts nothing was closed; assert what the sweep case can observe without relying on a swallowed failure. Tests only; no change under `src/`.

## Evidence
- `test/helpers.ts`, `FakeDocker.destroy` — `override async destroy(container: string): Promise<void> { … this.destroyed.push(container); }`. `test/installer.test.ts`, `ScriptedDocker.destroy` — `return super.destroy(container);`.
- `src/install/installer.ts`, `uninstall` — `await this.docker.destroy(project.container, project.volume);`. Tried with `project.container` twice: the 272 tests of `test/installer.test.ts` and `test/server.test.ts` pass.
- `src/install/installer.ts`, `connectMcp` — `const sandbox = await this.requireSandbox(project);` then `await this.proxy.closeProject(project.container);`. Tried in the other order: all pass. For `refreshMcp` the same change fails `test/server.test.ts`, "stops nothing when the sandbox no longer exists".
- `src/installation.ts`, `sweepTemps` — `if (stat.isFile() && now - stat.mtimeMs > TEMP_MAX_AGE_MS) fs.unlinkSync(file);`. Tried without `stat.isFile() &&`: the 21 tests of `test/installation.test.ts` pass.

## Corrective Action
1. **Volume.** `FakeDocker.destroy` in `test/helpers.ts` now takes the volume and records it in a new `destroyedVolumes` array (in step with `destroyed`; existing callers and assertions are unchanged). `ScriptedDocker.destroy` in `test/installer.test.ts` now passes the volume on to the shared double. Two cases use a record whose container and volume differ (`mcpe-split` / `mcpe-split-data`, `mcpe-0123abcd-widget` / `mcpe-widget-data`): `test/server.test.ts` "uninstall_project removes the volume the record names…" and `test/installer.test.ts` "removes the volume the record names, not the container's name". The reinstall path already asserted the volume through the trace ("treats the two old names as two names"); with the double now forwarding the volume, the shared double sees it too.
2. **connectMcp order.** New server test "connect_mcp_server stops nothing when the sandbox no longer exists", beside the `refreshMcp` one it is modeled on: a running proxied session, the sandbox gone, `connect_mcp_server` errors with "no longer exists" and the proxy still holds its session.
3. **Sweep.** `sweepTemps` is not exported and takes no log, so its failure cannot be read. The new case in `test/installation.test.ts` makes a stale directory with a matching temp name, spies on `fs.unlinkSync` and asserts the directory was never passed to it (and that it survives). The check is on the attempt, not on the swallowed failure. No change under `src/`; a log seam would have been a design change.

## Verification
Commands: `npx vitest run test/installation.test.ts test/server.test.ts test/installer.test.ts` (303 pass), `npm run typecheck` (clean), `npm test` (921 passed, 24 skipped, 21 files plus 1 skipped). Each source break was made by editing `src/`, run, and undone by editing; `git diff --stat src` is empty afterwards.
1. `Installer.uninstall` passing `project.container` as the volume: 2 failures. `test/server.test.ts` "uninstall_project removes the volume…" (expected `['mcpe-split-data']`, got `['mcpe-split']`) and `test/installer.test.ts` "removes the volume the record names…" (destroy args differ).
2. `requireSandbox` after `closeProject` in `connectMcp`: `test/server.test.ts` "connect_mcp_server stops nothing when the sandbox no longer exists" fails (proxy size 0, expected 1). The order change that also moved `launchSpec` failed one more existing test; the one-line swap alone fails only the new case.
3. `stat.isFile() &&` removed from `sweepTemps`: `test/installation.test.ts` "leaves a directory with a stale temporary name alone…" fails (`unlinkSync` was called with the directory); the other 21 pass.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck and the unit suite (921 passed, 24 skipped), confirmed nothing under `src/` changed, and broke the source behind every new or changed test, each undone by editing; every one failed. The Docker suites were not run: nothing here touches the sandbox. For this squawk: an uninstall passing the container's name as the volume failed the two new uninstall cases; `closeProject` before `requireSandbox` in `connectMcp` failed the new case and an existing one; dropping `isFile` from `sweepTemps` failed the new case. The Developer's claim that the reinstall path was already covered was checked and confirmed (`test/installer.test.ts`, the trace assertion `destroy ${OLD} mcpe-widget-data`). Non-blocking, accepted: the new `connect_mcp_server` case sits in the `refresh_mcp` describe block, beside the case it is modeled on.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19` on branch `squawk/turnaround-2026-11-19`, with squawks 0029, 0035 and 0037.
