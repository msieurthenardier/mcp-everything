# Squawk 0037: Three tests pass with the code they guard broken

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

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
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
