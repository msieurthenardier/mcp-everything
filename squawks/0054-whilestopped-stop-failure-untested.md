# Squawk 0054: A failed `docker stop` in `whileStopped` is not pinned by a test

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: 2026-11-23

## Report
Under a non-runc runtime, a running sandbox's network is changed by stopping it, making the change, then starting it (`Docker.whileStopped`, mission 03 flight 02 leg 14). If the stop fails, and the sandbox is not simply gone, the method throws before changing anything. That is correct, but no test pins it. In leg 14's review, replacing that throw with `if (false)` still left all 925 tests passing (mutation M2, the only one of nine not caught).

## Evidence
- `src/sandbox/docker.ts:whileStopped`: `if (stopped.code !== 0 && !this.isNotThere(stopped)) { throw new Error(\`Failed to stop sandbox … to change its network: …\`) }`.
- Flight 02 flight log, leg 14 review: "Not caught (M2, non-blocking)".

## Corrective Action
Added a unit case in `test/docker.test.ts` ("whileStopped: a stop that fails (not 'No such container') throws, and no connect, disconnect or start follows it"). The fake's `docker stop` fails with code 1 and a permission-denied stderr on a running runsc sandbox. Through both `restartSandbox` and `setNetwork(…, "contained")`, it asserts the call rejects with `Failed to stop sandbox … to change its network: <stderr>`, that the only stop, start or network-change command issued is the stop, and that the sandbox is still running. Note: a case "a failed stop changes nothing" already existed (flight 02's commit) and catches M2 too; the new case adds the message, the no-start check and the `restartSandbox` route.

## Verification
The new case passes. Re-applying M2 (the throw replaced by `void 0`) made it fail, along with the older "a failed stop changes nothing". Restored; both pass. Flight 04 leg 2 log has the commands.

## Sign-Off
**Reviewer**: Reviewer crew agent (Sonnet), flight review of mission 03 flight 04 (leg 2 `cleanups`)
**Verdict**: confirmed
**Commit**: `flight/04: groundwork and old sandboxes` on branch `flight/04-groundwork-and-old-sandboxes`

## Disposition
Open: from flight 02's debrief, at the operator's choice. Next turnaround.
