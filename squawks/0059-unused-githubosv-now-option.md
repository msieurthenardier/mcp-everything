# Squawk 0059: `GithubOsvOptions.now` is declared and never read

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: 2026-11-23

## Report
The dependency lookup's options carry a `now` clock marked "Reserved". The deadline is an `AbortSignal`, so no clock is read, and nothing reads the option. It is dead surface that invites a caller to think it does something.

## Evidence
- `src/scan/dependencies.ts:232`: `/** Reserved: the deadline is an AbortSignal, so no clock is read. */ now?: () => number;` in `GithubOsvOptions`.
- `grep -n '\bnow\b' src/scan/dependencies.ts` finds only that declaration. No test passes it (`grep -n 'now:' test/scan-dependencies.test.ts` is empty).
- Found at mission 03 flight 03's debrief (Developer interview).

## Corrective Action
Deleted the `now?: () => number;` option and its "Reserved" comment from `GithubOsvOptions` in `src/scan/dependencies.ts`. Re-verified first that nothing reads or passes it: `grep -n '\bnow\b' src/scan/dependencies.ts` found only the declaration, and no `src/` or `test/` caller passes `now:` to `githubOsvLookup` (the one `now:` in `test/scan-run.test.ts` is `runScanners`' own option). No other change.

## Verification
- `npm run typecheck`: clean (no errors).
- `timeout 300 npx vitest run test/scan-dependencies.test.ts`: 1 file, 85 tests passed, unchanged.

## Sign-Off
**Reviewer**: Reviewer crew agent (Sonnet), batch review of 0057–0060
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-23` on branch `squawk/turnaround-2026-11-23`

## Disposition
**Deferred**: logged at mission 03 flight 03's debrief. Clear in the squawk turnaround before flight 4, with 0057, 0058 and 0060.
