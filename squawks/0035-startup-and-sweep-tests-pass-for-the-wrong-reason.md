# Squawk 0035: Three startup and sweep tests pass for the wrong reason

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
Three of the cases flight 03 (mission 01) added say more in their names than their assertions can show. Found by the Developer in the [flight 03 debrief](../missions/01-maintenance/flights/03-local-state-and-secret-handoff-tests/flight-debrief.md), reading every added line after two review cycles had not caught them. Nothing is broken in the product; these tests would not notice if it were. Same kind of item as squawk 0029.

- `test/server.test.ts`, "are not waited for by shutdown": `await expect(local.shutdown()).resolves.toBeUndefined()` passes whether or not `shutdown` awaits `startup`, because the reconciliation resolves at once on an empty registry. Make the reconciliation never resolve (a spy on `installer.reconcileStale` returning a pending promise) and assert that `shutdown()` still finishes.
- `test/server.test.ts`, "do not stop each other": the registry sweep is made to throw, but the env-file sweep runs before it, so the env file being gone shows nothing about isolation in that direction. Add the reverse: the env-file sweep fails, and the registry sweep and the reconciliation still run, with the `startup: env file sweep failed: …` line asserted. `sweepEnvFiles` is a module export and cannot be spied on reliably; make it fail from outside (for example `tmp` unreadable) or accept the listing-failure path as the trigger.
- `test/proxy.test.ts` and its twin in `test/registry.test.ts`, "leaves a directory and a symbolic link with a matching name": the directory survives even without the `isFile` check, because `unlink` fails on a directory and that failure is only logged. Assert the log is empty, which pins the skip.

Test files only. For each, break the behavior it names once and watch the case fail.

Added on 2026-11-16, at the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md): the id module added by that flight has a third sweep with the same weakness as the directory case here (its `isFile` check can be removed and every test passes). It is tracked in squawk [0037](0037-tests-pass-with-the-guarded-behavior-broken.md), not here. This squawk's own cases are unchanged; their lines moved.

## Evidence
- `test/server.test.ts` — `it("are not waited for by shutdown", …)`: `local.start(); await expect(local.shutdown()).resolves.toBeUndefined();`.
- `test/server.test.ts` — `it("do not stop each other: a throwing registry sweep is logged and the rest still run", …)`; `src/server.ts`, `App.start`: the env-file sweep is called before the registry temp sweep.
- `test/proxy.test.ts` — `it("leaves a directory and a symbolic link with a matching name, and the link's target", …)`: `sweepEnvFiles(cfg, NOW)` is called with no log callback.

## Corrective Action
Test files only; nothing under `src/` changed.

- `test/server.test.ts`, "are not waited for by shutdown": `installer.reconcileStale` is spied on and returns a promise that stays pending, so `shutdown()` finishing can only mean it did not wait for `startup`. The promise is resolved in a `finally` because the suite's `afterEach` awaits `startup`. The spy is also asserted called once, so the case cannot pass without the reconciliation having started.
- `test/server.test.ts`: a new case beside "do not stop each other: a throwing registry sweep…", for the reverse direction: the env-file sweep fails, and the registry temp sweep (old temp file removed, `startup: removed 1 leftover registry temp file` logged) and the reconciliation (stale record becomes `failed`) still run, with `startup: env file sweep failed: no timeout` asserted. Trigger: `sweepEnvFiles` is a module export and cannot be spied on, and an unreadable or non-directory `tmp` only reaches its own listing-failure path, which logs `env files: could not list …` and returns 0 without throwing, so it never reaches `App.sweep`'s catch. Instead the test redefines `cfg.mcpStartupTimeoutSec` on the App's config object as a throwing getter; `sweepEnvFiles` reads it first, so it throws. This also works as root, unlike an unreadable directory. The existing `logged` helper now keeps the config in a variable for this.
- `test/proxy.test.ts` and `test/registry.test.ts`, "leaves a directory and a symbolic link…": pass a log callback and assert it stays empty. Without the `isFile` check, `unlink` on the directory fails and is only logged, so the log is what pins the skip.


## Verification
Commands: `npx vitest run test/server.test.ts`, `test/proxy.test.ts`, `test/registry.test.ts`; `npm run typecheck` (clean); `npm test` (21 files passed, 1 skipped; 917 tests passed, 24 skipped). Each source break below was made by editing `src/` temporarily and undone by editing; `git diff --stat src` was empty afterwards.

- "are not waited for by shutdown": made `App.shutdown` `await this.startup` after `this.stop()`. The case failed (test timed out at 5000ms, plus the afterEach hook timeout). Before this fix the same break passed.
- "do not stop each other" (reverse): made `App.sweep` rethrow after logging when the env-file sweep fails. The new case failed with `Error: no timeout` out of `start()`.
- "leaves a directory and a symbolic link…" (proxy and registry): removed the `!stat.isFile() ||` check from `sweepEnvFiles` and `Registry.sweepTemps`. Both failed, but on the earlier `toBe(0)` count (1 removed: the symbolic link, whose lstat is not a file), not on the log. To check that the log assertion pins the directory skip on its own, I replaced the check with `stat.isSymbolicLink() ||` (so only the directory is attempted). Both then failed on `expect(log).toEqual([])` with one logged unlink failure, where before this fix both passed.


## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck and the unit suite (921 passed, 24 skipped), confirmed nothing under `src/` changed, and broke the source behind every new or changed test, each undone by editing; every one failed. The Docker suites were not run: nothing here touches the sandbox. For this squawk: `shutdown` awaiting startup timed the shutdown case out; rethrowing the env-file sweep's error failed the new reverse-direction case; a sweep that attempts the directory failed both directory cases on the empty-log assertion. The throwing getter used as the env-file sweep's trigger does not depend on running as root.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19` on branch `squawk/turnaround-2026-11-19`, with squawks 0029, 0035 and 0037.
