# Squawk 0036: Releasing the registry lock removes a lock the process no longer holds

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
`Registry.lock()` takes the lock by creating `registry.json.lock` exclusively and returns a release that removes that path, whatever is there. A waiter may take the lock from its holder (when the file is over 10 seconds old, or after the waiter has waited 5 seconds). When the first holder then finishes, its release removes the **second** holder's lock, and a third process can enter while the second is still writing. Seen by the design review of flight 03 (mission 01) and named by the Architect in the [flight 03 debrief](../missions/01-maintenance/flights/03-local-state-and-secret-handoff-tests/flight-debrief.md); that flight's spec had put the lock's timing out of scope.

Make the release remove the lock only if it is still this process's: write a token into the lock file when taking it, and on release remove the file only if it still holds that token.

**Scope gate**: the release only. Whether and when a lock may be taken from a live writer is a design question and belongs to [sortie 04](../sorties/04-ownership-on-a-shared-machine/flight.md). If the fix cannot be made without deciding that, stop and escalate.

## Evidence
- `src/registry.ts`, `Registry.lock` — `fs.closeSync(fs.openSync(lockFile, "wx", 0o600)); return () => fs.rmSync(lockFile, { force: true });`, and further down `if (age > 10_000 || Date.now() > deadline) fs.rmSync(lockFile, { force: true });`.
- Read, not run. A unit case can show it: take the lock through a write that is held open, replace the lock file as a second holder would, let the first release, and find the lock file gone.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
