# Sortie: Sandbox Idle Timeout

**Status**: completed

## Charter

### Outcome
A project's sandbox container stops by itself after a period with no activity and comes back transparently on the next tool call.

### Why Now
Every installed project keeps a `sleep infinity` container running forever (the README lists this as a limitation), so containers pile up as projects are installed.

### Success Criteria
- [x] A sandbox with no activity for the configured period ends up stopped, with its volume and installed tools intact.
- [x] The next tool call against a stopped sandbox succeeds without user intervention, and its network setting (offline unless enabled) is unchanged.
- [x] A sandbox is never stopped mid-work: a running tool call, an install, or a live proxied MCP server counts as activity. *(Not met when this flight landed; met for the failure that was found after sortie 02. See the debrief's follow-up.)*
- [x] With no configuration the timeout is 30 minutes; `MCPE_SANDBOX_IDLE_TIMEOUT` (seconds) overrides it, and it is documented in the README table.

### Constraints
- No weakening of sandbox isolation: capabilities, resource limits and network-off-after-install stay as they are.
- Sandbox images still need only `sh`, `git` and coreutils.

---

## Pre-Flight

### Objective
Replace the sandbox container's `sleep infinity` entrypoint with a small in-container watchdog that exits once the sandbox has seen no activity for the idle timeout. The timeout is fixed when the container is created (default 1800 s, from `MCPE_SANDBOX_IDLE_TIMEOUT`). Because `Docker.ensureRunning` already restarts stopped containers before every call, the stop is invisible to callers apart from roughly a second of start-up; the flight also closes the race between that liveness check and the exec that follows it.

### Open Questions
- [x] Where does the timer live — server process or container? → DD1
- [x] What counts as activity, and can very short tool calls be seen? → DD2
- [x] Does a restarted sandbox keep its network setting, in both directions? → DD5 (verified)
- [x] What happens to a call that races the watchdog's exit, and can a retry ever run a command twice? → DD4 (stress-tested)
- [x] What about sandboxes created before this change? → DD6

### Design Decisions

**DD1 — The timer lives in the container**: the container's entrypoint becomes a POSIX `sh` watchdog script (passed with `sh -c`, as `PROBE_SCRIPT` and the proxy's `LAUNCH_SCRIPT` already are); the idle timeout and poll interval are passed to it as arguments at `docker run` time.
- Rationale: the mcp-everything server is a stdio child of the MCP client and is usually not running. A host-side timer would leave every sandbox up whenever the server is not. A self-stopping container needs no host process at all. Agreed with the operator at charter time.
- Trade-off: the timeout is fixed per container at creation. Changing `MCPE_SANDBOX_IDLE_TIMEOUT` affects only sandboxes created afterwards (see DD6).

**DD2 — Activity is "a process was created or is running", observed from inside**: each poll the watchdog treats the sandbox as active if either
1. any process other than PID 1 (`docker-init`), the watchdog itself and its own `sleep` exists (a numeric-entry scan of `/proc` using shell globbing only), or
2. a process was created since the previous poll, detected because the PID of the watchdog's next `sleep` child is not exactly one more than the previous one.

Activity resets the idle clock; the watchdog exits 0 when the clock reaches the timeout.

The contract the script must meet (a reference script that meets it, and was used for the planning checks, is in Technical Approach):
- **Clock**: elapsed time is read from `/proc/uptime` with the `read` builtin, never counted in loop iterations. A `sleep` that fails or returns early therefore cannot make idle time pass faster than real time.
- **PID capture**: `sleep` runs in the background and its PID is taken from `$!`, then waited on.
- **Baseline**: the first poll counts as activity, so a freshly started or restarted sandbox always gets a full timeout.
- **Never early**: the watchdog exits only when the last poll that saw activity is at least timeout + poll interval in the past. The last poll to see a long call can precede the call's end by up to one poll, so the extra poll is what guarantees a full timeout of real quiet.
- **No other forks**: the loop uses shell builtins only apart from its one `sleep` per poll, or it would see its own children as activity and never stop.
- **Fixed lookup**: the entrypoint is `/bin/sh` and the script sets `PATH` to the system directories before looping. The container's own `PATH` puts project-writable directories first (`/opt/mcpe/bin`, the venv, cargo), so an installed `sleep` or `sh` would otherwise be picked up by the watchdog on every poll and every restart. `docker exec` processes are unaffected: they take the container's configured environment, not the entrypoint's.

- Rationale: every tool call, install step and proxied MCP server is a `docker exec` process inside the container's PID namespace, so (1) covers anything still running with no host cooperation and no heartbeat. (2) covers calls shorter than the poll interval, which (1) alone would never see — without it a sandbox used every minute by a 50 ms tool would still stop every 30 minutes. Both need only `sh` and `sleep`.
- Verified at planning on scratch containers (Docker 29.8.2, `--init --cap-drop ALL`), on dash (`buildpack-deps:stable`) and busybox `sh` (`alpine`): quiet polls show a PID delta of exactly 1; one `docker exec … true` between polls shows a delta of 7; a running exec shows as foreign `/proc` entries; the reference script outlived an exec longer than its limit and then exited 0 by itself.
- Trade-off: a process a tool leaves running (deliberately daemonized, or orphaned when the host server is killed outright) keeps its sandbox up indefinitely. That is the conservative failure direction ("never stopped mid-work"), and such processes already escape the per-call `timeout`; the README says so. A process inside the sandbox can also kill the watchdog and so stop its own sandbox early; it only harms itself. PID wrap-around produces a non-1 delta and is harmlessly read as activity. If the watchdog cannot fork its `sleep` at all (the sandbox is at its pids limit) it reads that as activity and spins until it can; the leg may add a guard. `/proc/uptime` counts time the host spent suspended, so after a long suspend idle sandboxes stop at their next poll and restart on the next call.
- Not verified: behavior under `MCPE_DOCKER_RUNTIME=runsc` (gVisor is not installed in the planning environment). The README states idle stopping is unverified there; see Adaptation Criteria.

**DD3 — Configuration**: new `Config.sandboxIdleSec`, read from `MCPE_SANDBOX_IDLE_TIMEOUT` in seconds, default `1800`. `0` disables the timeout: `createContainer` then keeps today's `sleep infinity` entrypoint rather than passing 0 to the script. Invalid or negative values fall back to the default, with the same lenient integer parse the other numeric settings use.
- Rationale: 30 minutes sits well above the 10-minute proxied-MCP idle timeout and a restart costs about a second, so the default never thrashes. `0`-to-disable keeps today's behavior available to anyone who wants always-warm sandboxes.
- Trade-off: the existing `int()` helper in `src/config.ts` treats non-positive values as "use the fallback", so this setting needs a non-negative variant rather than `int()` as is.
- Poll interval: computed host-side as `min(15, max(1, floor(idleSec / 4)))` and passed to the script. With the never-early rule in DD2, a sandbox stops between timeout and timeout + 2 × poll + 1 s (whole-second clock) after its last activity ends: up to about 31 s late at the default, and between 6 and 9 s for a 6 s test timeout. Verified at planning: 7.2 s on dash and 9.1 s on busybox after a 4 s call against a 6 s limit.
- The timeout is also recorded as a container label, `mcp-everything.idle-timeout=<seconds>` (`0` when disabled), so it can be read back with `docker inspect`.

**DD4 — A call that never started is retried once**: `Docker.exec` runs the command a second time only when the first attempt's result is, in its entirety, one of docker's own "could not exec" failures observed at planning:

| Situation | Exit code | stdout (trimmed) | stderr (trimmed) |
|-----------|-----------|------------------|------------------|
| Exec against an already-stopped container | 1 | empty | exactly `Error response from daemon: container <id or name> is not running` |
| Exec that lands while the container is tearing down | 128 | exactly `cannot exec in a stopped state` | empty |
| Same, other wording | 128 | exactly `OCI runtime exec failed: exec failed: cannot exec in a stopped container` | empty |

On a match it calls `ensureRunning` and, if the container still exists, runs the command once more with fresh timing; the second result is returned whatever it is. Everything else is returned unchanged and never retried: a timeout, a null exit code (killed by signal), exit 137, any other exit code, and any output that merely contains one of these messages. If `ensureRunning` reports the container missing (a concurrent uninstall or rebuild), the original result is returned. A failed restart throws the existing `Failed to start sandbox …` error.

- Rationale: callers check liveness with `ensureRunning` and then exec; the watchdog can exit between the two. Safety rests on the whole-output match and the exit code, not on the idle clock: a command that actually ran would have to exit 1 or 128 having printed exactly docker's own failure line and nothing else. A container can end up stopped for reasons that have nothing to do with idleness (an operator's `docker stop`, a daemon restart, a process inside killing the watchdog), so "the container is stopped now" is deliberately not part of the test. Not consulting container state also means two calls that hit the same stop both recover: whichever restarts the container first, the other's `ensureRunning` is a no-op and its retry proceeds.
- A project's own code can forge the match (print the line, exit 128). All it gains is running itself twice inside its own sandbox, which it could do anyway.
- Verified at planning: 90 execs at random offsets against a 1-second watchdog gave 87 clean "not running" errors, the two exit-128 teardown failures and one success. The teardown messages arrive on stdout, so a stderr-only match would miss them. `docker start` on an already-running container is a no-op that exits 0.
- Consequences to carry into the leg: an `onOutput` consumer (the installer's log) sees the first attempt's failure line before the second attempt's output, on either stream, and that stray line is accepted; the second attempt gets its own start time and full timeout, so worst case is one fast failure, a restart of about a second, then the normal limit.
- **Cleanup opts out**: `McpProxy.kill` (reached from `closeSession` and from `open`'s failure path) must not start a stopped sandbox, and restart its idle clock, to kill a pid that died with it. The opt-out is a field on `ExecOptions`, which keeps `FakeDocker.exec`'s signature unchanged.
- **Proxied-server start-up has a weaker rule, stated as such**: `McpProxy.open` cannot see an exit code, and the two exit-128 messages go to stdout, which there is the JSON-RPC stream. Its rule is therefore: if the handshake fails and `Docker.state` reports the container `stopped` (not `missing`), start it and launch once more, with a new `Client`, launch and connector (the first client is already closed and its env file removed). Re-launching a server that never completed a handshake is what the next call would do anyway, so the cost of a wrong guess is one extra start. Worst-case start-up becomes two start-up timeouts, though a stopped container fails the first attempt immediately.
- Trade-off: only two teardown samples were captured, so other wordings may exist. An unrecognized failure is not retried and surfaces as an ordinary failed call; the next call works. Likewise a command that begins executing in the instant before teardown is killed with the container (exit 137) and is not retried, because it may have had side effects.
- Out of scope: the installer's discovery steps swallow exec errors as "no result" (`.catch(() => null)` around help and probe calls). That masking predates this flight and applies to any daemon failure. With the retry, an idle stop mid-install heals itself when the failure is one of the recognized ones; anything else is swallowed there as it is today. Not changed here.

**DD5 — Network state needs no handling on restart**: verified at planning in both directions. A container whose `bridge` network was disconnected still has no networks (only `lo`) after stop and start, and a connected container is still connected. `docker network connect` and `disconnect` also work on a stopped container and the result holds after start, so `set_project_network` behaves the same whether or not the sandbox has idled out. The offline-after-install guarantee therefore survives idle stops without re-applying anything; the flight pins this with integration tests rather than code.

**DD6 — Existing sandboxes are left alone**: containers created before this change keep `sleep infinity` and never idle-stop until the project is reinstalled. No migration.
- Rationale: follows directly from DD1 and was accepted at charter time. Replacing a container's entrypoint means recreating it, and tools installed outside the volume (`/opt/mcpe`) live in the container's writable layer, so a silent recreate would destroy installs.
- Trade-off: operators with existing installs must reinstall (`install_project` with `reinstall: true`) to get the timeout. The README says so.

**DD7 — Verification by integration test, not a behavior test**: the real-Docker behavior is asserted in `test/integration/docker.test.ts` alongside the existing opt-in Docker suite.
- Rationale: one deterministic script can verify it, which the methodology says is not behavior-test territory.
- Act path: a `Docker` built from its own `loadConfig({ ...process.env, MCPE_SANDBOX_IDLE_TIMEOUT: "6" })`, so the cases never inherit a developer's setting, creating sandboxes directly with `createContainer` on an already-pulled image (no repository install needed). The proxied-server case drives `McpProxy.listTools(container, spec)` against the suite's existing shell MCP server written into the sandbox. `createContainer` always attaches the bridge network, so the offline cases call `setNetwork(false)` first.
- Observe path: `docker inspect` (`.State.Running`, `.NetworkSettings.Networks`) through the suite's existing `run` helper, results of execs inside the sandbox, and tool-call results.
- The watchdog script cannot be unit tested (it reads the real `/proc` of whatever runs it); its correctness rests on the integration suite alone. Unit tests assert its fixed properties as text (entrypoint `/bin/sh`, `PATH` set, arguments passed).
- Unit-test seam: every existing test double replaces `Docker.exec` and `createContainer` wholesale (`FakeDocker` in `test/helpers.ts`), and `Docker.docker()` is TypeScript-private, so nothing today can exercise a real `Docker.exec` without Docker. Two workable seams, the leg picks one: a stub executable passed as `MCPE_DOCKER_BIN` (needs no production change; `loadConfig` already reads it), or splitting `exec` into a protected single-attempt method plus the retry wrapper so a test subclass can script attempts. The proxy's retry is tested through `FakeDocker`, which needs a `state` override added (it inherits the real one today).
- Trade-off: the integration cases only run with `MCPE_DOCKER_TESTS=1`.

### State and Cache Declarations
The flight makes "stopped" a routine state for a sandbox rather than a post-reboot rarity. What reads it:

| State | Source of truth | Staleness |
|-------|-----------------|-----------|
| Container running or stopped | Docker, read by `Docker.state` on every call | None: never cached |
| Registry `network` flag | Docker (`hasNetwork`); the flag is rewritten only by install and `set_project_network` | An idle stop changes neither (DD5), so none |
| Proxy session map | The in-container server process; `client.onclose` drops the session when it dies | A live session is a live process, which blocks the idle stop, so an idle stop never strands a session. (An external `docker stop` can, briefly, until `onclose` fires; that is existing behavior and unchanged.) |
| Proxy pid files in `/tmp` | Random name per launch, removed on kill | Never re-read after a restart |

Paths that meet a stopped sandbox and how each copes: tool calls, `sandbox_exec`, file read/write and proxied-server start-up go through `ensureRunning` first and are covered by DD4 for the gap after it; `set_project_network`, uninstall and rebuild use `docker network`/`docker rm`, which work on stopped containers; install execs into a container it has just created, with gaps of seconds between steps, and is covered by DD4 if a very small timeout is configured.

### Prerequisites
- [x] Docker daemon reachable (29.8.2) with the default sandbox images already pulled
- [x] Baseline green: 225 unit tests pass, `npm run typecheck` clean (checked at planning)
- [x] DD2, DD4 and DD5 premises verified on scratch containers (see flight log)
- [x] No other open sorties or active missions

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [x] Prerequisites verified
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
Order within the leg: the retry first (it is safe on its own), then the watchdog, which must not land without it.

1. **Retry** (`src/sandbox/docker.ts`, `src/proxy/mcp-proxy.ts`): the single retry from DD4 in `Docker.exec`, its opt-out for `McpProxy.kill`, and the equivalent in proxied-server start-up.
2. **Config** (`src/config.ts`): add `sandboxIdleSec` with the non-negative parse from DD3.
3. **Watchdog** (`src/sandbox/docker.ts`): add the watchdog script as a module constant and change `createContainer` to run `/bin/sh -c <script> watchdog <idleSec> <pollSec>` instead of `sleep infinity`, keeping `--init` and every existing flag, and adding the label from DD3. With `sandboxIdleSec` of 0 the entrypoint stays `sleep infinity`. Stopping is the script exiting 0; there is no restart policy, so the container stays stopped until `ensureRunning` starts it, which re-runs the watchdog with a fresh clock.

   Reference script (met the DD2 contract in the planning checks on dash and busybox; the leg may reshape it within that contract):

   ```sh
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   idle="$1"; poll="$2"
   read up _ < /proc/uptime; last=${up%%.*}
   prev=0
   while :; do
     sleep "$poll" & pid=$!
     active=0
     [ "$pid" -eq $((prev + 1)) ] || active=1
     prev=$pid
     for d in /proc/[0-9]*; do
       case "${d#/proc/}" in 1|$$|$pid) ;; *) active=1 ;; esac
     done
     read up _ < /proc/uptime; now=${up%%.*}
     if [ "$active" = 1 ]; then last=$now
     elif [ $((now - last)) -ge $((idle + poll)) ]; then exit 0
     fi
     wait "$pid"
   done
   ```
4. **Tests**:
   - Unit: config parsing (default, override, `0`, invalid); the `docker run` arguments and label for both the watchdog and the disabled case; the retry rule, covering every row of the DD4 table, each not-retried case (timeout, null exit code, exit 137, a message embedded in other output, the right message with the wrong exit code), the missing-container case and the cleanup opt-out; the proxy's start-up retry and its `missing` case.
   - Integration, with a 6 s timeout: an idle sandbox is observed stopped; a file under `/opt/mcpe/bin` and one under `/workspace/work` are still there after restart; a call against the stopped sandbox succeeds; an offline sandbox is still offline after restart, checked from inside the container as well as by `docker inspect`; a network-enabled sandbox is still enabled after restart; network toggled while stopped holds after restart; an exec longer than the timeout completes with exit 0 (this stands in for an install, which is the same mechanism); a live proxied MCP server keeps its sandbox running past the timeout; repeated short execs spaced under the timeout keep it running.
   - Integration housekeeping: wait for state changes by polling `docker inspect` against a deadline (timeout + 15 s) rather than sleeping a fixed time; volumes must be created with the `mcp-everything=1` label or `Docker.destroy` will refuse to remove them; the existing suite greps process lists for `sleep 60` and `sleep 300`, so the watchdog's poll must not produce those strings (the DD3 formula caps it at 15).
5. **Docs** (`README.md`): add `MCPE_SANDBOX_IDLE_TIMEOUT` to the settings table (including `0`, the up-to-half-a-minute stop latency, and an explicit contrast with `MCPE_MCP_IDLE_TIMEOUT`, which governs proxied servers rather than sandboxes); rewrite the "keeps an idle container running" limitation to describe the new behavior; note that existing installs need a reinstall, that a live proxied server keeps its sandbox up until `MCPE_MCP_IDLE_TIMEOUT` closes it, that a process a tool leaves running keeps its sandbox up, and that idle stopping is unverified under gVisor.

### Checkpoints
- [x] The retry rule passes its unit tests without Docker
- [x] A sandbox created with a short timeout is observed stopped after idling, on real Docker
- [x] A tool call against that stopped sandbox succeeds, with installed files intact and network state unchanged in both directions
- [x] A call longer than the timeout completes, and a live proxied MCP server keeps its sandbox up
- [x] Unit suite, typecheck and the Docker integration suite pass

### Adaptation Criteria

**Divert if**:
- PID-gap detection (DD2) proves unreliable on a supported image and no in-container alternative exists — that reopens DD1/DD2 with the operator.
- A restarted sandbox is found to regain or lose network access in any path — stop; that is a security defect to raise before anything lands.
- The work needs host-side lifecycle management (a reaper, shutdown hooks, a migration for existing containers) — that is a second decision cluster and escalates the sortie.
- The retry cannot be made to satisfy "never runs a command twice" for some call path.

**Acceptable variations**:
- Exact watchdog script shape and helper names, within the DD2 contract.
- Internal structure of the retry, as long as tool calls and proxied-server start-up are covered, cleanup never starts a sandbox, and the DD4 matching rule is not loosened.
- Additional "never started" message variants found during implementation, added to the DD4 matcher with evidence in the flight log.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `idle-watchdog` - Stopped-sandbox retry, config setting, watchdog entrypoint, unit and integration tests, README

No HAT leg: the operator declined it at spec approval, since the Docker integration suite asserts the whole behavior.

One implementation leg by design: the retry is harmless alone but only needed once the watchdog exists, there is no human decision or irreversible step between them, and the whole flight gets a single review and commit either way.

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [x] Code merged
- [x] Tests passing
- [x] Documentation updated

### Verification
- `npm test` and `npm run typecheck` pass.
- `npm run test:docker` passes, including the new idle-timeout cases listed in Technical Approach.
- Manual spot check: install a project with `MCPE_SANDBOX_IDLE_TIMEOUT=60`, wait, confirm `docker ps` no longer lists it, call a tool, confirm it answers.
