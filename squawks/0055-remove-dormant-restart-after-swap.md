# Squawk 0055: Remove the dormant restart-after-swap fallback

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

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
*(written at completion)* Remove `RESTART_AFTER_SWAP`, `restartAfterSwap`, `restartForSwap` and its call, and their tests. Leave `restartAfterRestore` and `restartSandbox` as they are. Update the flight 02 README or comments only where they name the fallback.

## Verification
- `npm run typecheck` and `npm test` pass (the count drops only by the removed cases).
- `grep -rn "RESTART_AFTER_SWAP\|restartAfterSwap\|restartForSwap" src test` returns nothing.

## Sign-Off
*(written at completion)*

## Disposition
Open: from flight 02's debrief, at the operator's choice. Next turnaround. If gVisor's behavior changes and a swap again shows `EHOSTUNREACH`, the T17/T18 notes in flight 02's log describe how to reinstate it.
