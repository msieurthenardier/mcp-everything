# Squawk 0031: Failure advice says the sandbox was kept when no container exists

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
When a build is retried on a second image, the first container is removed before the second is created. If that creation fails, the install ends `failed` with its record kept and **no container**. `install_project` then tells the caller "The sandbox was kept. You can repair the build with sandbox_exec …", and the next `sandbox_exec` answers that the sandbox no longer exists. Seen in leg 1 of flight 02 and left alone as existing behavior; sorted in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md).

The advice is chosen from one fact, whether the record is still in the registry. Make it true in this case: either word it for a kept record whose sandbox may be gone, or choose it from whether the container exists. Text only.

**Scope gate**: if the right fix turns out to be a different status for a kept record with no container, or removing the record, stop and escalate. That is a lifecycle decision and belongs with the design sortie on sandbox ownership.

## Evidence
- `src/install/installer.ts:260 — "if (i > 0) await this.docker.removeContainer(container);"`, then `createContainer`; `sandboxCreated` is already `true` from the first attempt, so the `catch` at `:318 — "if (sandboxCreated) {"` keeps the record.
- `src/server.ts:705 — "const kept = this.registry.get(done.slug) !== undefined;"` and `:707`, the advice.
- Read, not run. A unit case can reach it with the scripted Docker in `test/installer.test.ts` (first attempt fails softly, `createContainer` throws on the second).

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
