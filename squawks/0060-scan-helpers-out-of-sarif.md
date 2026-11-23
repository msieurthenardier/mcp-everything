# Squawk 0060: Shared scan helpers live in `sarif.ts`

**Status**: deferred
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
Mission 03 flight 03 exported three of `sarif.ts`'s private helpers so the dependency check could reuse them. `tool-text.ts` uses one too. They are general helpers for any check that cleans third-party text, not SARIF parsing, so a reader looking for them would not look in `sarif.ts`.

## Evidence
- `src/scan/sarif.ts:21`, `:26`, `:31`: `export function isObject`, `export function own` and `export function clean`. All three were module-private before `06b42c9` (`git show 84982b9:src/scan/sarif.ts`).
- `src/scan/dependencies.ts:10-19` imports `clean`, `isObject` and `own` (with the limits) from `./sarif.js`. `src/scan/tool-text.ts:7` imports `clean`.
- Found at mission 03 flight 03's debrief (Developer interview).

## Corrective Action
*(written at completion)* Move `isObject`, `own` and `clean` to a new `src/scan/util.ts`, unchanged, and import them from there in `sarif.ts`, `dependencies.ts` and `tool-text.ts`. `emptyCounts`, `MAX_FINDINGS` and the `*_MAX` limits can stay in `sarif.ts` unless moving them is equally mechanical; the bodies do not change.

## Verification
`npm run typecheck` clean; `npx vitest run` gives the same pass and skip counts as before.

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: logged at mission 03 flight 03's debrief. Clear in the squawk turnaround before flight 4, with 0057, 0058 and 0059.
