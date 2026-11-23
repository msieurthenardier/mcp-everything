# Leg: runtime-required

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
When `MCPE_DOCKER_RUNTIME` names a runtime, check that Docker lists it and can run a container with it before any container is created or any install or check begins, and refuse to start or exec into an existing sandbox created under a different runtime. When it is not named, nothing changes.

## Context
- **Flight DD11.** Naming a runtime is requiring it (operator, 2026-11-22). An existing sandbox under another runtime is refused with "reinstall" (operator, 2026-11-22). T9: Docker refuses an unknown runtime and never falls back. T10: this daemon has `runc`, `io.containerd.runc.v2` and `nvidia`; no `runsc`.
- **Leg 1** (`network-config`) adds `Config.network` and nothing this leg uses. This leg does not depend on it beyond the shape of `Config` in test literals.
- **Order.** This leg comes before legs 4–6, which add new kinds of container (one-shot proxies and networks, project proxies), so that every new container start is covered from the start.
- **Today's runtime handling.**
  - `limits()` (`src/sandbox/docker.ts`, `private limits()`) adds `--runtime <name>` to every container mcp-everything creates. Those are the one-shots through `runOnce` (clone, scan, copy) and the sandbox through `createContainer`.
  - Existing containers are started by `startId`, which is called from `acquire`, `ensureRunning` and `startIfStopped`, and are execed by `exec`/`execOnce`. None of these looks at the container's runtime today.
- **Entry points.** `Installer.install`, `Installer.check` and `Installer.installChecked` call `this.docker.assertAvailable()` first (`src/install/installer.ts:257`, `:337`, `:367`). The scan-off `install` writes the `installing` record and retires the old sandbox before the clone (`openInstall` / `retireOldSandbox`, `:262`–`:265`). A runtime refusal must come before that, next to `assertAvailable`, so a missing runtime never costs an installed project.
- **What is covered and what is deferred** (design review 1).
  - **Compared in this leg**:
    - `acquire`;
    - `exec` given a name (via `resolveContainer`, which reads `FULL_FORMAT`);
    - `ensureRunning`, given a name or a reference (it inspects either way, so the comparison costs nothing);
    - `startIfStopped` (by id, the idle-timeout restart inside `exec`).
  - **Not compared, on purpose**: `destroy`, `removeContainer`, `ownership`, `state`, `hasNetwork` and `setNetwork`, so a refused project can be uninstalled, reported and taken offline.
  - **Deferred to leg 5's `ensureContained` hook** (flight DD2): `exec` given a reference that finds the container running (no inspect today), and the MCP connector's own `docker exec -i <id>` (`src/proxy/mcp-proxy.ts`, `dockerConnector`). Both are safe in this leg only because their reference came from `acquire`, which compared. A reference held across a daemon restart is not rechecked until leg 5.
  - **`reconcileStale`** (`src/install/installer.ts:726`) keeps calling only `assertAvailable()`. It never creates or starts a container, and an unusable runtime must not block cleanup of interrupted installs.
  - The security paragraph's runtime wording is leg 9's; this leg only logs at startup.

## Inputs
- `src/sandbox/docker.ts`: `Docker`, `limits()`, `runOnce`, `OneShotRole`, `ONE_SHOT_ROLES`, `BASE_FORMAT`/`FULL_FORMAT`, `inspectContainer`, `acquire`, `exec`, `startIfStopped`, `ensureRunning`, `createContainer`, `sweepCheckLeftovers`, `assertAvailable`.
- `src/install/installer.ts`: `install`, `check`, `installChecked`.
- `src/server.ts`: the startup block around line 531 (`if (!this.startup) {`).
- `test/docker.test.ts`: the Docker test double, the coverage test's lists (the guarded table and `NOT_GUARDED`), and the format strings the double answers.

## Outputs
- `src/sandbox/docker.ts`: `assertRuntime()`, `RuntimeUnavailableError`, the `runtime-check` one-shot role, the runtime field in the inspect formats, the comparison on the by-name start and exec paths, and the mapping of Docker's runtime error.
- `src/install/installer.ts`: `assertRuntime()` after `assertAvailable()` in the three entry points.
- `src/server.ts`: a startup log line when a runtime is named.
- Tests in `test/docker.test.ts`, `test/installer.test.ts` and `test/server.test.ts`.

## Acceptance Criteria
- [ ] **Unnamed runtime: no change.** With `cfg.docker.runtime` unset, `assertRuntime()` makes no Docker call and resolves. No path compares runtimes. Every existing test passes unchanged, apart from the inspect format string where a test asserts it literally.
- [ ] **`assertRuntime()` with a runtime named**, in order:
  1. `docker info --format '{"runtimes":{{json .Runtimes}},"default":{{json .DefaultRuntime}}}'`. If the name is not a key of `runtimes`, throw `RuntimeUnavailableError`. Keep `default` for the comparison below.
  2. Ensure the probe image (`cfg.docker.probeImage`) with `ensureImage`, outside the trial's time limit.
  3. One trial container through `runOnce`: role `runtime-check`, `--network none`, `limits()` (which includes `--runtime <name>`), entrypoint `true`, no arguments, `timeoutMs` 60 000. A non-zero exit or a timeout throws `RuntimeUnavailableError`.
- [ ] **The message**: `MCPE_DOCKER_RUNTIME names <name>, but Docker cannot run containers with it (<reason>); install it and register it with Docker, or unset MCPE_DOCKER_RUNTIME.`
  - `<reason>` is "Docker lists no runtime called <name>", or the first line of Docker's stderr, cleaned with `oneLine` and at most 200 characters.
  - The name is cleaned the same way.
- [ ] **Caching.** A success is cached for the process, keyed by the runtime's name. A failure is not cached. Concurrent first callers share one in-flight check: two simultaneous calls make one `docker info` and one trial.
- [ ] **The trial never recurses**: `runOnce` calls `assertRuntime()` before `docker create` for every role except `runtime-check`.
- [ ] **`createContainer` calls `assertRuntime()`** before its volume checks.
- [ ] **Docker's own runtime error is mapped, narrowly** (design review 1: `/runtime/i` would catch any `OCI runtime create failed`, such as a bad entrypoint).
  - The mapping applies only when `docker create` (in `runOnce`, before its generic "Could not create the … container" message) or `docker run` (in `createContainer`) exits non-zero, a runtime is named, and **one stderr line contains both `unknown or invalid runtime name` and the named runtime** (T9's wording).
  - The error thrown is then `RuntimeUnavailableError` with that line as the reason, and the cached success is cleared.
  - Every other failure keeps its current message, including start-time OCI failures. A registered-but-broken runtime is the trial's to catch.
- [ ] **Existing sandboxes.**
  - The inspect formats read `HostConfig.Runtime`, as an optional `runtime` field on `ContainerFacts`.
  - With a runtime named, the paths listed under Context ("Compared in this leg") refuse a container whose runtime differs from the named one. They throw `RuntimeMismatchError` before starting or execing, whether the container is running or not: `Sandbox <name> was created before MCPE_DOCKER_RUNTIME=<named> was set; Docker reports its runtime as <actual>. Reinstall the project to run it under <named>.`
  - An absent, `null` or empty runtime field counts as the daemon's `DefaultRuntime` from the `info` call (`runc` on a stock daemon), so a daemon whose default was changed is not misreported. Before any `info` answer is cached, it counts as `runc`.
  - The paths listed as not compared do **not** compare.
- [ ] **A refused project can still be taken offline.** `set_project_network(project, false)` must not go through `acquire` (today it calls `this.sandbox(project)` first, `src/server.ts:1155`–`:1160`).
  - With `enabled: false`:
    1. **Keep the "still installing" guard.** Extract the job check at the top of `sandbox()` (`src/server.ts:636`–`:641`, which throws `ToolInputError("<slug> is still installing; check project_info.")`) into a helper such as `assertNotInstalling(project)`, used by both `sandbox()` and this path.
    2. **Keep the missing-sandbox message.** If `docker.state(project.container)` (by name, classified) is `missing`, throw the same "no longer exists … reinstall" error `sandbox()` gives today.
    3. Call `docker.setNetwork(project.container, false)` by name. It classifies ownership but does not compare runtimes.
  - `enabled: true` keeps going through `this.sandbox()`/`acquire`, so it is refused on a mismatch.
  - Unit cases in `test/server.test.ts`:
    - `false` on a runtime-mismatched sandbox succeeds without calling `acquire`;
    - `false` during an install is refused with the installing message;
    - `false` on a missing sandbox gives the reinstall message;
    - `true` on a mismatch is refused.
  - The existing cases at `test/server.test.ts:163` and `:1459` ("acquires once") use `true` and stay valid.
- [ ] **Entry points.** `Installer.install`, `check` and `installChecked` call `await this.docker.assertRuntime()` immediately after `assertAvailable()`.
  - A refusal reaches the tool result as the message above, with no record written, no proxy closed and no sandbox touched.
  - Unit cases with a reinstall show the old record and sandbox untouched.
- [ ] **Sweep.** `runtime-check` is added to `OneShotRole` and `ONE_SHOT_ROLES`, so a trial container left by a killed process is swept at startup like a clone.
- [ ] **Startup.** With a runtime named, the server's startup runs `assertRuntime()` in the background and logs one line: `startup: runtime <name>: Docker runs it`, `startup: <the message>`, or `startup: runtime <name> not checked: Docker is not reachable`.
  - It never fails or delays startup, and does not block `reconcileStale`.
  - Its result is not awaited by tool calls, which call `assertRuntime()` themselves.
  - With no runtime named it does nothing.
- [ ] **Coverage.** Every new `Docker` method, **private ones included** (the coverage test compares all of `Docker.prototype`), appears in the coverage test's lists. Each goes in `NOT_GUARDED` with a one-line reason: `assertRuntime` and the comparison and mapping helpers act on nothing they did not create or were not given. `npm run typecheck` and `npm test` pass.

## Verification Steps
- `npx vitest run test/docker.test.ts test/installer.test.ts test/server.test.ts`: cases for every criterion, among them:
  - no Docker call when unnamed;
  - `info` lacks the name; the trial exits non-zero; the trial times out;
  - success cached across two calls; failure retried on the next call; two concurrent calls make one check;
  - `runOnce` for `clone` calls the check and for `runtime-check` does not;
  - Docker's "unknown or invalid runtime name" on `create` mapped, and the cache cleared;
  - `acquire` of a `runc` container with `runsc` named refused; `destroy` of the same allowed;
  - a reinstall refused with the old record unchanged.
- `npm run typecheck`, then `npm test`: green; record counts in the flight log.
- **Trial** (flight 1's practice). For three checks (the name missing from `info`, the mismatch refusal in `acquire`, the shared in-flight promise), weaken the source, confirm a test fails, and restore by editing (never git). Record each in the flight log.
- **Docker suite**: not required for this leg. The real-runtime proof is leg 10's CI job, and a Docker case here could only show "missing runtime refused" on this daemon. **Optional, after the Flight Director's go-ahead**: one Docker-gated case naming an unregistered runtime (e.g. `mcpe-no-such-runtime`) asserts that `check_project` refuses with the message and creates no container. Run it only if the Flight Director approves at landing.

## Implementation Guidance
1. **Inspect formats.** Add `"runtime":{{json .HostConfig.Runtime}}` to `BASE_FORMAT` and `FULL_FORMAT`.
   - Parse it as an optional string in `inspectContainer`. Do not make a missing or `null` field an error: the test doubles and old daemons may omit it.
   - **Test doubles** (design review 1):
     - In `test/docker.test.ts`, `world()` records the `--runtime` value on `create`/`run` and answers it in `inspect`. It answers `info` with a runtimes map and default, and `strict` mode allows `info`. The trial is recognizable in `created` by its role label.
     - The fakes in `test/installer.test.ts` (around line 123) and `test/server.test.ts` (around line 1207) override `assertAvailable()`. They gain an `assertRuntime()` override that a case can make throw.
     - Leave existing cases that omit the field working.
2. **`assertRuntime()`** on `Docker`.
   - Fields: `runtimeOk?: string` (the name that passed) and `runtimeCheck?: Promise<void>` (in flight).
   - Clear `runtimeCheck` when it settles. Set `runtimeOk` only on success.
   - Use `ask()` for `docker info` (it maps a binary that cannot run to `DockerUnavailableError`). Parse the JSON keys.
3. **`runOnce`**: call `assertRuntime()` first unless `spec.role === "runtime-check"`. Map the create failure as specified. Add the role to the type and the list.
4. **`createContainer`**: `assertRuntime()` first; map the `run` failure.
5. **Comparison.**
   - A private helper `refuseRuntimeMismatch(name, facts)`, used in `acquire`, `exec` (string target), `ensureRunning` (string **or** reference target: the MCP connector calls it with a reference, `src/proxy/mcp-proxy.ts:262`; unit case for a mismatched reference) and `startIfStopped`. Assert in a test that only `assertRuntime` uses the `runtime-check` role.
   - `startIfStopped` inspects by id; make it read the runtime (`inspectContainer(id, false)` already uses `BASE_FORMAT`).
   - Do not add it to `resolveContainer`, which `destroy` and `removeContainer` use.
6. **Installer**: one line after each `assertAvailable()`.
7. **Server startup**: in the `if (!this.startup)` block, when `cfg.docker.runtime` is set, fire `this.docker.assertRuntime()` with `.then`/`.catch` logging. Do not add it to the `startup` promise (tests await that).

## Edge Cases
- **`MCPE_DOCKER_RUNTIME=runc`** (explicit default). `info` lists it; the trial runs; existing containers report `runc`. Nothing is refused.
- **`io.containerd.runc.v2`.** Docker may report an existing default container's runtime as `runc` while the daemon also lists `io.containerd.runc.v2`. Compare exact strings; an operator naming `io.containerd.runc.v2` will see existing `runc` sandboxes refused. Acceptable and stated in a comment. Leg 9's README says to name the runtime as `docker info` lists it.
- **Docker unreachable** during `assertRuntime()`: `DockerUnavailableError` propagates as today. It is not a runtime refusal, and nothing is cached.
- **The trial image cannot be pulled** (offline): the reason is the pull failure. This is a runtime refusal, not cached, and tried again next time.
- **The trial relies on the probe image having `true`.** `alpine/git` has it as a BusyBox applet. An operator who overrides `MCPE_PROBE_IMAGE` with an image without `true` gets a trial failure whose reason is Docker's "executable file not found". That is stated in a code comment, and leg 9's README mentions it.
- **The idle-timeout restart**: an exec that finds the container stopped (`isStoppedExecFailure`), and whose `startIfStopped` then meets a mismatch, throws `RuntimeMismatchError`, not the exec's failure. Unit case.
- **`docker info` lists `io.containerd.runc.v2` next to `runc`**, and containers report `runc`. An operator who names the shim is refused on existing sandboxes; the message's "Docker reports its runtime as runc" is the hint.
- **A daemon restarted without the runtime after a cached success**: the next `create` fails, the mapping turns it into the runtime message, and the cache is cleared.

## Files Affected
- `src/sandbox/docker.ts`: formats, `assertRuntime`, errors, role, comparison, error mapping.
- `src/install/installer.ts`: three calls.
- `src/server.ts`: startup log; `set_project_network(false)` by name.
- `test/docker.test.ts`, `test/installer.test.ts`, `test/server.test.ts`: cases, the doubles' `info`/inspect/`assertRuntime` answers, coverage lists.

## Citation Audit
Checked on 2026-11-22 against the working tree (flight branch, no source changes yet):
- `src/install/installer.ts:257`, `:337`, `:367`: `await this.docker.assertAvailable();` in `install`, `check` and `installChecked`. Present.
- `src/install/installer.ts:262`–`:265`: `openInstall`, then `retireOldSandbox` in `install`. Present.
- `src/sandbox/docker.ts`: `limits()`, `runOnce`, `ONE_SHOT_ROLES` (`["clone", "scan", "copy"]`), `BASE_FORMAT`/`FULL_FORMAT`, `acquire`, `exec`, `startIfStopped`, `ensureRunning`, `createContainer`, `sweepCheckLeftovers`. Present.
- `src/server.ts`: `if (!this.startup) {` near line 533. Present.
- Leg 1 may shift line numbers in `src/config.ts` only; no citation here points into it.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
