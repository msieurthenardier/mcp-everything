# Squawk 0055: Remove the dormant restart-after-swap fallback

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: 2026-11-23

## Report
Mission 03 flight 02 leg 14 shipped a named fallback, off by default. Under a non-runc runtime it would restart a running contained sandbox after every proxy swap, in case the fixed proxy MAC was not enough. The third full gVisor CI run (45210799694 on `3cba097`) passed every swap case with the switch off, so the fallback is dead code with tests that only pin "the switch is off".

## Evidence
- `src/network/containment.ts`:
  - `export const RESTART_AFTER_SWAP = false` (≈137);
  - `export function restartAfterSwap(…, enabled = RESTART_AFTER_SWAP)` (≈143);
  - `private async restartForSwap` (≈763), called from the replacement path (≈745).
- `test/containment.test.ts`: the imports (≈23–24), the "shipped switch is off" assertion (≈1488), and the `describe("restartAfterSwap, the named fallback (leg 14)")` block (≈1774–1787).
- **Keep:** `Docker.restartSandbox` and `ContainmentDocker.restartSandbox`, which the T18 rollback path `restartAfterRestore` (≈782) still uses.

## Corrective Action
Removed `RESTART_AFTER_SWAP`, `restartAfterSwap`, `restartForSwap` and its call from `src/network/containment.ts`, and the `describe("restartAfterSwap, the named fallback (leg 14)")` block (3 tests) and imports from `test/containment.test.ts`. The "switch is off" test keeps its behavioral assertion (a replacement restarts nothing) under the name "a replacement of a running sandbox's proxy restarts nothing". `restartAfterRestore` and `restartSandbox` stay; the comments of `restartAfterRestore`, `Docker.restartSandbox` and the bypass test's table entry now describe the T18 rollback's restart, not the fallback.

## Verification
- `npm run typecheck` passes; `npx vitest run` gives 2991 passed, 71 skipped (2993 before: -3 removed here, +1 from squawk 0054's new test).
- `grep -rn "RESTART_AFTER_SWAP\|restartAfterSwap\|restartForSwap" src test` returns nothing.

## Sign-Off
**Reviewer**: Reviewer crew agent (Sonnet), flight review of mission 03 flight 04 (leg 2 `cleanups`)
**Verdict**: confirmed
**Commit**: `flight/04: groundwork and old sandboxes` on branch `flight/04-groundwork-and-old-sandboxes`

## Disposition
Open: from flight 02's debrief, at the operator's choice. Next turnaround. If gVisor's behavior changes and a swap again shows `EHOSTUNREACH`, the T17/T18 notes in flight 02's log describe how to reinstate it.
