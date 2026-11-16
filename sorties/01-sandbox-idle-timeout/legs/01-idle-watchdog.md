# Leg: idle-watchdog

**Status**: completed
**Flight**: [Sandbox Idle Timeout](../flight.md)

## Objective
Make every newly created sandbox container stop itself after `MCPE_SANDBOX_IDLE_TIMEOUT` seconds without activity (default 1800, `0` disables), and make calls that race that stop recover by themselves, with tests and README updated.

## Context
- This is the only implementation leg of the sortie. The flight spec's design decisions DD1–DD7 are binding; read them in `../flight.md` before starting. The summary here does not replace them.
- **DD1/DD2**: the container entrypoint becomes a `/bin/sh` watchdog script that exits 0 when nothing has run in the sandbox for the timeout. Activity = any process other than PID 1, the watchdog and its `sleep`, or a gap in the PIDs of the watchdog's successive `sleep` children. The script's contract (clock from `/proc/uptime`, `$!` capture, first poll is baseline, never early, builtins only, fixed `PATH`) and a reference script that met it at planning are in the flight spec.
- **DD3**: `Config.sandboxIdleSec` from `MCPE_SANDBOX_IDLE_TIMEOUT`; poll interval `min(15, max(1, floor(idleSec / 4)))`; `0` keeps the `sleep infinity` entrypoint; label `mcp-everything.idle-timeout=<seconds>`.
- **DD4**: `Docker.exec` retries once, only when the whole result is one of three recognised docker "could not exec" failures; cleanup opts out; proxied-server start-up has its own weaker rule.
- **DD5/DD6**: no network handling on restart (pinned by tests); sandboxes created before this change are left alone.
- **DD7**: real behavior is asserted in the opt-in Docker integration suite; the retry and `docker run` arguments are unit tested through a seam that does not exist yet.
- Planning ran every premise on throwaway containers (flight log, "Premise checks" tables). The observed failure strings in the DD4 table come from that evidence; do not loosen the match.
- No prior legs. Baseline at planning: `npm test` 225 passed / 6 skipped, `npm run typecheck` clean.

## Inputs
- Branch `sortie/01-sandbox-idle-timeout`, working tree clean apart from untracked `.flightops/`, `CLAUDE.md` and `sorties/` (leave `.flightops/` and `CLAUDE.md` alone).
- `src/sandbox/docker.ts` — `Docker.createContainer` ends its `docker run` argv with `"--entrypoint", "sleep", opts.image, "infinity"`; `Docker.exec` makes a single attempt; `Docker.docker()` is `private`.
- `src/config.ts` — `int()` returns the fallback for any value that is not a positive integer; `mcpIdleSec` is the nearest existing setting.
- `src/proxy/mcp-proxy.ts` — `McpProxy.open` calls `ensureRunning`, then one connect attempt; `McpProxy.kill` calls `this.docker.exec(...)` and swallows errors.
- `test/helpers.ts` — `FakeDocker` overrides `exec`, `ensureRunning`, `setNetwork`, `destroy`, `removeContainer`; it does **not** override `state`.
- A reachable Docker daemon with `buildpack-deps:stable` already pulled, for the integration cases.

## Outputs
- `src/config.ts`, `src/sandbox/docker.ts`, `src/proxy/mcp-proxy.ts` modified as below.
- New unit tests (`test/config.test.ts`, `test/docker.test.ts` or equivalent) and additions to `test/proxy.test.ts`, `test/helpers.ts`, `test/integration/docker.test.ts`.
- `README.md` updated.
- Flight log updated with a leg entry.

## Acceptance Criteria

**Configuration**
- [x] `loadConfig({})` yields `sandboxIdleSec === 1800`.
- [x] `MCPE_SANDBOX_IDLE_TIMEOUT` of `"45"` yields 45 and `"0"` yields 0; `"-5"`, `"abc"` and `""` each yield 1800.
- [x] No other setting's parsing changes (`int()` still rejects 0 for its existing callers).

**Container creation**
- [x] With `sandboxIdleSec > 0`, the `docker run` argv produced by `createContainer` contains `--entrypoint /bin/sh`, then the image, then `-c`, the watchdog script, `watchdog`, the timeout and the poll interval as decimal strings, in that order, and contains `--label mcp-everything.idle-timeout=<timeout>`.
- [x] The poll interval passed is `min(15, max(1, floor(idleSec / 4)))`: 15 for 1800, 1 for 6, 1 for 1, 15 for 60, 7 for 30.
- [x] With `sandboxIdleSec === 0`, the argv ends `--entrypoint sleep <image> infinity` and carries `--label mcp-everything.idle-timeout=0`.
- [x] In both cases every flag `createContainer` passes today is still present (`--init`, name, hostname, both existing labels, limits, the six `--cap-add`s, `--network bridge`, the volume, `-w`, the environment).
- [x] In the watchdog script as passed to docker, a `PATH=` assignment to system directories appears before the first `while`, the literal shell expansions `${up%%.*}` and `${d#/proc/}` are present intact, and neither `sleep 60` nor `sleep 300` appears.

**Retry in `Docker.exec`** — each row of the flight spec's DD4 table is a test
- [x] A first attempt with exit code 1, empty trimmed stdout and trimmed stderr that is exactly `Error response from daemon: container <token> is not running` (one non-space token; `container` matched case-insensitively) leads to one `ensureRunning` call and one more attempt, whose result is returned.
- [x] The same for exit code 128, empty trimmed stderr and trimmed stdout exactly `cannot exec in a stopped state`, and for trimmed stdout exactly `OCI runtime exec failed: exec failed: cannot exec in a stopped container`.
- [x] There are never more than two attempts: if the second attempt also returns a recognised failure, it is returned as is.
- [x] Exactly one attempt, and no `ensureRunning` call, for each of: `timedOut` true; exit code `null`; exit code 137; exit code 1 with the daemon line plus any other output on either stream; exit code 2 with the daemon line; exit code 128 with the OCI line embedded in longer stdout; `truncated` true.
- [x] If `ensureRunning` returns `false` (container missing), the first attempt's result is returned and no second attempt is made.
- [x] If `ensureRunning` throws, the error propagates and no second attempt is made.
- [x] The `timedOut` value of a retried call is derived from the second attempt's own start time: when more than the call's limit elapses between the first attempt's start and the second's, and the second attempt returns 137 promptly, `timedOut` is false.
- [x] `ExecOptions` has an opt-out field (`restart?: boolean`, default behaviour is to retry); with `restart: false`, a recognised failure is returned after one attempt and `ensureRunning` is not called.

**Proxy**
- [x] `McpProxy.kill` passes `restart: false` (asserted on the recorded exec call's options), so killing a pid in a stopped sandbox never starts it.
- [x] When the first handshake in `McpProxy.open` fails and `Docker.state` reports `stopped`, `ensureRunning` is called again and exactly one further launch is made with a new `Client`, a new `Launch` (new pid file) and a new connector call; if it succeeds, the returned session holds the second launch, so a later close kills the second pid file.
- [x] Each attempt's `Connection.cleanup` is called exactly once.
- [x] When the first handshake fails and `Docker.state` reports `running` or `missing`, or `Docker.state` itself rejects, no second launch is made and the existing "did not start" error is thrown unchanged.
- [x] When `ensureRunning` returns `false` or throws on the way to the second launch, no second launch is made and the "did not start" error for the first attempt is thrown (the restart failure may be appended to it).
- [x] When the second launch also fails, the "did not start" error is thrown (it may say the sandbox was restarted first) and no third launch is made.
- [x] A connector that throws synchronously still propagates its own error unchanged, with no `Docker.state` call.
- [x] `FakeDocker` overrides `state` and records `ensureRunning` calls, and no unit test reaches the real `docker` binary.

**Real Docker** (`npm run test:docker`, new `describe` block, timeout 6 s)
"Was never stopped" below means the container's `.State.StartedAt` (from `docker inspect`) is the same at the end of the case as at its start. A plain "is running" check is not enough, because `Docker.exec` now restarts a stopped sandbox and would hide a wrongful stop.

- [x] A sandbox created with `createContainer` and left alone is observed not running within timeout + 15 s, with `.State.ExitCode` 0.
- [x] After that stop and a restart via `ensureRunning`, a file previously written under `/opt/mcpe/bin` and one under `/workspace/work` are both still present with the same contents.
- [x] `Docker.exec` against the stopped sandbox returns the command's own successful result (the sandbox is restarted on the way).
- [x] A sandbox taken offline with `setNetwork(false)` is still offline after an idle stop and restart: `hasNetwork` is false and, inside the container, `/sys/class/net` lists only `lo`.
- [x] A sandbox left online is still online after an idle stop and restart (`hasNetwork` true).
- [x] `setNetwork(false)` applied while the sandbox is stopped holds after restart.
- [x] An exec that sleeps longer than timeout + 2 × poll + 1 s returns exit code 0, and the sandbox was never stopped.
- [x] One short exec (`true`) every 3 s for at least 15 s leaves the sandbox never stopped. (3 s is well over the 1 s poll, so this passes only if activity between polls is detected, and well under the timeout.)
- [x] With a proxied MCP server open through `McpProxy.listTools`, after timeout + 2 × poll + 1 s the sandbox was never stopped; after `closeAll()` it is observed stopped within timeout + 15 s.
- [x] With `sandboxIdleSec` 0, a sandbox is still running after 12 s, was never stopped, and `docker inspect` shows entrypoint `sleep` with command `infinity`.

**Documentation**
- [x] The README settings table has a `MCPE_SANDBOX_IDLE_TIMEOUT` row giving the default `1800`, that `0` disables it, that it applies to sandboxes created after it is set, and how it differs from `MCPE_MCP_IDLE_TIMEOUT`.
- [x] The README limitation "Each installed project keeps an idle container running…" is rewritten to describe idle stopping and restart on first use, and the README states: sandboxes installed before this change need a reinstall to get the timeout; a live proxied MCP server or a process a tool leaves running keeps its sandbox up; a sandbox stops up to about half a minute after the timeout; idle stopping has not been verified under gVisor (`runsc`).

**Regression**
- [x] `npm test`, `npm run typecheck` and `npm run build` pass.
- [x] `npm run test:docker` passes in full (existing cases and the new ones).

## Verification Steps
- `npm test` — all unit tests pass under vitest's default 5 s per-test timeout (there is no vitest config file), including the new config, `docker run` argv, retry and proxy cases. That default is the fail-fast guard; a unit test that needs longer is a hanging test to fix, not a timeout to raise.
- `npm run typecheck && npm run build` — both exit 0.
- `MCPE_DOCKER_TESTS=1 npx vitest run test/integration` — existing and new integration cases pass. The existing cases clone from github.com; if the network is unavailable, say so in the flight log rather than reporting them as passing.
- `grep -rn "MCPE_SANDBOX_IDLE_TIMEOUT" README.md src test` — the name appears in the README table, `src/config.ts` and the tests. `grep -rnw "MCPE_IDLE_TIMEOUT" README.md src test` prints nothing. (Plain `git grep` would skip the new, still-untracked test files.)
- Read the README limitation and settings rows against the documentation criteria above.

## Implementation Guidance

Work in this order; the watchdog must not be wired in before the retry exists.

1. **Seam for unit tests**
   - Every existing double replaces `Docker.exec` wholesale, so a retry inside it is invisible to them. Recommended: change `Docker.docker()` from `private` to `protected` and write a small test subclass that records each argv and answers **by argv, not by call order**. `createContainer` makes two `docker image inspect` calls (`ensureImage`, `imagePath`) before its `docker run`, and the retry goes through `ensureRunning` (`inspect`, then possibly `start`); an in-order replay would mis-sequence. For the retry tests it is simpler to override `ensureRunning` on the subclass and script only the `exec` results.
   - If `docker()` becomes protected, give `FakeDocker` an override of it that throws, so any unit test that would reach the real binary fails loudly.
   - A stub executable passed through `MCPE_DOCKER_BIN` is an acceptable alternative.
   - For the "second attempt's own start time" criterion: spy on `Date.now`, advance it past the call's limit while the restart happens, have the second attempt return 137, and assert `timedOut` is false. `exec` only consults elapsed time for code 137.

2. **Retry in `Docker.exec`** (`src/sandbox/docker.ts`)
   - Split the current body into a single-attempt helper that takes its own `started` timestamp, and a wrapper that applies the rule.
   - Put the three recognised failures in one small pure function over `{ code, stdout, stderr, timedOut, truncated }`, exported for direct testing. Match trimmed whole strings; the daemon line is `^Error response from daemon: container \S+ is not running$` with `container` case-insensitive (older daemons capitalise it).
   - On a match and without the opt-out: `await this.ensureRunning(container)`; if `false`, return the first result; otherwise run the helper once more and return its result. `ensureRunning` already throws `Failed to start sandbox …` if `docker start` fails; let that propagate.
   - Add the opt-out to `ExecOptions` as `restart?: boolean`, so `FakeDocker.exec` keeps its signature.
   - `stdin` is a string and is simply sent again. `onOutput` will have received the first attempt's failure line; that is accepted (flight spec DD4).

3. **Proxy** (`src/proxy/mcp-proxy.ts`)
   - `McpProxy.kill`: pass the opt-out.
   - `McpProxy.open`: factor one launch attempt (new `Launch`, connector call, new `Client`, `connect`, and on failure `client.close()`, `kill`, stderr capture, `cleanup`) out of the method. On a failed first attempt, call `this.docker.state(container)`; only for `"stopped"` call `ensureRunning` and attempt once more. Keep the existing error text for the final failure.
   - `conn.cleanup?.()` currently runs in a `finally`; make sure it runs for each attempt (it removes that attempt's env file).
   - Failure handling around the second step: a rejection from `Docker.state` (daemon down, binary missing) is caught and treated as "not stopped"; `ensureRunning` returning `false` or throwing means no second launch, and the first attempt's "did not start" error is thrown, with the restart failure appended if there was one. The connector call itself stays outside this handling: a connector that throws synchronously must propagate its error as it does today (`test/installer.test.ts` has a connector that throws "spawn failed" and relies on it).
   - `test/helpers.ts`: give `FakeDocker` a `state` override (settable, default `"running"`) and a record of `ensureRunning` calls. Without the `state` override, every existing test whose handshake fails (`test/proxy.test.ts`, `test/server.test.ts`, `test/installer.test.ts` with `up.answer = false`) would shell out to the real `docker inspect`.
   - Testing with the existing fake connector: `fakeUpstream`'s `answerIf` runs after the launch is recorded, so `up.answerIf = (l) => l !== up.launches[0]` makes the first launch fail and the second succeed; pass a short start-up limit as the existing failed-handshake test does. To observe `cleanup`, wrap the connector in the test so each `Connection` carries a spy; `fakeUpstream`'s own connections have none.

4. **Config** (`src/config.ts`)
   - Add `sandboxIdleSec` to `Config` with a doc comment, next to `mcpIdleSec`. Add a non-negative variant of `int()` (same `parseInt` leniency, accepts 0, falls back on negative or non-numeric) and use it only here.

5. **Watchdog** (`src/sandbox/docker.ts`)
   - Add the script as a module constant, like `PROBE_SCRIPT`. Start from the reference script in the flight spec's Technical Approach; it was exercised on dash and busybox at planning. Keep to its contract if you reshape it.
   - **Escaping**: the script contains shell expansions `${up%%.*}` and `${d#/proc/}`. In a JavaScript template literal `${` starts an interpolation (`PROBE_SCRIPT` uses that on purpose for `${REPO_DIR}`), and `String.raw` does not help. Write each as `\${` inside a template literal, or build the script from ordinary quoted strings. The unit criterion on the literal expansions exists to catch a slip here.
   - In `createContainer`, compute the poll interval, add the label, and replace the tail of the argv: `"--entrypoint", "/bin/sh", opts.image, "-c", SCRIPT, "watchdog", String(idle), String(poll)`, or the existing `sleep`/`infinity` tail when the timeout is 0.
   - `createContainer` reads the timeout from `this.cfg`; its signature need not change.

6. **Tests**
   - Unit: as the criteria list. Use `loadConfig({ ... })` with an explicit env object, never the process environment, so a developer's own settings cannot leak in.
   - Integration: add a separate `describe.skipIf(!enabled)` block with its own `loadConfig({ ...process.env, MCPE_DATA_DIR: <tmp>, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "6" })`. Create each sandbox directly: `docker volume create --label mcp-everything=1 <name>` (through the suite's `run` helper), then `docker.createContainer({ name, volume, image: cfg.docker.images.generic, project: "idle-test" })`. Remove with `docker.destroy(name, volume)` in `afterEach`/`afterAll`, including on failure.
   - Wait for state changes by polling `Docker.state` (or `docker inspect`) against a deadline, not with fixed sleeps. A sandbox with a 6 s timeout stops between 6 and 9 s after its last activity, so "still running" assertions belong within about 4 s of the last activity and "stopped" assertions get a deadline of timeout + 15 s.
   - Read `.State.StartedAt`, `.State.ExitCode`, `.Config.Entrypoint` and `.Config.Cmd` with `docker inspect --format` through the suite's `run` helper; `Docker.state` only reports running, stopped or missing. Avoid `ps` inside the container for these checks.
   - For the proxied-server case, write the suite's existing `SH_MCP_SERVER` into the sandbox with an exec that reads stdin (`sh -c 'cat > /workspace/work/sh-mcp.sh'`), and open it with `new McpProxy(cfg, docker).listTools(container, spec)`, where the spec is `{ name, argv: ["sh", "/workspace/work/sh-mcp.sh"], cwd: "/workspace/work", env: {}, origin: "registered" }` (confirm against `McpServerSpec` in `src/types.ts`).
   - The disabled case needs a second `Docker` built from a config with `MCPE_SANDBOX_IDLE_TIMEOUT: "0"`.
   - Checks made by exec inside the container (the `/sys/class/net` listing, file contents) restart it and its idle clock; order them after the restart you mean to observe.
   - One idle stop can serve several checks (file survival, exec against a stopped sandbox, network toggled while stopped) to keep the suite's run time down.
   - Give the new cases **and their hooks** explicit vitest timeouts; several legitimately take 15–30 s and the default hook timeout is 10 s.

7. **README**
   - Settings table row and the Limitations rewrite, per the documentation criteria. Check the sandboxing/security section for any other sentence that says a container keeps running.

8. **Flight log**: add the leg entry (changes, verification with actual test counts, decisions, deviations, anomalies), then set this leg's status to `landed`.

## Edge Cases
- **`/workspace/work` and `/opt/mcpe/bin` do not exist in a directly created sandbox**: the probe and install steps normally create them. Integration cases that use them must `mkdir -p` both first.
- **Fresh container, first poll**: the first poll always counts as activity, so a sandbox created and never used still gets a full timeout before stopping.
- **Exit 137 during teardown**: a command that started just before the stop is killed with the container and must not be retried.
- **Truncated or partial output**: a result flagged `truncated` is never a match, even if the visible text looks like one.
- **Container removed concurrently** (uninstall, rebuild on another image): `ensureRunning` returns `false`; return the first result, do not throw a new error from the retry path.
- **Two calls racing the same stop**: both may match and both call `ensureRunning`; `docker start` on a running container is a no-op, so both second attempts proceed. Do not add a state check that would make the slower one give up.
- **Installer log**: `onOutput` during an install may show one stray "is not running" line before the retried step's output. Accepted.
- **`0` must never reach the script**: the disabled case keeps `sleep infinity`.
- **Existing integration greps**: the suite counts processes matching `sleep 60` and `sleep 300`; the watchdog's `sleep <poll>` with poll ≤ 15 cannot match either.
- **Fork failure in the watchdog** (sandbox at its pids limit): the reference script reads it as activity and spins. A guard is welcome if it stays within the contract; it is not required.
- **Out of scope — do not change**: the installer's `.catch(() => null)` around discovery execs; migrating existing containers; any host-side reaper or shutdown hook. If the work seems to need one of these, stop and signal `[BLOCKED:...]`.

## Files Affected
- `src/config.ts` — `Config.sandboxIdleSec`, non-negative integer parse, `loadConfig` entry
- `src/sandbox/docker.ts` — watchdog script constant, `createContainer` entrypoint and label, `exec` retry and single-attempt helper, `ExecOptions` opt-out, `docker()` visibility if that seam is chosen
- `src/proxy/mcp-proxy.ts` — `kill` opt-out, `open` single re-launch
- `test/helpers.ts` — `FakeDocker.state`
- `test/config.test.ts` (new) — config parsing
- `test/docker.test.ts` (new) — `docker run` argv, retry rule
- `test/proxy.test.ts` — start-up retry cases
- `test/integration/docker.test.ts` — idle-timeout block
- `README.md` — settings table, Limitations
- `sorties/01-sandbox-idle-timeout/flight-log.md` — leg entry

## Citation Audit
Checked against the working tree on 2026-11-15, branch `sortie/01-sandbox-idle-timeout` (no source changes since `main` at `33fa024`):
- `src/sandbox/docker.ts` — `createContainer` argv tail `"--entrypoint", "sleep", opts.image, "infinity"`; `private docker(`; `exec` computes `started`/`overdue` once; `state` returns `"running" | "stopped" | "missing"`; `ensureRunning` returns `false` for missing and throws `Failed to start sandbox …` on a failed start — all present.
- `src/config.ts` — `int()` with `Number.isFinite(n) && n > 0`; `mcpIdleSec: int(env.MCPE_MCP_IDLE_TIMEOUT, 600)` — present.
- `src/proxy/mcp-proxy.ts` — `kill` (`this.docker.exec(... KILL_SCRIPT ...)` with `.catch(() => undefined)`), `open` (`ensureRunning`, `client.connect`, `conn.cleanup?.()` in `finally`), `Connection` exposing `transport`, `stderr`, `cleanup` — present.
- `src/util/exec.ts` — `RunResult.code: number | null`, `timedOut`, `truncated` — present.
- `test/helpers.ts` — `FakeDocker` overrides `exec`, `ensureRunning`, `setNetwork`, `destroy`, `removeContainer` and not `state` — confirmed.
- `test/integration/docker.test.ts` — `SH_MCP_SERVER`, `prefix`, `enabled`, greps for `[s]leep 60` and `[s]leep 300` — present.
- `README.md` — settings table with `MCPE_MCP_IDLE_TIMEOUT` row; Limitations bullet "Each installed project keeps an idle container running. After a reboot containers are restarted on first use." — present.
- No `test/config.test.ts` or `test/docker.test.ts` exists yet — confirmed.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
