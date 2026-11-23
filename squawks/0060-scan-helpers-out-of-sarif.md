# Squawk 0060: Shared scan helpers live in `sarif.ts`

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: 2026-11-23

## Report
Mission 03 flight 03 exported three of `sarif.ts`'s private helpers so the dependency check could reuse them. `tool-text.ts` uses one too. They are general helpers for any check that cleans third-party text, not SARIF parsing, so a reader looking for them would not look in `sarif.ts`.

## Evidence
- `src/scan/sarif.ts:21`, `:26`, `:31`: `export function isObject`, `export function own` and `export function clean`. All three were module-private before `06b42c9` (`git show 84982b9:src/scan/sarif.ts`).
- `src/scan/dependencies.ts:10-19` imports `clean`, `isObject` and `own` (with the limits) from `./sarif.js`. `src/scan/tool-text.ts:7` imports `clean`.
- Found at mission 03 flight 03's debrief (Developer interview).

## Corrective Action
Moved `isObject`, `own` and `clean` verbatim (bodies and doc comments unchanged) from `src/scan/sarif.ts` to a new `src/scan/util.ts`, which also takes the `oneLine` import that only `clean` used. `sarif.ts` imports the three from `./util.js` and no longer exports them; `dependencies.ts` and `tool-text.ts` import them from `./util.js`. `emptyCounts`, `MAX_FINDINGS` and the `*_MAX` limits stay in `sarif.ts`. `util.ts` does not import `sarif.ts`, so there is no cycle. No other importer of the three names existed in `src/` or `test/`, and no test lists `src/scan/` files.

## Verification
- `npm run typecheck`: clean.
- `npm run build`: clean.
- `timeout 600 npx vitest run`: 2988 passed, 71 skipped, 0 failed (same as before).

## Sign-Off
**Reviewer**: Reviewer crew agent (Sonnet), batch review of 0057–0060
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-23` on branch `squawk/turnaround-2026-11-23`

## Disposition
**Deferred**: logged at mission 03 flight 03's debrief. Clear in the squawk turnaround before flight 4, with 0057, 0058 and 0059.
