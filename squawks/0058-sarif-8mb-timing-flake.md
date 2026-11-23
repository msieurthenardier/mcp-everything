# Squawk 0058: The 8 MB SARIF parsing test flakes under load

**Status**: deferred
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
`test/scan-sarif.test.ts` asserts that an 8 MB SARIF document of empty results parses in under 3 s, measured by wall clock. Under load (the full unit run's parallel workers, or another session's Docker activity), it occasionally exceeds that and fails. A rerun passes.

## Evidence
- `test/scan-sarif.test.ts:243`, "parses 8 MB of empty results in under 3 s": `expect(performance.now() - t0).toBeLessThan(3000);`.
- It failed once in three full unit runs during mission 03 flight 03's review (2026-11-23).
- An unidentified single failure in the flight's baseline run (35.9 s instead of about 17 s) did not repeat; it was probably this test.

## Corrective Action
*(written at completion)* Keep the test's intent, that parsing is linear and not pathological, without a tight wall-clock bound. Either raise the bound well above the observed worst case, or compare against a small-input baseline measured in the same test (for example, 8 MB taking under 50× the time of 160 KB).

## Verification
Ten consecutive full `npx vitest run` passes with this test green. A deliberately quadratic parser (temporarily) still fails it.

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: found mid-flight in mission 03 flight 03, outside that flight's code. Revisit at the next turnaround.
