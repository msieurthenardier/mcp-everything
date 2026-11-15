# Squawk 0002: No test pins the lenient parse of MCPE_SANDBOX_IDLE_TIMEOUT

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
`nonNegativeInt` in `src/config.ts` uses `Number.parseInt`, so a value with trailing text or a fraction is accepted by its leading digits (`"45abc"` gives 45, `"1.5"` gives 1). That matches how `int()` treats every other numeric setting and is the intended behavior, but no test records it for the new setting, so a later tightening or loosening would go unnoticed. Raised in the sortie 01 debrief.

## Evidence
- `src/config.ts:nonNegativeInt` — `Number.parseInt(value, 10)` then `Number.isFinite(n) && n >= 0 ? n : fallback`
- `test/config.test.ts` — covers the default, `"45"`, `"0"`, `"-5"`, `"abc"` and `""` only

## Corrective Action
Confirmed `nonNegativeInt` uses `Number.parseInt(value, 10)`. Added an `it.each` case in the `sandboxIdleSec` block of `test/config.test.ts` asserting `"45abc"` yields 45 and `"1.5"` yields 1. No source changes.

## Verification
`npm test`: 270 passed, 12 skipped (was 268). `npm run typecheck`: clean. Expected: new cases in `test/config.test.ts` asserting `"45abc"` yields 45 and `"1.5"` yields 1; `npm test` passes.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-15` on branch `squawk/turnaround-2026-11-15`
