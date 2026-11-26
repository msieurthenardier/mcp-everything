# Squawk 0062: The CI floor of passing tests is far below the suite

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-24
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
CI's "Minimum passed tests" step fails when fewer than 867 tests pass. The suite now passes 3,017 (`npx vitest run`, both projects), so most of the suite could be silently skipped or excluded and CI would still pass. The step's own comment says to "raise the floor as the suite grows".

## Evidence
- `.github/workflows/ci.yml:40`: "867 since 2026-11-17, when 890 passed".
- `.github/workflows/ci.yml:46`: `const floor = 867;`.
- At mission 03 flight 04's debrief (`a5d7ec4`), `npx vitest run` gives 3,017 passed, 71 skipped. CI runs both vitest projects (`default` and `slow`).

## Corrective Action
`.github/workflows/ci.yml`, "Minimum passed tests" step: `floor` raised from 867 to 2900; the comment now reads "2900 since 2026-11-25, when 3076 passed".

## Verification
`npx vitest run --reporter=json` (both projects): `numPassedTests` 3076, 0 failed, 72 skipped, above the floor of 2900. The YAML parses. To confirm on the PR's CI run.

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at mission 03 flight 04's debrief. Carry it to the next squawk turnaround.
