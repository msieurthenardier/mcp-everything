# Squawk 0051: Order of taking a failed install offline and recording it is untested

**Status**: deferred
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-22
**Completed**: —

## Report
In `Installer.settleFailure`'s branch for a failure after a sandbox was created, the sandbox is taken offline and then the record is written. Swapping those two calls is caught by no test. If the order regressed, a failed install could be recorded on disk with `network: true` while its sandbox is offline, or written before the offline step updates the record. Found by trial 1b of mission 03, flight 01, leg 1 (`split-install`), which was not allowed to edit tests.

## Evidence
- `src/install/installer.ts:settleFailure`: `await this.takeOffline(record, "failed", at.sandbox);` followed by `this.registry.put(record)`.
- Trial 1b (flight log, Leg 01 entry): with the two swapped, `npx vitest run test/installer.test.ts` passed all 128 tests. `registry.put` stores the object by reference, so in-memory assertions see the later change either way. The on-disk checks of this path read only `status` and `container`.
- The same swap in the failed-recipe block (now `finishInstall`, `await this.takeOffline(record, "failed", sandbox);`) **is** caught, by the on-disk `network` check in `test/installer.test.ts`.

## Corrective Action
*(written at completion)*

## Verification
Add a unit case in `test/installer.test.ts` that makes a failure reach `settleFailure`'s sandbox-created branch, then reads the record through a fresh `Registry` on the same data directory and asserts `network` is `false`. Confirm the case fails with the two calls swapped.

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: found mid-flight, outside the flight's charter (leg 1 forbade test edits) — revisit at mission 03 flight 01's debrief or the next squawk turnaround, whichever comes first.
