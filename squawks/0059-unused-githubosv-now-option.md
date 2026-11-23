# Squawk 0059: `GithubOsvOptions.now` is declared and never read

**Status**: deferred
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
The dependency lookup's options carry a `now` clock marked "Reserved". The deadline is an `AbortSignal`, so no clock is read, and nothing reads the option. It is dead surface that invites a caller to think it does something.

## Evidence
- `src/scan/dependencies.ts:232`: `/** Reserved: the deadline is an AbortSignal, so no clock is read. */ now?: () => number;` in `GithubOsvOptions`.
- `grep -n '\bnow\b' src/scan/dependencies.ts` finds only that declaration. No test passes it (`grep -n 'now:' test/scan-dependencies.test.ts` is empty).
- Found at mission 03 flight 03's debrief (Developer interview).

## Corrective Action
*(written at completion)* Delete the option and its comment.

## Verification
`npm run typecheck` clean, and `npx vitest run test/scan-dependencies.test.ts` passes unchanged.

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: logged at mission 03 flight 03's debrief. Clear in the squawk turnaround before flight 4, with 0057, 0058 and 0060.
