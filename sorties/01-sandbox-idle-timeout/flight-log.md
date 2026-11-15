# Flight Log: Sandbox Idle Timeout

**Flight**: [Sandbox Idle Timeout](flight.md)

## Summary
Landed 2026-11-15. One leg, `idle-watchdog`, implemented, independently reviewed and confirmed on the first review pass. Awaiting debrief.

---

## Leg Progress

### idle-watchdog
**Status**: landed
**Started**: 2026-11-15
**Completed**: 2026-11-15

#### Changes Made
- `src/config.ts`: `Config.sandboxIdleSec` from `MCPE_SANDBOX_IDLE_TIMEOUT` (default 1800, 0 allowed) via a new non-negative `nonNegativeInt`; `int()` untouched.
- `src/sandbox/docker.ts`: `WATCHDOG_SCRIPT` (the flight spec's reference script, `${` escaped as `\${`), exported `watchdogPollSec`, `createContainer` entrypoint `/bin/sh -c <script> watchdog <idle> <poll>` plus label `mcp-everything.idle-timeout=<idle>` (tail stays `sleep infinity` when 0); `exec` split into a retrying wrapper and `execOnce` (own start time); exported pure `isStoppedExecFailure`; `ExecOptions.restart`; `docker()` made `protected`.
- `src/proxy/mcp-proxy.ts`: `kill` passes `restart: false`; `open` factored into a single `attempt` helper plus one relaunch when the handshake fails, `Docker.state` says `stopped` and `ensureRunning` succeeds.
- Tests: `test/helpers.ts` (`FakeDocker.state` via `stateResult`, `ensureCalls`, `docker()` override that throws), new `test/config.test.ts` and `test/docker.test.ts` (ScriptedDocker subclass answering by argv), additions to `test/proxy.test.ts`, new `describe` block in `test/integration/docker.test.ts`.
- `README.md`: settings row and rewritten Limitations bullet.

#### Notes
- Unit: `npm test` 268 passed / 12 skipped (baseline 225 / 6; the 6 extra skips are the new integration cases), default 5 s per-test timeout, no hangs. `npm run typecheck` and `npm run build` exit 0.
- Config, container-creation, retry (each DD4 row, each not-retried case, missing, ensureRunning throwing, own start time, opt-out) and proxy criteria are each covered by a named unit test in the files above; no unit test reaches the docker binary (`FakeDocker.docker()` throws).
- Real Docker: `MCPE_DOCKER_TESTS=1 npx vitest run test/integration` 12 passed / 0 failed (6 existing, which cloned from github.com successfully, plus 6 new idle-timeout cases, about 95 s). New cases were also run alone first (6 passed). Idle timeout 6 s, poll 1 s. "Never stopped" asserted by unchanged `.State.StartedAt`.
- The 6 new cases cover: idle stop with exit code 0 and label; files in `/opt/mcpe/bin` and `/workspace/work` surviving; exec against a stopped sandbox; offline sandbox offline after restart (`hasNetwork` and `/sys/class/net` is `lo`); online sandbox online; `setNetwork(false)` while stopped; a 11 s exec never stopping the sandbox; 6 short execs 3 s apart; proxied MCP server open for 9 s then `closeAll` then stop; timeout 0 (running after 12 s, entrypoint `["sleep"]`, cmd `["infinity"]`).
- Cleanup: `docker ps -a` and `docker volume ls` filtered on `mcpe-it` are empty after the runs; the operator's `mcpe-*` sandboxes were not touched.
- Not verified: behaviour under gVisor (`runsc`), as planned.

---

## Decisions
Runtime decisions not in original plan.

### Relaunch error wording (idle-watchdog leg)
**Context**: the leg allows the final "did not start" error to say the sandbox was restarted.
**Decision**: when the relaunch also fails the message reads `did not start (after restarting the sandbox): ...`; when the restart itself fails or the sandbox is gone, the first attempt's message is thrown with a `(restarting the sandbox failed: ...)` line appended.
**Impact**: none beyond wording; the unchanged `did not start:` text is kept for the no-restart paths.

---

## Deviations
Departures from planned approach.

None in the idle-watchdog leg.

---

## Anomalies
Unexpected issues encountered.

---

## Session Notes

### 2026-11-15 — Planning

**Qualification**: sortie. One outcome (idle sandboxes stop themselves), one decision cluster (timer location, activity definition, default, env var), one flight, no new subsystem. No active missions or other sorties exist.

**Charter agreed** by the operator, including two points raised explicitly: the timeout is baked into each sandbox at creation (so sandboxes created earlier are unaffected until reinstalled), and the default is 30 minutes.

**Premise checks** — run on throwaway containers (not labelled as mcp-everything sandboxes, removed afterwards), Docker 29.8.2, `--init --cap-drop ALL`:

| Premise | Result |
|---------|--------|
| A `sh` watchdog as entrypoint can stop its own container | Confirmed: exits 0, container state `Running=false`, exit code 0 |
| A running `docker exec` is visible to the watchdog | Confirmed: foreign numeric `/proc` entries appear for the life of the exec; a watchdog with an 8 s limit outlived a 12 s exec |
| A short exec between polls is detectable | Confirmed on dash (`buildpack-deps:stable`) and busybox sh (`alpine`): the watchdog's successive `sleep` PIDs differ by exactly 1 when quiet and by 7 after one `docker exec … true` |
| A disconnected network stays disconnected across stop/start | Confirmed: `.NetworkSettings.Networks` empty before and after restart; only `lo` inside the container |
| `docker exec` against a stopped container fails recognizably | Confirmed: exit code 1, stderr `Error response from daemon: container <id> is not running` |

**Baseline**: `npm test` 225 passed, 6 skipped (the opt-in Docker suite); `npm run typecheck` clean.

**Not verified at planning**: behavior under `MCPE_DOCKER_RUNTIME=runsc` (gVisor is not installed here). The README is to say so.

### 2026-11-15 — Design review, cycle 1

**Architect verdict**: approve with changes. The Architect did not run the test suite.

Accepted and folded into the spec:

| Finding | Severity | Resolution |
|---------|----------|------------|
| The retry rule (exit 1 + stderr text) could re-run a command that printed the daemon's message itself, and "provably never started" was unproven | high | DD4 rewritten: retry only if the container is found not running afterwards, the exit code is not 137, and the output matches an observed never-started failure |
| A retry inside `Docker.exec` would restart a stopped sandbox just to kill a dead pid (`McpProxy.kill`) | high | DD4: cleanup paths opt out |
| The watchdog would resolve `sleep` through the project-writable `PATH` | medium | DD2: `/bin/sh` entrypoint and a fixed `PATH` in the script |
| The idle clock and PID capture were unspecified; counting iterations breaks if `sleep` fails | medium | DD2 contract: `/proc/uptime` via `read`, `$!` capture, first poll is baseline; reference script added |
| The race window and its error strings were unverified | medium | Stress-tested (below); DD4 table built from the results |
| No existing seam lets a unit test reach a real `Docker.exec` or `createContainer` | medium | DD7 names the seam as required work |
| Integration tests lacked detail: labelled volumes, `/opt/mcpe` survival, in-container offline check, network-on direction, `sleep 60`/`sleep 300` greps | medium | Added to Technical Approach; network-on direction verified at planning |
| Cache and state contracts not declared | low | "State and Cache Declarations" section added |
| `0` should keep `sleep infinity` rather than reach the script; poll formula unpinned | low | DD3 |

Declined:

| Finding | Why |
|---------|-----|
| Split into three legs (retry, watchdog, README) | The retry has no purpose without the watchdog, there is no human decision or irreversible step between them, a README-only leg is a split by task type, and the flight gets one review and one commit regardless. The ordering concern is kept as an in-leg order. |
| Make the installer's discovery steps stop swallowing exec errors | Pre-existing masking that applies to any daemon failure, not something this flight introduces; with the retry an idle stop mid-install heals itself. Recorded in DD4 as out of scope. |
| Rename to `MCPE_SANDBOX_IDLE_TIMEOUT` to avoid confusion with `MCPE_MCP_IDLE_TIMEOUT` | The name was agreed in the charter. Raised with the operator as a choice at spec approval. |

**Additional premise checks after the review** (throwaway containers, removed afterwards):

| Premise | Result |
|---------|--------|
| The reference script (fixed `PATH`, `/proc/uptime` clock) stops when quiet on busybox `sh` | Confirmed: a 3 s limit with a 1 s poll was stopped, exit 0, within 7 s |
| A network-enabled container is still enabled after restart | Confirmed: `bridge` listed before and after |
| `docker start` on an already-running container | No-op, exit 0 |
| Failure modes of `docker exec` racing a 1 s watchdog, 90 attempts at random offsets | 87 × exit 1, stderr `Error response from daemon: container <id> is not running`; 1 × exit 128, stdout `cannot exec in a stopped state`; 1 × exit 128, stdout `OCI runtime exec failed: exec failed: cannot exec in a stopped container`; 1 × success |

The two exit-128 failures put their message on stdout, not stderr. Only two teardown-window samples were captured; other wordings may exist.

### 2026-11-15 — Design review, cycle 2 (final)

**Architect verdict**: approve with changes. The Architect ran the reference script under dash in a throwaway PID namespace and saw it exit correctly; it did not run the test suite or touch Docker. This was the second of the two permitted review cycles; the changes below were applied without a third pass and the spec goes to the operator as revised.

Accepted and folded into the spec:

| Finding | Severity | Resolution |
|---------|----------|------------|
| The proxy cannot see an exit code or stdout, so its retry is not "equivalent" to `Docker.exec`'s; it also needs a new `Client`, and `FakeDocker` needs a `state` override | high | DD4 states the proxy's weaker rule explicitly (handshake failed and container `stopped`), with the reasoning and the doubled worst-case start-up; DD7 lists the helper change |
| Checking "container is stopped now" fails the loser of two concurrent calls, and the rationale resting on the idle clock was false (a container can be stopped for other reasons) | medium | DD4 rebuilt around a whole-output match plus exit code, with no state check; `ensureRunning` before the retry is a no-op if another call already restarted it |
| A substring match would let a tool whose output quotes the message be re-run | medium | DD4: whole-output, anchored match per row |
| `missing` containers, null exit codes, fresh timing for the second attempt, and the form of the cleanup opt-out were unspecified | medium | DD4 |
| After a long call the watchdog could stop up to one poll short of the timeout | medium | DD2 "never early" rule (threshold is timeout + poll); DD3 window restated; re-verified below |
| Fork failure makes the watchdog spin; `/proc/uptime` includes host suspend | low | DD2 trade-offs |
| Test-plan gaps: explicit `setNetwork(false)`, the seam for the proxied-server case, an isolated config, the long exec standing in for an install | low | DD7 and Technical Approach |
| Label value when disabled; the `docker()`-override seam does not work while it is private | low | DD3; DD7 |
| "A session never outlives its container" holds only for idle stops; "heals itself" overstated; leg rationale contradicted itself | low | Reworded |

Not adopted: a start-up warning for an unparsable `MCPE_IDLE_TIMEOUT` (no other numeric setting warns; out of scope) and a unit test asserting the README row exists.

**Setting renamed by the operator**: after seeing the cycle 1 finding, the operator chose `MCPE_SANDBOX_IDLE_TIMEOUT` over the `MCPE_IDLE_TIMEOUT` agreed in the charter, to keep it distinct from `MCPE_MCP_IDLE_TIMEOUT`. The charter's fourth success criterion and the spec were updated to the new name; earlier entries in this log keep the old name as written.

**Spec approved by the operator** (2026-11-15), status set to `ready`. Confirmed at approval: `0` disables the timeout (kept, though it goes beyond the charter), and no HAT leg. Gate re-check before marking ready: still one decision cluster and one implementation leg.

**Premise checks after cycle 2** (throwaway containers, removed afterwards):

| Premise | Result |
|---------|--------|
| With the never-early threshold, a 6 s limit and 1 s poll stops between 6 and 9 s after a 4 s call ends | Confirmed: 7.2 s on dash, 9.1 s on busybox |
| `docker network disconnect` / `connect` work on a stopped container | Confirmed: both exit 0 and update `.NetworkSettings.Networks` |
| A network disconnected while stopped stays disconnected after start | Confirmed: no networks, only `lo` inside |

### 2026-11-15 — Execution

### Flight Director Notes

- **Phase file**: `.flightops/agent-crews/leg-execution.md` loaded and structurally valid (Crew, Interaction Protocol, Prompts with fenced blocks). Developer and Reviewer both run on Sonnet per the crew file.
- **Start state**: flight was `ready`, no legs started; set to `in-flight`. Branch `sortie/01-sandbox-idle-timeout` created from `main` at `33fa024`. One implementation leg, no HAT leg.
- **Leg 01 `idle-watchdog` designed**: `legs/01-idle-watchdog.md`. Citations checked against the working tree (Citation Audit in the leg).
- **Risk tier: high.** It changes container lifecycle (a sandbox can now be stopped at any moment between calls), changes the behavior of `Docker.exec`, which every tool, install and proxy path goes through, and touches a security-sensitive surface (the sandbox entrypoint and the offline guarantee across restarts). Design review by a Developer before implementation.
- **Leg 01 design review** (Developer, read-only): approve with changes. It did not run the test suite. Findings folded into the leg:
  - *high* — the "stays running" integration criteria could pass even after a wrongful stop, because `Docker.exec` now restarts a stopped sandbox. Those criteria now assert `.State.StartedAt` is unchanged, and the short-exec case is pinned to one exec every 3 s for 15 s so it can only pass through PID-gap detection.
  - *medium* — the watchdog's `${...}` shell expansions would be taken as interpolation inside a JavaScript template literal; escaping guidance and a unit criterion added.
  - *medium* — `FakeDocker` needs to record `ensureRunning` calls as well as override `state`, or the proxy criteria are unobservable; the existing failed-handshake tests in `test/proxy.test.ts`, `test/server.test.ts` and `test/installer.test.ts` depend on the `state` override.
  - *medium* — `McpProxy.open` behavior was undefined when `Docker.state` rejects or the second `ensureRunning` fails; now specified (no second launch, original error kept), and a synchronously throwing connector must still propagate unchanged.
  - *medium/low* — integration mechanics (inspect fields, `mkdir` of both directories, the server spec's shape, hook timeouts), the unit seam (answer by argv, not call order), and verification commands that would have missed untracked files.
  - The review confirmed no existing test pins `createContainer` arguments or exec call counts that this leg changes, and that the leg's citations are accurate.
- **No second design-review pass.** The changes are the reviewer's own recommended fixes: tighter test criteria, mechanics and error-path detail. Nothing about the approach or the flight's design decisions changed, so the cycle-2 condition (substantive changes) is not met. Leg 01 set to `ready`.
- **Spawning the implementing Developer** (Sonnet) with the crew file's Implement prompt.
- **Leg 01 landed** (`[LAND:leg]` from the Developer). Flight Director spot check before review: `npm test` 268 passed / 12 skipped, `npm run typecheck` clean, no `mcpe-it-` containers or volumes left behind, leg status `landed`. Last autonomous leg, so the flight goes to the code review gate.
- **Spawning the Reviewer** (Sonnet) with the crew file's Review prompt, told that the changes are uncommitted and that it must confirm by reading and running rather than trusting the log.
- **Code review gate, cycle 1**: the Reviewer signalled `[HANDOFF:confirmed]` with no blocking issues. It re-ran everything itself: `npm test` 268 passed / 12 skipped, typecheck and build clean, Docker integration suite 12 of 12 passed in 141 s (github.com reachable), nothing with an `mcpe-it-` prefix left behind, and `dash -n` clean on the watchdog script as emitted. Non-blocking: this log's Summary line was stale (fixed). No fix cycle was needed.
- **Not verified by anyone in this flight**: behavior under gVisor (`runsc`); docker "could not exec" wordings beyond the three observed. Busybox `sh` was exercised at planning with the reference script (which the Reviewer confirmed is what the code emits), but not by the integration suite, which runs on `buildpack-deps:stable`.
- **Completion**: leg 01 set to `completed` with its criteria checked off; flight checkpoints and leg checked off in `flight.md`; flight status set to `landed`. The charter's success criteria are left unchecked for the debrief to assess. Project docs: README updated in the leg; nothing in this flight adds commands or workflow that belong in `CLAUDE.md`.
- **Commit scope**: the flight's source, tests, README and `sorties/01-sandbox-idle-timeout/`. The untracked `.flightops/` and `CLAUDE.md` predate the flight and are left for the operator to decide.

### Flight completion — 2026-11-15

**Status**: landed. One of one legs completed; no deviations and no anomalies. One runtime decision (relaunch error wording, see Decisions). New sandboxes stop themselves after `MCPE_SANDBOX_IDLE_TIMEOUT` seconds without activity (default 1800, `0` disables) and are restarted on the next call; sandboxes created before this change are unaffected until reinstalled.
