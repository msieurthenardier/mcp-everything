# Squawk 0004: Nothing beside the watchdog script says its real tests are opt-in

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
The fork guard in the sandbox watchdog is exercised only by two fork-pressure integration cases that are skipped unless `MCPE_PRESSURE_TESTS=1` is set. The comment above the script explains the guard but does not say those cases exist or that they must be run when the script changes. A maintainer editing the script sees only a unit test that checks two strings are present. The guidance lives in the README's Development section and a comment in the test file. Raised in the sortie 02 debrief (Recommendation 1) by both the Developer and the Architect.

This squawk is the comment only: say that changing the script, or the images sandboxes run on, calls for `npm run test:docker:pressure`. No change to the script.

## Evidence
- `src/sandbox/docker.ts` — comment above `const WATCHDOG_SCRIPT`, ending "…and the first failure is announced once on stderr."; no mention of `test:docker:pressure` or `MCPE_PRESSURE_TESTS`
- `test/integration/docker.test.ts` — `const pressureEnabled = enabled && process.env.MCPE_PRESSURE_TESTS === "1"` and `describe.skipIf(!pressureEnabled)`
- `test/docker.test.ts` — "runs the watchdog entrypoint by default" asserts `toContain("until command eval")` and the warning text, nothing behavioral
- `package.json` — `"test:docker:pressure"`

## Corrective Action
Extended the comment above `WATCHDOG_SCRIPT` in `src/sandbox/docker.ts` with three `//` lines: the script's behavior under a contested process limit is tested only by the fork-pressure cases in `test/integration/docker.test.ts` (skipped by `npm run test:docker`), and `npm run test:docker:pressure` should be run after changing the script or the images. Comment-only; the script is unchanged.

## Verification
`git diff` on `src/sandbox/docker.ts` shows only three added `//` lines above `const WATCHDOG_SCRIPT`. `npm test`: 270 passed, 14 skipped (unchanged). `npm run typecheck`: clean. No Docker tests were run.
Expected: the comment names the command and when to run it; `npm test` and `npm run typecheck` unchanged.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed; the script itself is unchanged (comment lines only)
**Commit**: `squawk: turnaround 2026-11-15` (trailer `Squawks: 0004, 0005, 0006`) on branch `squawk/turnaround-2026-11-15-2`
