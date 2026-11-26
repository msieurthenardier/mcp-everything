# Squawk 0069: The SARIF linear-time test still times its large parse only once

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
"parses 8 MB of empty results in linear time" (`test/scan-sarif.test.ts`) failed once in `npm test` during the 2026-11-25 squawk turnaround, then passed three reruns.
- Squawk 0058 made the test relative: the full 8 MB parse must take under 40× the best of three parses of a document one tenth the size.
- Only the baseline is best-of-3. The full parse is timed once, so one pause during it (garbage collection, a load spike from vitest's parallel workers) still fails the test.
- This is the most likely identity of the "intermittent un-named unit failure" seen in mission 03's flights 3 and 4: each time it was un-named, and each time under load.

## Evidence
- `test/scan-sarif.test.ts`, about lines 243–262: `const t0 = performance.now(); const r = ok(text); const full = performance.now() - t0;`, a single run against `40 * Math.max(smallBest, 5)`.
- Squawk 0058 (completed 2026-11-23): its Corrective Action names the baseline best-of-3 only.
- The 2026-11-25 turnaround's Developer report: one failure in `test/scan-sarif.test.ts` (the 2.8M-element document), not recurring in three reruns.

## Corrective Action
`test/scan-sarif.test.ts`, "parses 8 MB of empty results in linear time": the full parse is now timed as the best of two runs (the result of the last run feeds the assertions). The 40× ceiling is unchanged. The first attempt exposed a second cause: five 8 MB-class parses exceeded vitest's default 5 s test timeout under load ("Test timed out in 5000ms" while `npm test` ran concurrently), so the test now has an explicit 30 s timeout. Test-only.

## Verification
- Alone: the test takes about 3.8 s and passes.
- 15 runs of `npx vitest run test/scan-sarif.test.ts` while `timeout 600 npm test` ran concurrently: with the best-of-two change only, 14 of 15 passed and `npm test` had one failure (timeout, as above); with the 30 s timeout added, 15 of 15 passed and the concurrent `npm test` passed (2961 passed, 72 skipped).
- Not done: the quadratic stand-in (ceiling kept as is, so the ratio check is unchanged).

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged during the squawk turnaround of 2026-11-25; completed in the same turnaround.
