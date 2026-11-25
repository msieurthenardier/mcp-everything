# Squawk 0062: The CI floor of passing tests is far below the suite

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-24
**Completed**: —

## Report
CI's "Minimum passed tests" step fails when fewer than 867 tests pass. The suite now passes 3,017 (`npx vitest run`, both projects), so most of the suite could be silently skipped or excluded and CI would still pass. The step's own comment says to "raise the floor as the suite grows".

## Evidence
- `.github/workflows/ci.yml:40`: "867 since 2026-11-17, when 890 passed".
- `.github/workflows/ci.yml:46`: `const floor = 867;`.
- At mission 03 flight 04's debrief (`a5d7ec4`), `npx vitest run` gives 3,017 passed, 71 skipped. CI runs both vitest projects (`default` and `slow`).

## Corrective Action
*(to be filled in on completion)*: raise `floor` to about 2,900, kept somewhat under the passing count as before. Update the comment's date and count.

## Verification
*(to be filled in on completion)*: run `npx vitest run` with the JSON reporter, as CI does, and check that `numPassedTests` is at least the new floor. Confirm on the PR's CI run.

## Sign-Off
*(to be filled in on completion)*

## Disposition
Logged at mission 03 flight 04's debrief. Carry it to the next squawk turnaround.
