# Squawk 0035: Three startup and sweep tests pass for the wrong reason

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
Three of the cases flight 03 (mission 01) added say more in their names than their assertions can show. Found by the Developer in the [flight 03 debrief](../missions/01-maintenance/flights/03-local-state-and-secret-handoff-tests/flight-debrief.md), reading every added line after two review cycles had not caught them. Nothing is broken in the product; these tests would not notice if it were. Same kind of item as squawk 0029.

- `test/server.test.ts`, "are not waited for by shutdown": `await expect(local.shutdown()).resolves.toBeUndefined()` passes whether or not `shutdown` awaits `startup`, because the reconciliation resolves at once on an empty registry. Make the reconciliation never resolve (a spy on `installer.reconcileStale` returning a pending promise) and assert that `shutdown()` still finishes.
- `test/server.test.ts`, "do not stop each other": the registry sweep is made to throw, but the env-file sweep runs before it, so the env file being gone shows nothing about isolation in that direction. Add the reverse: the env-file sweep fails, and the registry sweep and the reconciliation still run, with the `startup: env file sweep failed: …` line asserted. `sweepEnvFiles` is a module export and cannot be spied on reliably; make it fail from outside (for example `tmp` unreadable) or accept the listing-failure path as the trigger.
- `test/proxy.test.ts` and its twin in `test/registry.test.ts`, "leaves a directory and a symbolic link with a matching name": the directory survives even without the `isFile` check, because `unlink` fails on a directory and that failure is only logged. Assert the log is empty, which pins the skip.

Test files only. For each, break the behavior it names once and watch the case fail.

## Evidence
- `test/server.test.ts` — `it("are not waited for by shutdown", …)`: `local.start(); await expect(local.shutdown()).resolves.toBeUndefined();`.
- `test/server.test.ts` — `it("do not stop each other: a throwing registry sweep is logged and the rest still run", …)`; `src/server.ts`, `App.start`: the env-file sweep is called before the registry temp sweep.
- `test/proxy.test.ts` — `it("leaves a directory and a symbolic link with a matching name, and the link's target", …)`: `sweepEnvFiles(cfg, NOW)` is called with no log callback.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
