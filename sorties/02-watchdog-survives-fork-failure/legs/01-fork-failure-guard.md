# Leg: fork-failure-guard

**Status**: completed
**Flight**: [Watchdog Survives Fork Failure](../flight.md)

## Objective
Make the sandbox watchdog survive a failed fork by retrying it, so a sandbox at its process limit is never stopped by the watchdog and still idle-stops once the pressure has passed, with integration cases on a dash image and a busybox image that prove the failure path ran.

## Context
- This is the only leg of the sortie. The flight spec's design decisions DD1–DD5 are binding; read them, and the measurements behind them in the flight log, before starting. Each factual statement there is marked measured or inferred on purpose.
- **Why it exists**: sortie 01's watchdog forks a `sleep` every poll. In dash and busybox `sh` a failed fork exits a non-interactive script, so a sandbox whose process limit is contested loses its watchdog, and with it the container. Verified at planning on both shells (exit code 2, `Cannot fork` / `can't fork`).
- **DD1**: wrap the fork in `command eval`, which makes the failure survivable on both shells (measured).
- **DD2**: retry immediately until the fork succeeds, and count the episode as activity. The operator accepted the resulting busy loop over the alternative. Do not add pauses, helpers, `nice`, or pre-forked children: each was considered and rejected with measurements.
- **DD3**: write one warning line to stderr on the first failed fork of a container run. The tests depend on it to prove the failure path ran.
- **DD4**: the busybox case uses the project's probe image, `cfg.docker.probeImage`.
- **DD5**: in production code only the script changes.
- **One unexplained observation from planning**: in one of 20 early busybox pressure runs the container was found stopped and its exit code had not been captured. The most likely explanation is weak pressure followed by an ordinary idle stop, but a watchdog death was not ruled out. That is why this leg has an acceptance run of 30 per shell and why any stop during it is a blocker, not a flake.
- Branch: all work is on `sortie/01-sandbox-idle-timeout`, by the operator's decision. There is no `sortie/02-…` branch.
- Baseline on this branch: `npm test` 270 passed, 12 skipped; `npm run test:docker` 12 passed.

## Inputs
- Branch `sortie/01-sandbox-idle-timeout` at `dbc3306` or later, containing sortie 01, the squawk turnaround and the sortie 01 debrief. Working tree clean apart from untracked `.flightops/`, `CLAUDE.md` and `sorties/02-watchdog-survives-fork-failure/`.
- `src/sandbox/docker.ts` — `WATCHDOG_SCRIPT`, whose loop body starts with `sleep "$poll" & pid=$!` followed by `active=0`.
- `test/docker.test.ts` — the case "runs the watchdog entrypoint by default" with the script-text assertions.
- `test/integration/docker.test.ts` — the `describe` block "docker integration: sandbox idle timeout" with its helpers (`inspect`, `startedAt`, `create`, `waitStopped`, `sh`).
- A reachable Docker daemon with `buildpack-deps:stable` and `alpine/git:latest` present locally.

## Outputs
- `src/sandbox/docker.ts` — `WATCHDOG_SCRIPT` and the comment above it.
- `test/docker.test.ts` — added assertions.
- `test/integration/docker.test.ts` — a new `describe` block with two cases.
- `README.md` — the idle-stopping note under Limitations.
- Flight log — leg entry including the acceptance-run results.

## Acceptance Criteria

**Script**
- [x] The script passed to docker by `createContainer` contains `until command eval` around the fork of `sleep "$poll"`, and discards the stderr of the fork attempts.
- [x] The script contains the text `watchdog: cannot fork (process limit reached); retrying`, written to stderr, and can write it at most once per run of the script.
- [x] A poll in which at least one fork attempt failed is treated as activity.
- [x] The starved flag is reset at the start of every poll, so a sandbox that was starved once can still go idle and stop later.
- [x] Apart from those changes the loop is as sortie 01 left it: same clock, same PID-gap check, same `/proc` scan, same never-early threshold, same `exit 0`, same fixed `PATH`.
- [x] `createContainer`'s `docker run` arguments other than the script text are unchanged.

**Unit tests**
- [x] `test/docker.test.ts` asserts that the emitted script contains `until command eval` and the warning text.
- [x] Every assertion that existed in `test/docker.test.ts` before this leg is still present, unmodified, and passes.

**Integration tests** — a new `describe` block; process limit 24, idle timeout 6 s
- [x] The existing `describe` block "docker integration: sandbox idle timeout", including its helpers and cases, is unchanged.
- [x] Debian case (`cfg.docker.images.generic`): after one pressure exec is started, the warning line appears in the container's logs within 30 s; once that exec has returned, the container is running and its `.State.StartedAt` is what it was before the pressure; the warning line occurs exactly once in the logs; the container then stops within idle timeout + 15 s with `.State.ExitCode` 0.
- [x] Busybox case (`cfg.docker.probeImage`): the same.
- [x] Each case fails, rather than passing, if the warning line never appears.
- [x] When a case fails, its message includes the container's `.State.ExitCode`, `.State.OOMKilled`, its logs, and the pressure exec's result.
- [x] Each run of a pressure case prints one line giving the shell and how long the warning took to appear, so repeated runs can be counted and timed from the output.
- [x] **Negative control**: with the script change temporarily reverted (sortie 01's script, tests kept), both pressure cases fail, and the diagnostics show why: the container stopped with exit code 2 and the warning line never appeared. Recorded in the flight log with the diagnostics quoted; the revert is undone.
- [x] **Acceptance run**: each pressure case passes 30 runs with no failed run among them. The flight log records, per shell, the number of runs and the range of times taken for the warning to appear.

**Documentation**
- [x] The README's idle-stopping note under Limitations says that a sandbox at its process limit keeps running; that while it is at the limit the watchdog may use up to one CPU's worth of the sandbox's own CPU limit retrying until a process slot frees; and that idle stopping then resumes with the same timeout and latency already stated there.

**Regression**
- [x] `npm test`, `npm run typecheck` and `npm run build` pass.
- [x] `npm run test:docker` passes in full: the 12 existing cases and the 2 new ones.

## Verification Steps
- `npm test` — all unit tests pass under vitest's default 5 s per-test timeout.
- `npm run typecheck && npm run build` — both exit 0.
- `MCPE_DOCKER_TESTS=1 npx vitest run test/integration` — 14 cases pass. The pre-existing cases clone from github.com; if the network is unavailable say so rather than reporting them as passing.
- `git diff -- test/integration/docker.test.ts` — only added lines, all after the end of the existing idle-timeout block (everything the new block needs is already imported at the top of the file). `git diff -- test/docker.test.ts` — only added lines.
- Negative control: copy the changed `src/sandbox/docker.ts` to a scratch location outside the repository, restore the committed version with `git show HEAD:src/sandbox/docker.ts > src/sandbox/docker.ts`, run only the two pressure cases, confirm both fail with exit code 2 and no warning line, quote the diagnostics in the flight log, then copy the changed file back and confirm with `cmp` against the scratch copy and `git diff --stat` that the change is in place again. (This avoids `git stash`, which can leave the change hidden if a step in between fails.)
- Acceptance run: run only the two pressure cases, 30 runs each. Vitest's `--repeats <n>` flag repeats a test n more times, so n + 1 runs in all; `repeats` does not stop at the first failed run and the reporter shows one result for all of them, which is why each run prints its own line. A run takes roughly 25 to 30 s, so use batches that fit a command's time limit, for example `MCPE_DOCKER_TESTS=1 npx vitest run test/integration -t "<case name>" --repeats 14` twice per shell. Confirm the flag with `npx vitest --help` first; if this vitest does not have it, pass `repeats` in the test's options object from an environment variable named `MCPE_PRESSURE_REPEATS` instead and say so in the flight log. Count the runs from the printed lines and report the real numbers. A batch with a failed run is evidence to report, not something to re-run.
- Read the README note against the documentation criterion.

## Implementation Guidance

1. **Script** (`src/sandbox/docker.ts`)
   - Start from the reference script in the flight spec's Technical Approach. It was run at planning on `buildpack-deps:stable` and `alpine/git:latest`, quiet and under pressure.
   - The change is four things: `warned=0` beside `prev=0`; `starved=0` at the top of every poll; the `until command eval 'sleep "$poll" & pid=$!' 2>/dev/null; do … done` loop, replacing the bare `sleep "$poll" & pid=$!`, that sets `starved=1` and writes the warning once; and `active=$starved` in place of `active=0`. Leaving out the per-poll `starved=0` would make a sandbox that was starved once count as active forever.
   - The script lives in a JavaScript template literal: every shell `${` must be written `\${`, as the existing constant does. The single quotes around the `eval` argument and the double quotes inside it need no escaping there. An existing unit assertion checks the two `${…}` expansions survive. The new lines contain no `${`; keep it that way, including in the warning text.
   - Update the comment above the constant: the loop's only fork is its `sleep`, that fork can fail at the sandbox's process limit, and the script retries it rather than exiting.
   - Do not change `createContainer`, `watchdogPollSec`, the label, or anything else in the file.

2. **Unit assertions** (`test/docker.test.ts`)
   - Add to the existing case "runs the watchdog entrypoint by default", after its current assertions: the script contains `until command eval` and the warning text. Leave the existing lines as they are.

3. **Integration cases** (`test/integration/docker.test.ts`)
   - Add a separate `describe.skipIf(!enabled)` block after the idle-timeout block, with its own `loadConfig({ ...process.env, MCPE_DATA_DIR: <tmp>, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "6", MCPE_PIDS_LIMIT: "24" })`, its own `Docker`, its own container-creating helper that takes the image, and its own cleanup. Small helpers (`inspect`, a stop wait) may be repeated in the new block; do not hoist or edit the existing block's helpers. `Docker.createContainer` applies the configured limit through `limits()`.
   - Names under the suite's `prefix`; volumes created with `--label mcp-everything=1` so `Docker.destroy` will remove them; cleanup in `afterAll` including on failure; explicit timeouts on cases and hooks.
   - Pressure, as measured at planning. Each is one exec, ends by itself after about 8 s, and tolerates its own failed forks. `Docker.exec` passes its argv to `docker exec` with no shell in between, so each program below is one argv element exactly as shown, with no surrounding shell quotes. Neither contains a backtick, a backslash or `${`, so each can be written verbatim as a JavaScript template literal (backticks):
     - Debian, argv `["perl", "-e", PROGRAM]`, where PROGRAM is:

       ```
       $SIG{CHLD}="IGNORE"; my $end=time+8; while(time<$end){ my $p=fork(); if(defined $p && $p==0){ sleep 2; exit 0 } }
       ```
     - Busybox, argv `["sh", "-c", PROGRAM]`, where PROGRAM is:

       ```
       for k in 1 2 3 4 5 6; do awk 'BEGIN{e=systime()+8; while(systime()<e) system("sleep 1 &")}' >/dev/null 2>&1 & done; wait
       ```
       (At planning the same `awk` program was passed in double quotes with escaped inner quotes; the single-quoted form here is the same program without the backslashes. The redirection applies to each `awk`, so its children do not hold the exec's output open.)
     - Run each through `docker.exec(name, argv, { timeoutSec: 30, restart: false })`. `Docker.exec` wraps the command in `timeout -k 5 30`; busybox `timeout` on the probe image accepts that (measured) but kills only its direct child, which is why the loops must end themselves. The Debian exec returns about 10 s after it starts, because perl's last children keep its output open for their 2 s.
   - Sequence in each case: create; read `StartedAt`; start the pressure exec **without awaiting it**, wrapped so that it can never reject (`docker.exec(…).then((r) => r, (e) => ({ error: String(e) }))`), which also gives the diagnostics their "pressure result"; poll `docker logs <name>` through the suite's `run` helper, matching against stdout and stderr concatenated (the warning is on the container's stderr), until the line appears or 30 s pass, and fail explicitly at the deadline with the diagnostics rather than leaving it to a later assertion; print the per-run line; await the pressure exec (in a `finally`, so it is awaited on the failure path too); then, immediately, assert running, `StartedAt` unchanged, and exactly one warning line in the concatenated logs; then wait for the stop against a deadline of idle timeout + 15 s; assert `.State.ExitCode` is `0`.
   - Why that order is safe: after the pressure exec returns, a correct watchdog cannot stop for at least about 6 s, and the three checks take well under a second. "Exactly one" also catches a watchdog that died and was restarted, which would log the line again.
   - Container names: the new block keeps its own counter and a stem of its own under `prefix` (for example `fork-`), incremented on every run, so repeated runs and the existing `idle-N` names cannot collide.
   - Do not assert on the pressure exec's exit code, `timedOut`, `truncated` or output. Do not exec anything else into the sandbox while the pressure is running: at the limit Docker may refuse it, and without `restart: false` an exec would restart a wrongly stopped sandbox and hide the defect.
   - Build the failure diagnostics once (exit code, `OOMKilled`, logs, pressure result) and attach them to each assertion's message, so a failing run explains itself.
   - Give each case a per-run timeout of about 120 s in the options object, which is the second argument (`it(name, { timeout }, fn)`); vitest applies it to each run, not to all repeats together.

4. **Negative control**, then **acceptance run**, as the verification steps describe. Do the negative control first: a pressure case that passes against the old script is not testing anything, and that has to be known before 30 runs are spent on it.

5. **README**: extend the idle-stopping note under Limitations with one sub-bullet covering the three points in the documentation criterion. Match the neighbouring sub-bullets' style and wrapping. Do not restate the timeout or latency numbers; refer to the ones already there.

6. **Flight log**: add the leg entry (changes; verification with real counts; the negative control's failure messages; the acceptance run's per-shell counts and timing ranges; decisions, deviations, anomalies), then set this leg's status to `landed`.

## Edge Cases
- **A pressure case finds the sandbox stopped, restarted, or exited non-zero, even once**: stop. Do not re-run to get a pass and do not loosen the assertion. Record the diagnostics in the flight log and report `[BLOCKED:pressure-case-failed]`. The flight spec treats this as reopening DD1.
- **The warning line does not appear in some run of the acceptance run**: same. The pressure recipe is then not reliable enough to be a gate, and the flight spec says to stop and rethink it.
- **The pressure exec is refused by Docker** ("unable to spawn … Resource temporarily unavailable"): it should not be, since the sandbox holds only three processes when it starts. If it happens, that is a finding to report, not something to retry around.
- **Idle stop takes longer than expected after pressure**: the last activity is the end of the pressure's last child, about 1 to 2 s after the exec returns; the stop follows within about 9 s of that. The 21 s deadline is deliberate margin.
- **Template-literal escaping**: a missed `\${` either fails to compile or silently changes the script. The existing unit assertions on the literal expansions catch it.
- **Out of scope — do not change**: `Docker.exec`, `createContainer`'s arguments, the proxy, configuration, the installer, the README settings table, sortie 01's artifacts, the squawk records. If the fix seems to need any of them, stop and report `[BLOCKED:...]`.

## Files Affected
- `src/sandbox/docker.ts` — `WATCHDOG_SCRIPT` and its comment
- `test/docker.test.ts` — two added assertions
- `test/integration/docker.test.ts` — new `describe` block with two pressure cases
- `README.md` — one sub-bullet in the idle-stopping note
- `sorties/02-watchdog-survives-fork-failure/flight-log.md` — leg entry

## Design Review Note
Reviewed by a Developer agent on 2026-11-15 (approve with changes). Folded in: the exact argv for each pressure program and how to write it as a literal; vitest's `--repeats` semantics (n + 1 runs, no stop on failure, per-run timeout, options as the second argument); a per-run output line so repeated runs can be counted and timed; the per-poll `starved=0`, which this leg's own summary of the change had left out; a pressure promise that cannot reject; a negative control that restores the old script by copying rather than `git stash` and that checks why the cases fail; and the reasoning for where the "running" assertions sit relative to the idle clock. The review confirmed the case counts (12 before, 14 after) and that the new block can be a pure append.

## Citation Audit
Checked against the working tree on 2026-11-15, branch `sortie/01-sandbox-idle-timeout` at `dbc3306`:
- `src/sandbox/docker.ts` — `const WATCHDOG_SCRIPT = \`` with a seven-line comment above it ending "PATH is fixed because the container's own puts project-writable directories first."; loop body `sleep "$poll" & pid=$!` then `active=0`; `limits()` passes `--pids-limit` from `cfg.docker.pidsLimit`; `ExecOptions.restart` exists; `exec` wraps argv in `timeout -k 5 <secs>` (in `execOnce`) — present.
- `src/config.ts` — `pidsLimit: int(env.MCPE_PIDS_LIMIT, 1024)`; `probeImage: env.MCPE_PROBE_IMAGE || "alpine/git:latest"`; `images.generic` defaults to `buildpack-deps:stable` — present.
- `test/docker.test.ts` — case "runs the watchdog entrypoint by default" asserting `PATH=/usr/local/sbin` before `while`, `${up%%.*}`, `${d#/proc/}` and no `sleep (60|300)` — present.
- `test/integration/docker.test.ts` — `describe.skipIf(!enabled)("docker integration: sandbox idle timeout", …)` with `inspect`, `startedAt`, `create`, `waitStopped`, `sh`, `IDLE = 6`, `STOP_DEADLINE_MS = (IDLE + 15) * 1000`; `run` imported from `src/util/exec.js`; `prefix` and `enabled` defined at file top — present.
- `README.md` — Limitations bullet beginning "A sandbox with no activity for `MCPE_SANDBOX_IDLE_TIMEOUT` seconds" with sub-bullets, including the squawk 0003 sub-bullet on `docker inspect` — present.
- vitest 5.1.0 is installed; there is no vitest config file.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
