# Squawk 0056: Two statements share one line in `test/docker-bypass.test.ts`

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: 2026-11-23

## Report
Leg 14 of mission 03 flight 02 added `whileStopped` to an expected-callers list. The edit left two `expect` statements on one line, which hides the second when the file is read or diffed.

## Evidence
`test/docker-bypass.test.ts:282`: `expect(callers("this.startId")).toEqual([… "whileStopped"]);    expect(callers("this.execOnce")).toEqual(["exec"]);` (flight 02's leg 14 review, non-blocking nit).

## Corrective Action
Put the second `expect` on its own line, with the file's indentation. No assertion changes.

## Verification
`npx vitest run test/docker-bypass.test.ts` passes with the same count (8 tests); the line holds one statement.

## Sign-Off
**Reviewer**: Reviewer crew agent (Sonnet), flight review of mission 03 flight 04 (leg 2 `cleanups`)
**Verdict**: confirmed
**Commit**: `flight/04: groundwork and old sandboxes` on branch `flight/04-groundwork-and-old-sandboxes`

## Disposition
Open: from flight 02's debrief, at the operator's choice. Next turnaround; batch with 0054 and 0055.
