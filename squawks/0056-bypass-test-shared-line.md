# Squawk 0056: Two statements share one line in `test/docker-bypass.test.ts`

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
Leg 14 of mission 03 flight 02 added `whileStopped` to an expected-callers list. The edit left two `expect` statements on one line, which hides the second when the file is read or diffed.

## Evidence
`test/docker-bypass.test.ts:282`: `expect(callers("this.startId")).toEqual([… "whileStopped"]);    expect(callers("this.execOnce")).toEqual(["exec"]);` (flight 02's leg 14 review, non-blocking nit).

## Corrective Action
*(written at completion)* Put the second `expect` on its own line, with the file's indentation. No assertion changes.

## Verification
`npx vitest run test/docker-bypass.test.ts` passes with the same count; the line holds one statement.

## Sign-Off
*(written at completion)*

## Disposition
Open: from flight 02's debrief, at the operator's choice. Next turnaround; batch with 0054 and 0055.
