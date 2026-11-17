# Squawk 0031: Failure advice says the sandbox was kept when no container exists

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
When a build is retried on a second image, the first container is removed before the second is created. If that creation fails, the install ends `failed` with its record kept and **no container**. `install_project` then tells the caller "The sandbox was kept. You can repair the build with sandbox_exec …", and the next `sandbox_exec` answers that the sandbox no longer exists. Seen in leg 1 of flight 02 and left alone as existing behavior; sorted in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md).

The advice is chosen from one fact, whether the record is still in the registry. Make it true in this case: either word it for a kept record whose sandbox may be gone, or choose it from whether the container exists. Text only.

**Scope gate**: if the right fix turns out to be a different status for a kept record with no container, or removing the record, stop and escalate. That is a lifecycle decision and belongs with the design sortie on sandbox ownership.

## Evidence
- `src/install/installer.ts:260 — "if (i > 0) await this.docker.removeContainer(container);"`, then `createContainer`; `sandboxCreated` is already `true` from the first attempt, so the `catch` at `:318 — "if (sandboxCreated) {"` keeps the record.
- `src/server.ts:705 — "const kept = this.registry.get(done.slug) !== undefined;"` and `:707`, the advice.
- Read, not run. A unit case can reach it with the scripted Docker in `test/installer.test.ts` (first attempt fails softly, `createContainer` throws on the second).

## Corrective Action
Fixed as a side effect of flight 01 of mission 02, [Owned Sandboxes](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight.md), not in a turnaround of its own. That flight's review found the same path from the other side (a failed rebuild saying the sandbox "may still be online" about a container that was gone), and its fix covers this squawk: in the rebuild loop of `Installer.install`, once the first container has been removed, the install holds no container (`sandbox = undefined; sandboxCreated = false;`) until `createContainer` returns the next one. If that creation fails, the failure branch takes the path of an install that never had a container: it removes what is at this install's names and deletes the record. The advice in `install_project` is chosen from whether the record is still in the registry, so it no longer says the sandbox was kept. No text was changed.

This is the "removing the record" outcome that the scope gate above reserved for the design work on sandbox ownership. That work is the flight that made the change, and the choice went through its review. Closed on the operator's word at that flight's debrief.

## Verification
- `test/installer.test.ts`, "keeps no claim about a container that is gone when the second container cannot be created": the first attempt fails softly, `createContainer` throws on the second, the record is deleted, and no warning says the sandbox may still be online. It fails with the two reset lines removed (tried by the fix's Developer, then restored). Its neighbor, "takes the second container offline, through its own reference, when the second build fails", pins the case where the second container does exist.
- The server's side is read, not run: `src/server.ts`, `install_project` — `const kept = this.registry.get(done.slug) !== undefined;`. No test drives the tool through this path.
- Unit suite at `df7fa8d`: 833 passed, 24 skipped.

## Sign-Off
**Reviewer**: the second Reviewer of mission 02's flight 01 (Sonnet, independent of the Developer), which reviewed the difference made by the fix, walked the four paths through the rebuild and confirmed the new case fails without it.
**Verdict**: confirmed
**Commit**: `df7fa8d`, `flight/01: sandboxes are owned by the installation that made them` (pull request #17)
