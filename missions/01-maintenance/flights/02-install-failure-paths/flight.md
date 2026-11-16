# Flight: Install Failure and Interruption Paths

**Status**: ready
**Mission**: [Maintenance](../../mission.md)

## Contributing to Criteria
- [ ] After an install fails or is interrupted, the project's sandbox is off the network, its record says so, and the record does not stay `installing`; shutdown cannot hang; `disconnectMcp` does not store an emptied record when the sandbox is gone; the install failure branches have unit tests (finding 4).

---

## Pre-Flight

### Objective
Make the paths an install takes when it does not succeed as careful as the one it takes when it does. Today a sandbox is created on the network and taken off it only after the build returns. If a step before that throws, or the server process dies mid-install, the sandbox stays online, the record says `failed` or `installing`, and `sandbox_exec` will run in it while the failure advice tells the caller to "enable `set_project_network`", as if it were off. The README's promise is that sandboxes have no network after installation unless enabled. Around that sit three smaller gaps in the same lifecycle: shutdown does nothing about an install in flight and can hang, `disconnectMcp` skips a guard its siblings have, and none of the failure branches has a unit test.

### Open Questions
N/A — maintenance flight. Two points that leg design must settle are stated under Design Decisions with a default.

### Design Decisions

**Network state after a failed install**: off, and recorded as off
- Rationale: it is what the failure advice already implies and what the README promises. A caller who wants to debug online can call `set_project_network`.
- Trade-off: a caller who asked for `network: true` and whose build failed has to turn it back on.

**Reconciling `installing` records at startup**: only records that cannot belong to a live install
- Rationale: several mcp-everything processes can share one data directory (the registry has a lock file and reloads when another process changes the file), so an `installing` record seen at startup may be another process's install in progress. The default is to reconcile only a record older than the longest install allowed (`timeout_seconds` is clamped to 7200), marking it failed and turning its network off, best effort. Leg design may choose a better ownership signal if the record already carries one.
- Trade-off: an interrupted install stays `installing` and online for up to that long after a crash unless a tool call touches it first. `project_info` already reports such a record as "interrupted; reinstall".
- Provenance: the multi-process sharing is read from `src/registry.ts`, not tested by this inspection.

### Prerequisites
- [ ] Flight 01 landed, so this work is checked on its pull request (preferred, not required).

### Pre-Flight Checklist
- N/A — maintenance flights skip Pre-Flight.

---

## In-Flight

### Technical Approach

**Finding 4** merges four reviewer findings on one lifecycle (maintenance report, Category 1, finding 4). All evidence was read, not run, unless marked. One part maps to one leg.

**4a — "No network after installation" fails open** (Security Reviewer; rated low to medium, new).
- Evidence: the container is created on `bridge` with the record at `network: true`; `setNetwork(wantNetwork)` runs only after the recipe exec returns (`src/install/installer.ts`, about line 231, inside `install`, 150-305). If an earlier step throws (a Docker error, the second image attempt's pull, a removal), the `catch` keeps the sandbox and registers it as `failed`, still attached. If the process dies mid-install the status stays `installing` and the sandbox stays online.
- Fix: in the `catch`, when the sandbox was created, turn the network off (best effort, never masking the original error) and record it. At startup, reconcile `installing` records per the design decision above.
- Architect: the reviewer called this squawk-sized; it changes network and registry lifecycle, so it is not.

**4b — failure branches have no unit test** (Inspector; medium, new).
- Evidence: `test/installer.test.ts` calls `install` in two places; the failure-status cases at lines 153-160 are the only coverage. Untested: the rollback when the sandbox was never created (`installer.ts:289-296`: destroy the container, delete the registry entry), the timeout path (277-285), `uninstall` (680). The Docker suite covers the happy path and the rebuild path only.
- Fix: cases with the existing fake Docker for clone failure, image failure, timeout, and registry cleanup, written with 4a so the new network-off behavior is pinned in the same place. One Docker-suite assertion that a failed install leaves zero attached networks, kept within a few seconds; the fork-pressure cases are not involved.

**4c — shutdown** (Inspector; low to medium, new).
- Evidence: `App.shutdown` (`src/server.ts:411-414`) closes proxied servers only. The handler in `src/index.ts:13-23` has no timeout, so a hung `closeAll` means `process.exit` is never reached, and a second signal re-enters it.
- Fix: a bounded shutdown (exit after a short deadline whatever `closeAll` does) and a guard so a second signal does not start a second shutdown. An install in flight is not waited for; 4a's reconciliation is what cleans up after it.

**4d — `disconnectMcp` skips the guard its siblings use** (Inspector; low to medium, new; effect inferred).
- Evidence: `disconnectMcp` (`installer.ts:370-389`) does not call `requireSandbox`, which `rediscover`, `refreshMcp` and `connectMcp` do, and ends with `registry.put` instead of `finish()`. Because discovery swallows exec errors, on a missing sandbox it would store a record with its commands emptied.
- Fix: call `requireSandbox` and end with `finish()`, as the other three do. First reproduce the emptied record in a unit test, since the effect was reasoned and not observed; if it does not reproduce, record that and make the change for consistency only.

Out of scope here: extracting anything from `Installer`, the wording of the two "sandbox gone" messages, and how discovery treats exec errors. They are carried in the report (findings 13 and 14, and known debt).

### Checkpoints
- [ ] A failed install is shown, by unit test and by one Docker assertion, to leave the sandbox off the network.
- [ ] A stale `installing` record is reconciled at startup; a fresh one is left alone.
- [ ] Shutdown exits within its deadline with a hung close, and a second signal is ignored.
- [ ] `disconnectMcp` on a missing sandbox reports the sandbox as gone and leaves the record as it was.

### Adaptation Criteria

**Divert if**:
- Reconciling at startup cannot be made safe for a second live process without a new field in the registry record. That is a schema change and needs the operator.
- Turning the network off in the `catch` can itself leave the record and the container disagreeing in a way the existing `set_project_network` cannot repair.
- 4d's fix changes what `disconnect_mcp_server` returns in the normal case.

**Acceptable variations**:
- A different staleness rule for `installing` records, if stated and tested.
- Folding 4b's cases into the legs that change the behavior they test.
- The shutdown deadline's length.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [ ] `network-off-on-failed-install` - Network off and recorded when an install fails; stale `installing` records reconciled at startup (4a)
- [ ] `install-failure-tests` - Unit cases for the rollback, timeout and uninstall branches; one Docker assertion (4b)
- [ ] `bounded-shutdown` - Shutdown deadline and re-entry guard (4c)
- [ ] `disconnect-mcp-guard` - `requireSandbox` and `finish()` in `disconnectMcp`, with the reproduction first (4d)

---

## Post-Flight

### Completion Checklist
- [ ] All legs completed
- [ ] Code merged
- [ ] Tests passing
- [ ] Documentation updated

### Verification
`npm test` and `npm run typecheck` pass, with new cases for each of 4a to 4d. `npm run test:docker` passes, including the new assertion that a failed install leaves no attached network. By hand, once: start an install with a build that fails, then `docker inspect` the sandbox and confirm it has no network and `project_info` agrees. The README's statement about the network after installation needs no change if the behavior now matches it; if the failure advice text changes, the README's troubleshooting text follows. The hosted check added by flight 01 does not run the Docker suite and will be green without it: run `npm run test:docker` locally before the pull request is marked ready, and record the result in the flight log. In the leg that adds tests, raise the minimum passed-test count in `.github/workflows/ci.yml` to stay close under the new total.
