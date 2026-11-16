# Squawk 0030: The could-not-detach warning calls an interrupted install a failed one

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
`Installer.takeOffline` has two callers since flight 02: the failure exits of `install`, and `reconcileStale`, which marks an install interrupted by a dead process as failed at startup. When the detach fails, both get the same warning: "The sandbox could not be taken off the network after the failed install (…)". For a reconciled record the install did not fail, it was interrupted, and the record's `error` on the same screen says so. Raised by the Architect in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md).

Make the warning true for both callers: pass the occasion in, or word it so it fits either. One helper stays; only the text changes. The unit cases that assert the substring `set_project_network` keep passing; the one for a reconciled record should assert the new wording.

## Evidence
- `src/install/installer.ts:399` — the warning text, inside `takeOffline`.
- `src/install/installer.ts`, `reconcileStale` — `await this.takeOffline(copy);`, then `error: `Install was interrupted: it started at ${installedAt} and never finished. …``.
- Read, not run: the two texts appear together in `project_info` for a reconciled record whose detach failed.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
