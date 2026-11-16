# Squawk 0029: Two reconciliation tests have assertions that cannot fail or fail too loosely

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
Two of the cases flight 02 added for the startup reconciliation assert less than their names say. Found by the Developer in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md), after the flight's Reviewer said it had not read the file closely. Nothing is broken in the product; the tests would not notice if it were.

- "writes nothing when the record was replaced during the detach": the registry file's mtime is read **after** the reconciliation and then compared with itself, so the check that nothing was written cannot fail. Capture the mtime inside the `onSetNetwork` hook, right after the second registry's write, as the next case ("does not rewrite the file when the record changed during the detach") already does; or drop the dead lines if that case makes this one redundant.
- "changes nothing and logs once when Docker does not answer, and reconciles at a later start": `expect(log[0]).toContain("2")` passes on any line with a 2 in it. Assert on the count as the message words it.

Test file only. To show each assertion now bites, break the behavior it names once and watch the case fail.

## Evidence
- `test/installer.test.ts:825` — the case; `:832 — "const written = mtime();"` followed by `expect(other().refresh()).toBe(true); expect(mtime()).toBe(written);`.
- `test/installer.test.ts:768 — 'expect(log[0]).toContain("2");'`. The line it reads is built at `src/install/installer.ts:344 — "${stale.length} interrupted install(s) not reconciled, Docker is not reachable: …"`.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
