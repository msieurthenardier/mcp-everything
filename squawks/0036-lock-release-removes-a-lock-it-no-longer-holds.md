# Squawk 0036: Releasing the registry lock removes a lock the process no longer holds

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
`Registry.lock()` takes the lock by creating `registry.json.lock` exclusively and returns a release that removes that path, whatever is there. A waiter may take the lock from its holder (when the file is over 10 seconds old, or after the waiter has waited 5 seconds). When the first holder then finishes, its release removes the **second** holder's lock, and a third process can enter while the second is still writing. Seen by the design review of flight 03 (mission 01) and named by the Architect in the [flight 03 debrief](../missions/01-maintenance/flights/03-local-state-and-secret-handoff-tests/flight-debrief.md); that flight's spec had put the lock's timing out of scope.

Make the release remove the lock only if it is still this process's: write a token into the lock file when taking it, and on release remove the file only if it still holds that token.

**Scope gate**: the release only. Whether and when a lock may be taken from a live writer is a design question and belongs to [sortie 04](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight.md). If the fix cannot be made without deciding that, stop and escalate.

## Evidence
- `src/registry.ts`, `Registry.lock` — `fs.closeSync(fs.openSync(lockFile, "wx", 0o600)); return () => fs.rmSync(lockFile, { force: true });`, and further down `if (age > 10_000 || Date.now() > deadline) fs.rmSync(lockFile, { force: true });`.
- Read, not run. A unit case can show it: take the lock through a write that is held open, replace the lock file as a second holder would, let the first release, and find the lock file gone.

## Corrective Action
`Registry.lock()` now writes a token (process id plus 16 random bytes from `node:crypto`, hex) into the lock file right after the exclusive create. The release reads the file and removes it only if it holds exactly that token; a file that has gone or holds anything else is left alone and the release does not throw. The exclusive create, the 10-second and 5-second rules, the wait and mode `0o600` are unchanged; the age is read from mtime, and the token is written at creation, so it does not disturb it. The method comment names the limits that remain: a lock can still be taken from a live writer after 5 seconds, so holding it is not proof of exclusion, and between the release's read and its removal another holder could appear. Neither is fixed here (sortie 04).

## Verification
- Four cases added to `test/registry.test.ts` under "releasing the lock". The takeover case (inside `update`'s callback the lock file is removed and recreated with other content; after `update` that content must still be there) was run first against the unchanged `lock()` and failed, as the report said.
- With the fix: `npm run typecheck` clean; `npx vitest run --testTimeout 20000` 515 passed, 18 skipped (511 passed before). The existing stale-lock case and the sweep case that holds a hand-written lock pass unmodified.
- Mutation check: the release's token comparison was made unconditional by hand (the read kept) and `test/registry.test.ts` run; only the takeover case failed (53 passed). The fix's diff was restored and compared identical. The other three new cases (lock gone after put/update/delete, lock removed by someone else, mtime changed) guard behaviors the unconditional release also had, so they do not fail under that mutation; they pin the contract so a later change to the release cannot break it.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff. It tried to break each new test by changing the source (six mutations, each undone by editing) and found none that could not fail, apart from the cases that pin behavior which already held. Docker suite run once on the reviewed tree: 16 passed, 2 skipped, 0 failed.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0034, 0036`) on branch `squawk/turnaround-2026-11-16-2`
