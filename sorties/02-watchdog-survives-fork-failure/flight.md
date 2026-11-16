# Sortie: Watchdog Survives Fork Failure

**Status**: completed

## Charter

### Outcome
A sandbox that hits its process limit keeps running; the idle watchdog never stops a sandbox because it could not fork.

### Why Now
The [sortie 01 debrief](../01-sandbox-idle-timeout/flight-debrief.md) verified that the watchdog exits when it cannot fork, taking the sandbox down mid-work. That is a regression from `main`, it leaves sortie 01's "never stopped mid-work" criterion unmet, and pull request #1 is held in draft until it is fixed.

### Success Criteria
- [x] A sandbox held at its process limit by processes that keep forking is never stopped, on both a Debian-based image (dash) and a busybox image.
- [x] Once the pressure ends and the sandbox goes quiet, it still idle-stops, within a bound stated in the README.
- [x] All of sortie 01's idle-timeout behavior is unchanged: its existing integration cases pass unmodified.

### Constraints
- The watchdog may busy-retry only while it cannot get a process slot for its `sleep`; at all other times it waits without using CPU, as it does today. *(Revised by the operator on 2026-11-15 from "must not replace the stop with a busy loop that takes CPU from the build", after measurement showed that a zero-CPU wait and guaranteed resumption cannot both hold. See DD2.)*
- It still needs only `/bin/sh` and coreutils, with no host-side process and no change to isolation flags or limits.
- The fix reaches `main` together with sortie 01: it is committed on the sortie 01 branch, and so is part of pull request #1, before that pull request merges.

---

## Pre-Flight

### Objective
Change the watchdog script in `src/sandbox/docker.ts` so that a failed fork of its per-poll `sleep` is no longer fatal: the fork is wrapped so the shell survives the failure, and the watchdog retries until it succeeds, treating the episode as activity. Everything else about the watchdog (activity detection, clock, never-early rule, fixed `PATH`, exit 0 on idle) stays as sortie 01 left it. The behavior is pinned by integration cases on a dash image and a busybox image that hold a sandbox at its process limit.

### Open Questions
- [x] Can a POSIX shell survive a failed fork at all? → DD1 (measured)
- [x] What does the watchdog do while it cannot fork, given the charter wanted no busy loop? → DD2 (measured; constraint revised by the operator)
- [x] How can a test tell that the failure path actually ran, rather than passing because the pressure never bit? → DD3
- [x] Which image stands in for "a busybox image" without adding a dependency? → DD4

### Design Decisions

Every factual statement below is marked **measured** (observed on throwaway containers during planning; see the flight log) or **inferred** (reasoned, not observed). Sortie 01 shipped a defect because an inferred failure mode was written as fact.

**DD1 — The fork is wrapped in `command eval`**: the per-poll line becomes a loop around `command eval 'sleep "$poll" & pid=$!'`.
- Rationale: in dash and busybox `sh`, a failed fork is a shell error that exits a non-interactive script. POSIX says an error in a special builtin run through `command` must not abort the shell, and both shells honor that for a fork failing inside `eval`.
- **Measured**: with the shipped loop, a contested process limit stopped the container with exit code 2 on dash (`Cannot fork`) and on busybox (`can't fork: Resource temporarily unavailable`). With `command eval`, dash survived 6 failed forks and busybox 12 in the first probe, container still running; in a later probe dash survived episodes of up to 48,598 consecutive failed forks. The Architect reproduced the dash behavior independently, without Docker.
- **Inferred**: other shells that may sit behind `/bin/sh` (bash, mksh, yash) behave at least as well. Not tested. Bash is documented to report a failed fork and continue.
- Trade-off: the correctness of the watchdog now rests on a specific POSIX rule as implemented by two shells. The integration cases in DD3 are what catch a shell where it does not hold.

**DD2 — While it cannot fork, the watchdog retries immediately, and counts the episode as activity**: there is no pause between attempts.
- Rationale: dash has no builtin that waits for a period of time, so the only wait that uses no CPU is `wait` on a child forked earlier, and children are what cannot be created while the limit is contested (**inferred** from dash's documented builtins; no alternative was found or tested). The alternatives were weighed with the operator: park on a pre-forked child (no CPU, but only as many retries as there are spare children, after which the sandbox never idle-stops until restarted; **inferred**, this design was not built), or retry (always resumes, at the cost of a busy loop while it cannot get a slot). The operator chose retry and revised the charter constraint accordingly.
- A failed fork means the sandbox is at its limit, so something is running: the idle clock is reset, exactly as for any other activity. This is belt and braces: whatever holds the slots is also visible to the existing `/proc` scan, so no test can tell the two apart.
- **Measured**: with sortie 01's shipped script, a sandbox whose limit of 12 was filled once and then left alone kept its watchdog, on both shells (sortie 01 debrief). **Inferred**: the reason is that the watchdog frees one slot when its `sleep` ends and takes it straight back when nothing else is forking, and the new script therefore never enters its retry loop in that state. Not run with the new script.
- **Measured**: under a deliberately tight fork loop on dash, 15 s of pressure produced seven retry episodes of 0 to 2000 ms, about 5.3 s in total. On busybox against four fork loops, four episodes of 10 ms or less. **Inferred**: each episode ends when some other process exits and the watchdog wins the freed slot.
- **Measured**: the worst case, on dash. With all 16 slots held by sleeping processes after the watchdog had lost its own, four samples at 12, 27, 42 and 57 s showed the sandbox at 104 to 106% of one CPU and at 22.7, 28.2, 24.2 and 40.7 MiB of memory, still running. Those memory figures are for the whole sandbox, sleepers included; the last is the highest, and four samples cannot show whether it was climbing. About 25 s after the sleepers exited the sandbox was at 0.1% CPU and 1.6 MiB with 3 processes, still running. That is the same footprint as a watchdog that had barely retried (1.0 to 1.8 MiB in another run), so the shell itself did not keep memory from roughly a minute of continuous retrying. So the retry loop is one thread, out of the sandbox's own CPU limit (`MCPE_CPUS`, default 2), for as long as no slot frees.
- **Measured**: on busybox, 52 s with six `awk` loops still forking left the sandbox running with one warning line; three samples of whole-sandbox memory ranged from 4 to 49 MiB. That figure is dominated by the loops and says nothing about the watchdog alone.
- **Measured**, on this host (Docker on a multi-core WSL2 kernel): lowering the watchdog's priority does not reduce the cost. A nice-19 loop and a normal-priority loop each took about half the CPU of a one-CPU sandbox. **Inferred** cause: the limit is a quota spread over the host's cores, so the two never share a run queue. `nice` is therefore not used.
- **Measured**: the host's kernel log gets one "fork rejected by pids controller" line per container, not one per failed fork: 40 pressure runs added exactly 40 lines.
- **Measured**: failed forks consume PID numbers. Eight seconds of pressure moved the sandbox's PID counter from 15 to about 270,000 on dash and 119,000 on busybox, against a `pid_max` of 4,194,304. **Inferred**: how much of that is the watchdog's share; the figure includes the competitor's own failed forks.
- **Inferred**: sustained pathological pressure for a couple of minutes would wrap the sandbox's PID counter. PIDs wrapping is already read as activity by the watchdog. A stale PID file belonging to a proxied MCP server that had already exited could then name an unrelated process inside the same sandbox when it is cleaned up. That exposure exists today for any sandbox running a fork bomb; the watchdog's retries add to how fast the counter moves.
- **Inferred**: a fork that fails for another reason, such as the sandbox's memory limit, is retried in the same way and has the same cost. Not tested.
- **Not measured**: memory or CPU behavior over more than about a minute of continuous retrying, and the watchdog's own memory while it is retrying (only the whole sandbox's, and the watchdog's footprint afterwards).
- Trade-off, accepted by the operator: a busy loop of one thread while the watchdog cannot get a slot for its `sleep`.

**DD3 — The watchdog announces the first failed fork, once per container start**: on the first failure it writes one line to stderr, `watchdog: cannot fork (process limit reached); retrying`, and nothing more until the container is restarted.
- Rationale: stderr from the fork attempts themselves is discarded, or a retry loop would write tens of thousands of lines a second into the container's log. That leaves no trace that the failure path ever ran. During planning, three kinds of pressure left the shipped loop untouched (a limit filled once and left alone, host-driven `docker exec` loops, and a single `awk` loop) and would have made a naive test pass for the wrong reason. The line gives the integration cases something to assert, so a case that never provoked a failure fails instead of passing. It also tells an operator reading `docker logs` why a sandbox was busy.
- **Measured**: exactly one line in the container's log after 8 s of pressure, on both shells; no output at all from a quiet sandbox.
- **Measured**: how reliably pressure produces the line, with a process limit of 24. Dash with one `perl` fork loop: 20 of 20 runs, between 1.0 and 3.1 s. Busybox with six `awk` loops started by a single exec: 30 of 30 runs, between 1.0 and 5.2 s. In all 50 the sandbox was running when checked immediately after the line appeared; those series did not wait for the pressure to end. Survival through the end of the pressure is shown by fewer runs: the six recipe runs under DD4 and the earlier single probes.
- **What 30 clean runs do and do not show**: they rule out a failure rate above about 10% with 95% confidence, not a rare one. A 5% failure rate would still give 30 clean runs about one time in five.
- **Measured, and a warning for the test design**: an earlier busybox series that started four loops with four separate execs produced the line in only 19 of 20 runs. Docker refused some of those execs because the sandbox was already at its limit, which weakens the pressure. In the one miss the sandbox had stopped by the time it was checked 30 s later. **Inferred**: that was an ordinary idle stop after pressure that never bit; its exit code was not recorded, so a watchdog death in that run cannot be ruled out from the data. The 30-run series that followed, with a single exec, recorded exit codes and had no stop. Because of this open point, the leg repeats the pressure cases many times as an acceptance step and treats any intermittent failure as a design problem, not a flake (Technical Approach, Adaptation Criteria).
- Trade-off: the watchdog is no longer silent. Nothing in the codebase reads sandbox container logs (verified by search for `logs` in `src/`), so no consumer is affected.

**DD4 — The busybox case uses the project's own probe image**: `cfg.docker.probeImage` (`alpine/git:latest`), which is Alpine with busybox `sh` and is already required to install anything.
- Rationale: the charter asks for a busybox image; using one the project already depends on adds no new pull to the integration suite.
- **Measured**: the reference script runs on `alpine/git:latest` as a sandbox entrypoint, quiet and under pressure. Earlier variants of the script, not the final one, were the ones exercised on `alpine:latest`.
- Pressure on that image comes from busybox `awk` (`system("sleep 1 &")` in a loop, several in parallel); on the Debian image from `perl`, which `buildpack-deps` ships. Both tolerate their own failed forks, which a shell loop does not.
- **Measured**: busybox `timeout` on that image accepts the `-k` option that `Docker.exec` passes, and kills only its direct child: `awk` loops started in the background by a wrapping `sh` survive it and keep running. The pressure must therefore end by itself (`awk`'s `systime()`, `perl`'s `time`), not rely on the exec's time limit.
- **Measured**: the recipe intended for the tests (limit 24, pressure that ends itself after 8 s, started by one exec wrapped in `timeout -k 5 30`), three runs per shell, typed as `docker exec` commands by hand rather than run through `Docker.exec`: every run had logged the warning once and was running with an unchanged start time 11 s after the pressure started, and had idle-stopped with exit code 0 when checked 13 s after that (24 s after the pressure started, about 16 s after it ended).

**DD5 — In production code, the whole change is in the script**: no change to `createContainer`'s arguments, `Docker.exec`, the proxy, configuration, or the README's settings table. Tests and the README's idle-stopping note change as described under Technical Approach.
- Rationale: the defect is in the loop. Keeping the entrypoint arguments and label as they are means sandboxes created by sortie 01's code and by this code differ only in the script text.
- Consequence: a sandbox created with sortie 01's script (only possible from the unmerged branch) keeps the old loop until reinstalled. No released version has it.

### State and Cache Declarations
No new state. The watchdog gains two shell variables (whether this poll was starved, whether the warning has been written), both local to one container run. Nothing is cached: container liveness is read from `docker inspect` on every call.

One existing layer matters to the tests: `Docker.exec` restarts a sandbox it finds stopped, and callers check liveness before each call, so a wrongly stopped sandbox is put back without anyone noticing. A test of "was never stopped" must therefore assert that `.State.StartedAt` is unchanged and that the container is running, and must pass `restart: false` to any exec it makes, or the restart path will hide exactly the defect this flight fixes.

### Prerequisites
- [x] Sortie 01's code is present on the branch this work starts from (`b041bd0`), and the squawk turnaround (`7cb69fd`, pull request #2) sits on top of it
- [x] Docker daemon reachable (29.8.2); `buildpack-deps:stable` and `alpine/git:latest` present locally
- [x] DD1–DD4 premises measured on throwaway containers (flight log)
- [x] Baseline on the squawk branch: `npm test` 270 passed, 12 skipped; typecheck clean
- [x] **All of this work is on one branch, by the operator's decision at spec approval (2026-11-15)**: the squawk turnaround is merged into `sortie/01-sandbox-idle-timeout`, the sortie 01 debrief artifacts are committed there, and this flight is implemented and committed on that same branch rather than on a `sortie/02-…` branch of its own. Pull request #1 therefore carries sortie 01, the three squawks, the debrief and this fix, and there is no separate pull request for this flight. This departs from the Git Conventions' one-branch-per-sortie scheme on purpose. The untracked `.flightops/` and `CLAUDE.md` remain the operator's to decide and are left out.

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [x] Prerequisites verified
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
1. **Script** (`src/sandbox/docker.ts`, `WATCHDOG_SCRIPT`): replace the single `sleep "$poll" & pid=$!` line with the guarded retry, add the starved flag to the activity decision, and add the one-time warning. Update the comment above the constant. Reference script, as exercised at planning on `buildpack-deps:stable` (dash) and `alpine/git:latest` (busybox). The leg may reshape it within DD1–DD3. It is shown as shell; inside the TypeScript template literal each `${` must be written `\${`, as in the existing constant:

   ```sh
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   idle="$1"; poll="$2"
   read up _ < /proc/uptime; last=${up%%.*}
   prev=0; warned=0
   while :; do
     starved=0
     until command eval 'sleep "$poll" & pid=$!' 2>/dev/null; do
       starved=1
       [ "$warned" = 1 ] || { warned=1; echo "watchdog: cannot fork (process limit reached); retrying" >&2; }
     done
     active=$starved
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
2. **Unit test** (`test/docker.test.ts`): extend the existing script-text assertions: the script contains `until command eval` and the warning text. The existing assertions (fixed `PATH` before the first `while`, intact `${…}` expansions, no `sleep 60`/`sleep 300`) must still pass untouched.
3. **Integration tests** (`test/integration/docker.test.ts`): two new cases, one per shell, in their own `describe` block with their own configuration (`MCPE_PIDS_LIMIT: "24"`, the 6 s timeout) and their own sandbox-creating helper that takes the image. The existing block's shared `create()` helper and its cases are not edited. Each case:
   - creates the sandbox and records `.State.StartedAt`;
   - starts pressure with **one** exec (`restart: false`) that ends by itself after about 8 s: on the Debian image a `perl` fork loop bounded by `time`, on the probe image six `awk` loops bounded by `systime()`, started in the background by one `sh` that waits for them;
   - polls `docker logs` for the warning line against a 30 s deadline. If it never appears the case fails: the pressure did not reach the watchdog and the case proved nothing. This is also how the case fails against sortie 01's script, which stops the container without ever printing the line;
   - once the pressure has ended, asserts the container is running and `.State.StartedAt` is unchanged;
   - asserts it then idle-stops, exit code 0, within timeout + 15 s, polling as the existing cases do.
   The cases make no other exec into the sandbox while it is under pressure: at the limit Docker may refuse it.
   Mechanics that matter:
   - Start the pressure exec without awaiting it, poll, then await it before the post-pressure assertions, and make sure it is awaited on the failure path too. `Docker.exec` resolves only when the command ends.
   - Do not assert on the pressure exec's exit code, `timedOut`, `truncated` or output: refused forks inside it can make any of them unremarkable-looking or odd. Send the pressure's own output to `/dev/null` inside the command.
   - There is no helper for container logs. Use the suite's `run` helper (`docker logs <name>`); the warning is on the container's stderr, so read both streams.
   - On failure, the assertion message includes the container's `.State.ExitCode`, `.State.OOMKilled`, its logs and the pressure exec's result, so a real watchdog death can be told from pressure that did not bite.
   - The deadline for the idle stop is timeout + 15 s after the pressure exec has returned; the stop is expected within about 9 s, so the margin is deliberate.
4. **Acceptance run**: before the leg lands, the two pressure cases are run at least 30 times each (for example with vitest's repeat option, or a loop), and every run must pass. One clean pass is not acceptance for a test of a race.
5. **README**: in the idle-stopping note under Limitations, add that a sandbox at its process limit keeps running; that while it is at the limit the watchdog may use up to one CPU's worth of the sandbox's own CPU limit retrying, until a process slot frees; and that idle stopping then resumes with the same timeout and the same up-to-half-a-minute latency already stated there. That existing bound is the one the charter's second criterion refers to; no new number is introduced.

### Checkpoints
- [x] The script as emitted contains the guarded retry and still passes sortie 01's text assertions
- [x] On the Debian image, a sandbox under process-limit pressure logs the warning, is never restarted, and idle-stops afterwards
- [x] The same on the busybox image
- [x] Both pressure cases pass 30 consecutive runs each
- [x] Sortie 01's idle-timeout cases pass unmodified; unit suite, typecheck and build pass

### Adaptation Criteria

**Divert if**:
- `command eval` does not make the failure survivable on one of the two images in the integration suite as it did at planning — that reopens DD1.
- The pressure cases cannot be made to provoke a failed fork reliably (the warning line appears in fewer than every run of the acceptance run) — the cases would be flaky gates; stop and rethink the pressure, do not loosen the assertion.
- Any run of a pressure case finds the sandbox stopped, restarted, or exited non-zero — that is not a flake to retry. Capture the exit code, `OOMKilled` and logs, stop, and reopen DD1.
- The fix appears to need anything beyond the script (a pre-forked helper, a host-side change, new configuration) — that is option B territory, which the operator declined.

**Acceptable variations**:
- Exact shape of the retry and warning within DD1–DD3, and the exact warning text, as long as it is one line, once per container start, on stderr.
- Pressure parameters in the tests (limit, duration, number of loops).

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `fork-failure-guard` - Guarded retry and one-time warning in the watchdog script, unit assertions, pressure cases on both shells, README note

One leg, no HAT leg: the change is a few lines of shell and the behavior is fully observable from the integration suite.

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [x] Code merged
- [x] Tests passing
- [x] Documentation updated

### Verification
- `npm test`, `npm run typecheck` and `npm run build` pass.
- `npm run test:docker` passes in full: sortie 01's cases unmodified, plus the two pressure cases, each of which saw the warning line.
- Sortie 01's third charter criterion ("never stopped mid-work") can then be re-assessed as met, and pull request #1 taken out of draft.

### Not Verified by This Flight
- Behavior under gVisor (`runsc`), as for sortie 01.
- Shells other than dash and busybox `sh` behind `/bin/sh`.
- Continuous retrying for longer than about a minute (memory and CPU were watched for 55 s).
- Fork failures from causes other than the process limit, such as the memory limit.
- The integration suite covers pressure that comes and goes, from one recipe per shell. The fully packed case in DD2 was measured by hand at planning and is not an automated test; other pressure patterns are not covered at all.
- A rare failure. The acceptance run bounds the failure rate of the pressure cases at roughly 10%; it cannot show there is none. One busybox run at planning ended with a stopped container that was never explained.
- The watchdog's own memory use while retrying, as opposed to the whole sandbox's.
- Host kernels and cgroup setups other than the planning host (the CPU and `nice` measurements are from one WSL2 machine).
- The `starved` flag's effect on the idle clock, which no test can separate from the `/proc` scan.
