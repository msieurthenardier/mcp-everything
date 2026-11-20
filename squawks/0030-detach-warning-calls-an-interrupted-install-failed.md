# Squawk 0030: The could-not-detach warning calls an interrupted install a failed one

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
`Installer.takeOffline` has two callers since flight 02: the failure exits of `install`, and `reconcileStale`, which marks an install interrupted by a dead process as failed at startup. When the detach fails, both get the same warning: "The sandbox could not be taken off the network after the failed install (…)". For a reconciled record the install did not fail, it was interrupted, and the record's `error` on the same screen says so. Raised by the Architect in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md).

Make the warning true for both callers: pass the occasion in, or word it so it fits either. One helper stays; only the text changes. The unit cases that assert the substring `set_project_network` keep passing; the one for a reconciled record should assert the new wording.

## Evidence
- `src/install/installer.ts:399` — the warning text, inside `takeOffline`.
- `src/install/installer.ts`, `reconcileStale` — `await this.takeOffline(copy);`, then `error: `Install was interrupted: it started at ${installedAt} and never finished. …``.
- Read, not run: the two texts appear together in `project_info` for a reconciled record whose detach failed.

## Corrective Action
`takeOffline` in `src/install/installer.ts` takes the occasion (`"failed"` or `"interrupted"`, a private detail) and words the warning to fit it. `install`'s two failure exits pass `"failed"`; `reconcileStale` passes `"interrupted"`. The text for an install failure is unchanged: "The sandbox could not be taken off the network after the failed install (…)". For a reconciled record it now reads "…after the interrupted install (…)". One helper stays; the rest of the sentence, including `set_project_network`, is the same. No README or other doc quotes the text.

## Verification
- `test/installer.test.ts`: the install-failure case now asserts "could not be taken off the network after the failed install ("; the reconciled-record case asserts "after the interrupted install (" and the absence of "failed install".
- Bite check: temporarily gave `reconcileStale` the `"failed"` wording; the reconciled-record case failed. Reverted by editing.
- `npm run typecheck` and full `npm test` pass.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: ignoring the occasion failed the reconciled-record case; the install-failure text is unchanged.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
