# Squawk 0054: A failed `docker stop` in `whileStopped` is not pinned by a test

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
Under a non-runc runtime, a running sandbox's network is changed by stopping it, making the change, then starting it (`Docker.whileStopped`, mission 03 flight 02 leg 14). If the stop fails, and the sandbox is not simply gone, the method throws before changing anything. That is correct, but no test pins it. In leg 14's review, replacing that throw with `if (false)` still left all 925 tests passing (mutation M2, the only one of nine not caught).

## Evidence
- `src/sandbox/docker.ts:whileStopped`: `if (stopped.code !== 0 && !this.isNotThere(stopped)) { throw new Error(\`Failed to stop sandbox … to change its network: …\`) }`.
- Flight 02 flight log, leg 14 review: "Not caught (M2, non-blocking)".

## Corrective Action
*(written at completion)* Add a unit case in `test/docker.test.ts`: the fake's `docker stop` fails with a non-"not there" error under a non-runc runtime. Assert that `setNetwork(…, "contained")` rejects with the stop message, and that no `network connect`, `disconnect` or `start` follows.

## Verification
The new case passes. Re-applying M2 (the throw replaced by a no-op) makes it fail.

## Sign-Off
*(written at completion)*

## Disposition
Open: from flight 02's debrief, at the operator's choice. Next turnaround.
