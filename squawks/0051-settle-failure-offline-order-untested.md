# Squawk 0051: Order of taking a failed install offline and recording it is untested

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-22
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
In `Installer.settleFailure`'s branch for a failure after a sandbox was created, the sandbox is taken offline and then the record is written. Swapping those two calls is caught by no test. If the order regressed, a failed install could be recorded on disk with `network: true` while its sandbox is offline, or written before the offline step updates the record. Found by trial 1b of mission 03, flight 01, leg 1 (`split-install`), which was not allowed to edit tests.

## Evidence
- `src/install/installer.ts:settleFailure`: `await this.takeOffline(record, "failed", at.sandbox);` followed by `this.registry.put(record)`.
- Trial 1b (flight log, Leg 01 entry): with the two swapped, `npx vitest run test/installer.test.ts` passed all 128 tests. `registry.put` stores the object by reference, so in-memory assertions see the later change either way. The on-disk checks of this path read only `status` and `container`.
- The same swap in the failed-recipe block (now `finishInstall`, `await this.takeOffline(record, "failed", sandbox);`) **is** caught, by the on-disk `network` check in `test/installer.test.ts`.

## Corrective Action
Test only. Added `it("settleFailure takes the sandbox offline before it writes the record: the file says network off")` in `test/installer.test.ts` (in "install failure paths", after the "step fails after the requested policy was applied" case). A `network: true` install whose discovery throws reaches the sandbox-created branch of `settleFailure`, and the test reads `registry.json` with `onDisk` and expects `status: "failed"`, `network: false`. No source change.

## Verification
Add a unit case in `test/installer.test.ts` that makes a failure reach `settleFailure`'s sandbox-created branch, then reads the record through a fresh `Registry` on the same data directory and asserts `network` is `false`. Confirm the case fails with the two calls swapped.

Result: the new case passes. With `takeOffline` and `registry.putKeeping` swapped in `settleFailure`, `npx vitest run test/installer.test.ts` failed the new case (plus three existing cases that also read network after the failure: "takes it off the network when the second attempt's image cannot be pulled", "…when a step fails after the requested policy was applied", "does not let a failing close mask the original error"). The swap was restored and `git diff --stat` matched the pre-swap diff. Full suite: see 0067 (2959 passed, 0 failed).

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
**Deferred**: found mid-flight, outside the flight's charter (leg 1 forbade test edits) — revisit at mission 03 flight 01's debrief or the next squawk turnaround, whichever comes first.
