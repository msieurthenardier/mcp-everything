# Squawk 0004: Nothing beside the watchdog script says its real tests are opt-in

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

## Report
The fork guard in the sandbox watchdog is exercised only by two fork-pressure integration cases that are skipped unless `MCPE_PRESSURE_TESTS=1` is set. The comment above the script explains the guard but does not say those cases exist or that they must be run when the script changes. A maintainer editing the script sees only a unit test that checks two strings are present. The guidance lives in the README's Development section and a comment in the test file. Raised in the sortie 02 debrief (Recommendation 1) by both the Developer and the Architect.

This squawk is the comment only: say that changing the script, or the images sandboxes run on, calls for `npm run test:docker:pressure`. No change to the script.

## Evidence
- `src/sandbox/docker.ts` — comment above `const WATCHDOG_SCRIPT`, ending "…and the first failure is announced once on stderr."; no mention of `test:docker:pressure` or `MCPE_PRESSURE_TESTS`
- `test/integration/docker.test.ts` — `const pressureEnabled = enabled && process.env.MCPE_PRESSURE_TESTS === "1"` and `describe.skipIf(!pressureEnabled)`
- `test/docker.test.ts` — "runs the watchdog entrypoint by default" asserts `toContain("until command eval")` and the warning text, nothing behavioral
- `package.json` — `"test:docker:pressure"`

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)* Expected: the comment names the command and when to run it; `npm test` and `npm run typecheck` unchanged.

## Sign-Off
*(written at completion)*
**Reviewer**:
**Verdict**:
**Commit**:
