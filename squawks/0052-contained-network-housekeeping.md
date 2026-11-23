# Squawk 0052: Contained-network housekeeping at startup

**Status**: deferred
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
Mission 03 flight 02's startup pass (leg 10, `startup-containment`) originally included three cleanups, which its design review moved out as destructive cleanup with its own races:
1. **Orphaned project proxies and networks.** These are `project-proxy` containers and `project-net` networks of this installation whose `mcp-everything.sandbox` names a sandbox that no longer exists, for instance after a crashed uninstall or a rename. The one-shot sweep never takes project-labelled objects, so nothing removes them.
2. **Proxies of stopped sandboxes.** When a sandbox's watchdog stops it for idleness, its project proxy keeps running, about 30–40 MB each, until the next repair or uninstall.
3. **Stale proxy lock files.** These are `registry.json.proxy-<hash>.lock` files of projects that no longer have a record.

4. **Orphan `*.stale-<pid>-<hex>` files** beside the lock files, left only if a process crashes between a stale-lock rename and its cleanup (flight 02's review fix to stale-lock takeover).

None is a containment gap. A leftover proxy binds only its internal-network address and is unreachable from `bridge`. The cost is memory and Docker clutter.

## Evidence
- `src/sandbox/docker.ts`: `sweepCheckLeftovers` requires no project label, by design (DD2), so project proxies and networks are never swept.
- `src/network/containment.ts`: lock files are created under the data directory and are not removed when a project goes.
- Leg 10's design review (flight log, 2026-11-23) has the races to handle:
  - re-inspect under the project's lock;
  - skip installs younger than the floor;
  - remove proxies before the network;
  - match lock-file names exactly and check their age.

## Corrective Action
*(written at completion)*

## Verification

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: moved out of flight 02's leg 10 at its design review to keep the containment pass's scope to containment. Revisit at the next turnaround after mission 03 flight 02 lands, or sooner if the HAT shows proxies piling up.
