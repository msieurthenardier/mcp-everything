# Leg: gvisor-network-changes

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Make the cases where a sandbox's network changes while it runs work under gVisor, without changing runc behavior:
- a fixed proxy MAC per project network, so a proxy replacement is invisible to the sandbox's neighbor cache;
- containing a running sandbox under a non-runc runtime by stop, attach, start.

Also fix the second run's two smaller failures. After this leg the `gvisor` job is green.

## Context
- **Second full `gvisor` run** (45192885567 on `3872c1a`, 2026-11-23):
  - `contained-linux` (Run C, runc): **31 of 31 passed**.
  - **Run A: 57 passed, 9 failed.**
  - **Run B: 2 passed, 1 failed.**
- **The 7 `EHOSTUNREACH` failures in Run A**, from the sandbox to the proxy's address, are all cases where the network changes **while the sandbox runs**:
  - containing a running sandbox: the two-project isolation case, and `set_project_network(true)` on an offline running sandbox;
  - or replacing its proxy: the replacement case, leg 13's case, the build-phase case's later check, the `network: true` install's run allowlist, local access, `set_project_hosts`.

  Cases where the sandbox starts after its proxy is in place pass. **Diagnosis** (two known gVisor behaviors; the first is from the leg 13 review, the second consistent with these results):
  1. a NIC hot-plugged into a running gVisor sandbox is not seen by its network stack;
  2. after a proxy swap, the sandbox's neighbor (ARP) entry for the proxy's address keeps the old MAC.
- **T17** (Flight Director trial, Docker Desktop, throwaway objects, removed): `docker create --network "name=<net>,ip=<addr>,mac-address=<mac>"`, then `docker network connect bridge`, then `start`, twice in succession, gave **the same IP and the same MAC** on the internal network. `docker create` cannot take both `bridge` and a user network ("cannot attach both user-defined and non-user-defined network-modes"), so `bridge` is connected after create. `docker network connect` has no MAC option.
- **T18** (Flight Director trial, Docker Desktop 29.8.2): a reconnect loses the MAC. A proxy created with `mac-address=M` that is disconnected and then `network connect --ip X`ed comes back with the same IP and a new random MAC (`--driver-opt com.docker.network.endpoint.macaddress=M` does not help). So "its MAC is fixed at create" holds for a create only: the rollback restarts a non-runc sandbox after it restores the old proxy.
- **T14 under gVisor** has its cause from the new diagnostics: `docker start` after a failed start fails with "could not delete stale containerd task object … cannot signal container … in state created". runsc cannot clean up after a failed start.
- **Run B**: `docker events --format '{{.ID}}'` fails ("can't evaluate field ID in type *events.Message"). The field is `.Actor.ID`, or `.ID` only on some versions. A test bug.

## Acceptance Criteria
- [ ] **Proxy MAC.**
  - `proxyMac(networkId)` is a pure function giving a locally administered unicast MAC (`02:` prefix), derived from the network id, the same for the same id (unit cases).
  - Both proxies, one-shot and project, are created with `--network name=<net>,ip=<proxyAddress>,mac-address=<proxyMac>`, then `network connect bridge` (no `--ip` on bridge), then `start`.
  - The restore path in a failed replacement reconnects the old proxy with the same IP. Its MAC is fixed at create.
  - Unit cases cover the create argv and order.
  - `projectProxyAttached` keeps checking the configured address.
- [ ] **Containing a running sandbox under a non-runc runtime.**
  - When the sandbox's `HostConfig.Runtime` is not `runc` or `io.containerd.runc.v2`, `setNetwork(…, "contained")` and the repair re-attach on a **running** sandbox are done as: `docker stop`, attach, `disconnect bridge`, `start`, then `afterStart`.
  - Under runc nothing changes (unit case on both).
  - Proxied MCP servers are closed by the existing network-change path.
- [ ] **A proxy replacement under a non-runc runtime with a running sandbox.** Rely on the fixed MAC first. **If the CI run after this leg still shows `EHOSTUNREACH` after a replacement**, the fallback is a sandbox restart after the swap under a non-runc runtime. It is implemented behind a single, named function, so the Flight Director can switch it on after the CI result without a redesign. It is **off** until CI says otherwise; a unit case covers both states.
- [ ] **T14** under runsc: `skipIf(process.env.MCPE_DOCKER_RUNTIME === "runsc")`, with the reason "runsc cannot clean up a container whose start failed (stale containerd task), so a stopped sandbox whose -net was removed must be recreated". Recorded in the flight log and the README's gVisor limits.
- [ ] **Run B**: the events format is `{{.Actor.ID}}`, checked against `docker events --help` and the Docker 29 API, with a unit-free local check of the format on Docker Desktop.
- [ ] **The follow-up from leg 13's review**: a unit case where the lock is lost after detach and before create, pinning `assertLive`.
- [ ] **README**: under gVisor, containing a running sandbox restarts it.
- [ ] **Local**: `npm run typecheck`, `npm test` and `npm run build`; then the full local Docker suite after the Flight Director's gate, with no new volume.

## Files Affected
- `src/sandbox/docker.ts`, `src/network/containment.ts`, `README.md`.
- `test/docker.test.ts`, `test/containment.test.ts`, `test/integration/docker.test.ts`, `test/integration/gvisor.test.ts`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
