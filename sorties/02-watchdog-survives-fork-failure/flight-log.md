# Flight Log: Watchdog Survives Fork Failure

**Flight**: [Watchdog Survives Fork Failure](flight.md)

## Summary
Landed 2026-11-15 on `sortie/01-sandbox-idle-timeout`. One leg, `fork-failure-guard`: the watchdog now retries a failed fork instead of exiting. Reviewed and confirmed in two cycles (the second for making the pressure cases opt-in, on the operator's instruction). Awaiting debrief.

---

## Leg Progress

### Leg 01: fork-failure-guard

**Status**: completed
**Started**: 2026-11-15
**Completed**: 2026-11-15

**Changes Made**
- `src/sandbox/docker.ts`: `WATCHDOG_SCRIPT` now has `warned=0`, a per-poll `starved=0`, the `until command eval 'sleep "$poll" & pid=$!' 2>/dev/null` retry loop that sets `starved=1` and writes the one-line warning once, and `active=$starved`. Comment above the constant extended. Nothing else in the file changed.
- `test/docker.test.ts`: two added assertions (`until command eval`, the warning text) in the existing case; no existing line touched.
- `test/integration/docker.test.ts`: new `describe` block "docker integration: sandbox at its process limit" appended after the idle-timeout block (limit 24, idle 6 s, own helpers and `fork-N` names), two cases (dash on `cfg.docker.images.generic`, busybox on `cfg.docker.probeImage`). Each prints `fork-pressure <shell>: warning after N ms`.
- `README.md`: one sub-bullet in the idle-stopping note under Limitations.

**Verification**
- `npm test`: 270 passed, 14 skipped (the 12 existing plus the 2 new Docker cases, skipped without the opt-in); `npm run typecheck` and `npm run build` clean.
- Negative control (sortie 01 script restored from `HEAD`, tests kept, change copied to a scratch directory outside the repo and copied back; `cmp` identical afterwards): both pressure cases failed.
  - dash: `exit code 2, OOMKilled false, state exited`; pressure exec `{"code":137,...}`; logs `watchdog: 25303: Cannot fork`; the warning never appeared (30036 ms wait).
  - busybox: `exit code 2, OOMKilled false, state exited`; pressure exec `{"code":137,...}`; logs `watchdog: line 0: can't fork: Resource temporarily unavailable`; no warning (30271 ms wait).
- Acceptance run, `--repeats 29` (30 runs) per shell, verbose reporter, one batch per shell:
  - dash: 30 runs, 30 passed, 30 per-run lines; warning after 960 to 3100 ms.
  - busybox: 30 runs, 30 passed, 30 per-run lines; warning after 967 to 4262 ms.
- Full Docker suite (`MCPE_DOCKER_TESTS=1 npx vitest run test/integration`, network available): 14 passed (12 existing unmodified plus the 2 new).

**Decisions**
- Used `--repeats 29` in one batch per shell (about 8 minutes each, under the command limit) instead of two batches of 14.
- The pressure case's failure path races the pressure exec against 15 s when the warning never appears, so diagnostics are built without hanging; the `finally` still awaits it.

**Deviations**: none from the leg's criteria.

**Anomalies**
- A first acceptance batch for dash (`--repeats 14`, default reporter) passed (15 runs, 233 s) but the default reporter hides passing tests' stdout, so no per-run lines or times were captured. It is not counted. All counted numbers above come from reruns with `--reporter=verbose`, which shows the lines. A second attempt to chain batches in a script was interrupted by a mistaken `pkill` that also killed my shell; its two leftover containers were removed by exact name. No pressure case failed after the negative control.

---

## Decisions
Runtime decisions not in original plan.

---

## Deviations
Departures from planned approach.

- **Pressure cases are opt-in** (2026-11-15)
  - Planned: the leg's regression criterion said "`npm run test:docker` passes in full: the 12 existing cases and the 2 new ones".
  - Actual: `npm run test:docker` runs the 12 existing cases and skips the 2 pressure cases by default; the 2 run via `npm run test:docker:pressure`.
  - Reason: the operator directed during review that the pressure cases are too slow for every review and should run only when the watchdog code is touched.

---

## Anomalies
Unexpected issues encountered.

---

## Session Notes

### 2026-11-15 — Planning

**Qualification**: sortie. One outcome (a sandbox at its process limit is not stopped), one decision cluster (how the container's main process survives a failed fork and what it does until it can fork again), one leg expected, no new subsystem. Not a squawk: it changes container lifecycle and needs a design decision. It builds on sortie 01's code, which is landed but unmerged, so it branches from that work.

**Charter agreed** by the operator. The operator was offered a simpler charter without the second criterion (a sandbox that once hit its limit would never idle-stop again until restarted) and chose to keep it. The operator was told that no fix approach had been tested yet and that whether the second criterion can be met without a busy loop is for design to establish by measurement.

**Starting evidence** (from the sortie 01 debrief, throwaway containers, shipped watchdog script):

| Setup | Result |
|-------|--------|
| dash, `--pids-limit 12`, limit filled once and then left alone | Watchdog survived: it frees one slot when its `sleep` ends and takes it back |
| busybox, same | Same |
| dash, `--pids-limit 16`, a process forking continuously for 12 s | Container stopped with exit code 2 within 2 s; watchdog stderr `Cannot fork` |
| busybox, contested | Not tested |

**Premise checks before design** (throwaway containers, removed afterwards; Docker 29.8.2, `--init --cap-drop ALL --pids-limit 16`). "Tight competitor" on dash is a perl loop forking continuously with short-lived children; on busybox it is four awk loops calling `system("sleep 1 &")`.

| Premise | Result |
|---------|--------|
| The shipped loop dies on a failed fork on busybox as well as dash | Confirmed: busybox container stopped with exit code 2, stderr `can't fork: Resource temporarily unavailable`. A first, weaker attempt at contention (host-driven `docker exec` loops, then a single awk loop) did not provoke a failure in the shipped loop; four awk loops did. |
| Wrapping the fork in `command eval '… &'` makes the failure non-fatal | Confirmed on both: dash survived 6 failed forks, busybox 12, container still running |
| A candidate that retries the fork until it succeeds keeps the sandbox up under pressure and still idle-stops afterwards | Confirmed on both: `.State.StartedAt` unchanged at the end of 8 s of pressure; idle-stopped with exit code 0 about 8–9 s later against a 6 s timeout and 1 s poll |
| How long the retrying lasts | dash against the tight competitor, 15 s: seven episodes of 0 to 2000 ms (about 5.3 s in total), roughly 25,000 failed forks per second, each ending when one of the competitor's children exited. Busybox against the awk loops, 15 s: four episodes of 10 ms or less. |
| Running the watchdog under `nice -n 19` keeps the retry loop from taking CPU from other work | **Refuted.** On a `--cpus 1` sandbox a nice-19 loop and a normal-priority loop each used about 5.0 s of CPU over 10 s. The CPU limit is a quota shared across the host's cores, not a single core, so the two never compete on one run queue and niceness has no effect. |
| The watchdog can be started through `nice` by an outer `sh -c` that execs it | Works on both images (niceness 19 read back from `/proc/$$/stat`), but pointless given the row above |

**Consequence**: in dash there is no builtin that waits for a time, so the only zero-CPU wait is `wait` on a child that was forked earlier, and children are exactly what cannot be created while the limit is contested. A design can therefore either keep retrying (a busy loop while the watchdog has no PID slot, which meets the "resumes" criterion always) or park on a pre-forked child (zero CPU, but it can only retry as many times as it has pre-forked children, after which the sandbox stays up until restarted). The charter asks for both "resumes" and "no busy loop that takes CPU from the build"; they cannot both hold in the worst case. Raised with the operator before design continues.

**One probe attempt failed mechanically** (reading per-process CPU from the host's `/proc`, which is not the containers' PID namespace here) and produced no data; replaced by the in-container measurement in the table.

**Operator decision**: retry until the fork succeeds (option A), over parking on a pre-forked child (option B). The charter constraint was reworded accordingly: the watchdog may busy-retry only while it holds no process slot.

**Further premise checks, with the reference script that goes into the spec** (same conditions; `--cpus 2`):

| Premise | Result |
|---------|--------|
| Quiet sandbox, 6 s timeout, 1 s poll, no pressure | Stopped with exit code 0 after 9 s on `buildpack-deps:stable` and on `alpine/git:latest`; no log output |
| 8 s of pressure, then quiet | `.State.StartedAt` unchanged at the end of the pressure on both; exactly one warning line in `docker logs` on both, and no other output; both then idle-stopped with exit code 0 |
| The project's probe image (`alpine/git:latest`) can serve as the busybox image | Confirmed: the script runs as its entrypoint, and busybox `awk` is available for pressure |
| Failed forks consume PID numbers | Confirmed: over the 8 s of pressure the sandbox's `ns_last_pid` went from 15 to 270,099 (dash) and 118,641 (busybox); `pid_max` 4,194,304. Includes the competitor's failed forks. |

**Not measured**: the fully-static case (every slot held by long-lived processes after the watchdog has lost its own). The spec marks it as inferred.

**Flight spec drafted** with every factual statement in the design decisions marked measured or inferred, per the sortie 01 debrief's second recommendation.

### 2026-11-15 — Design review, cycle 1

**Architect verdict**: approve with changes. The Architect reproduced the mechanism independently without Docker (dash under a per-user process limit): a failed fork inside `command eval` returns status 2, leaves `pid` as it was, and the shell survives; a backgrounded command that fails after a successful fork is not mistaken for starvation.

Accepted and folded into the spec:

| Finding | Severity | Resolution |
|---------|----------|------------|
| The branch plan was left "decided at execution" and conflicted with landing in pull request #1 | high | Decided: pull request #2 is merged into the sortie 01 branch first; sortie 02 branches from there and targets it. Recorded as a prerequisite that stops execution if unmet. Charter constraint reworded to say how the fix reaches pull request #1. |
| "The pressure reliably produces the warning" was unmeasured, and the tests and a divert rule rest on it | high | Measured (below). Deadline for the warning fixed at 30 s. |
| Test mechanics: shared `create()` helper would have to change; pressure must end itself; assert running as well as `StartedAt`; `restart: false`; process-limit headroom; busybox `timeout -k` | medium | Own `describe` block, config and helper; self-ending pressure; both assertions; limit 24; `timeout -k` measured on the probe image |
| The neighbouring restart-on-exec path that masks a stopped sandbox was not declared | medium | Added to State and Cache Declarations |
| "Each episode ended when a competitor's child exited" was presented as measured | medium | Marked inferred |
| Possible flood of host kernel-log lines from failed forks | medium | Measured: one line per container |
| "Holds no process slot" was imprecise; non-PID fork failures; the PID-counter attribution; which README bound applies | low | Reworded; added as inferred; marked inferred; the existing README bound is reused |

Not adopted: a Docker-free unit test of the `command eval` behavior using a per-user process limit. That limit counts every process the user owns and behaves differently for root, so the test would depend on the machine it runs on.

**Measurements made in response** (throwaway containers, removed afterwards):

| Premise | Result |
|---------|--------|
| Busybox `timeout` on `alpine/git:latest` accepts `-k` | Yes (exit 0) |
| Host kernel log under repeated pressure | "fork rejected by pids controller" lines went from 20 to 60 over 40 pressure runs: one per container |
| Dash, limit 24, one perl fork loop: runs in which the warning appeared | 20 of 20, in 995 to 3113 ms; all still running |
| Busybox, limit 24, four awk loops started by four separate execs | 19 of 20, in 1003 to 10086 ms. Five execs across the series were refused by Docker ("unable to spawn stage-1: Resource temporarily unavailable"). In the one miss the container was not running when checked 30 s later; its exit code was not captured. |
| Busybox, limit 24, six awk loops started by one exec | 30 of 30, in 1012 to 5161 ms; none stopped (exit codes recorded this time) |
| Busybox `timeout` and background children | It kills only its direct child: awk loops backgrounded by a wrapping `sh` survived a 4 s limit and were still using the sandbox's full 2 CPUs 52 s later. Sandbox still running, one warning line, memory between 4 and 49 MiB with no steady trend. |
| Dash, every one of 16 slots held by 70 s sleepers after a 5 s contest, competitor asleep | CPU 104%, 104%, 105%, 106% at 12, 27, 42 and 57 s; memory 22.7, 28.2, 24.2, 40.7 MiB; one warning line; running. About 25 s after the sleepers exited: 0.1% CPU, 1.6 MiB, 3 processes, running. |
| The exact test recipe (limit 24, self-ending 8 s pressure from one exec wrapped in `timeout -k 5 30`), three runs per shell | All six: one warning line, running with unchanged start time after the pressure, idle-stopped with exit code 0 13 s later |

An earlier attempt at the fully packed case killed its own sleepers (GNU `timeout` signals the whole process group) and measured nothing on dash; the row above is the corrected run.

### 2026-11-15 — Design review, cycle 2 (final)

**Architect verdict**: approve with changes; mechanism and test design sound. It confirmed by reading that the reference script differs from the shipped `WATCHDOG_SCRIPT` only in the ways the spec describes and that sortie 01's unit assertions would still pass against it. This was the second of the two permitted cycles. Its findings were about claims worded more strongly than their measurements, one reliability gap, and two plan gaps; none changed a design decision, so the revisions below went to the operator without a third pass.

| Finding | Severity | Resolution |
|---------|----------|------------|
| "No steady trend" in memory said more than four samples can show; busybox figure was whole-sandbox memory dominated by the pressure loops | medium | DD2 now quotes the samples and what they cannot show, and adds the one thing the data does support: the sandbox's footprint after about a minute of retrying (1.6 MiB, 3 processes) matched a watchdog that had barely retried, so the shell kept no memory. The watchdog's memory *while* retrying is listed as not measured. |
| "Keeps its own slot, so no retry" was measured only with the shipped script | medium | Split into measured (shipped script) and inferred (new script, and the mechanism) |
| `alpine:latest` cited for the reference script, which was only run on `alpine/git:latest` | medium | Corrected |
| The unexplained busybox stop: honestly labelled but the design leaned on 30 clean runs as if that settled it | medium | Statistical limit stated; "still running" check times stated; the leg must run each pressure case 30 times and capture exit code, `OOMKilled` and logs on failure; an intermittent failure is a divert that reopens DD1 |
| Prerequisite did not say to branch from the fetched remote ref, and ignored the uncommitted sortie 01 debrief artifacts | low/medium | Both added as prerequisites; the debrief commit needs the operator's go-ahead |
| Test mechanics: no log helper, stderr, not asserting on the pressure exec's result, awaiting it on every path, `${` escaping | low | Added to Technical Approach |
| Unmarked or imprecise statements (busybox "tens of thousands", the `nice` cause, the option B description, "13 s later", recipe typed by hand) | low | Marked or reworded |

**Correction to an earlier log entry**: the "still running" notes in the 20-run and 30-run reliability series were read immediately after the warning appeared (or after 30 s on the one miss), not after the pressure had ended.

**Spec approved by the operator** (2026-11-15), status set to `ready`. Gate re-check: still one decision cluster and one leg. At approval the operator directed that all of this work be pulled into one branch and executed there: the squawk turnaround merged into the sortie 01 branch, the sortie 01 debrief committed there, and this flight run on that branch with no branch or pull request of its own. The prerequisites in the spec were replaced accordingly.

### 2026-11-15 — Execution

### Flight Director Notes

- **Branch consolidation, at the operator's direction**: `sortie/01-sandbox-idle-timeout` was fast-forwarded to include the squawk turnaround (`7cb69fd`; pull request #2 shows as merged), and the sortie 01 debrief was committed there (`dbc3306`) and pushed. This flight runs on that branch. No `sortie/02-…` branch is created and no separate pull request will be opened; pull request #1 carries everything.
- **Phase file**: `.flightops/agent-crews/leg-execution.md`, valid; Developer and Reviewer on Sonnet.
- **Start state**: flight `ready`, no legs started; set to `in-flight`. One leg, no HAT leg.
- **Leg 01 `fork-failure-guard` designed**: `legs/01-fork-failure-guard.md`, citations checked against the working tree. It carries two things beyond the flight spec's test design: a negative control (the pressure cases must fail against sortie 01's script) and a run-count knob so the 30-run acceptance run can be repeated by the Reviewer.
- **Named risks, and where each ended up** (per the sortie 01 debrief: a named risk is a criterion or logged debt, never optional): the unexplained busybox stop → acceptance run of 30 per shell plus a blocker rule; pressure that never bites → the warning-line gate and the negative control; the busy loop while starved → accepted by the operator, documented in the README criterion; long-duration memory behavior, other shells, non-PID fork failures, gVisor → accepted as not verified, listed in the flight spec.
- **Risk tier: high.** It changes the sandbox's main process and container lifecycle, on a security-sensitive surface, and it fixes a defect that an earlier review cycle missed. Design review by a Developer before implementation.
- **Leg 01 design review** (Developer, read-only): approve with changes; the design and citations checked out, the gaps were in executable detail. Folded into the leg:
  - *high* — the pressure commands were written as shell one-liners, but `Docker.exec` passes an argv with no shell; written literally, the busybox program's escaped quotes would have collapsed inside a JavaScript string and broken the awk program. The leg now gives each program as one argv element with no backslashes.
  - *high* — vitest's `repeats: n` means n + 1 runs, does not stop at a failed run, and reports one result for all runs. The leg now says so, uses the built-in `--repeats` flag in batches, and has each run print its own line.
  - *medium* — the Flight Director's own summary of the script change omitted the per-poll `starved=0`. A developer following only that summary would have built a watchdog that never idles again after one starved poll. Added as a criterion.
  - *medium* — the pressure promise could reject unhandled; the negative control used `git stash`, which can strand the change; and the control proved "fails", not "fails because the container died". All three reworked.
  - *low* — case counts confirmed (12 before, 14 after); the new block can be a pure append.
- **No second design-review pass**: the changes are the reviewer's own fixes to mechanics and one omission restored from the flight spec's reference script. No design decision or acceptance intent changed. Leg 01 set to `ready`.
- **Spawning the implementing Developer** (Sonnet) with the crew file's Implement prompt.
- **Leg 01 landed** (`[LAND:leg]` from the Developer): negative control failed as intended on both shells (container exited with code 2, no warning line), then 30 of 30 runs passed per shell. Flight Director spot check before review: on the right branch; `npm test` 270 passed / 14 skipped; typecheck clean; test diffs are additions only (0 removed lines in the integration file, 2 added assertions in the unit file); no `mcpe-it-` containers or volumes left; no stray vitest processes.
- **Observation, not attributed**: two operator sandboxes that were present earlier in the session (created by the operator's installed server, not by this work) are no longer present, containers and volumes both. That pattern matches an uninstall through the server rather than a stray container removal, and the Developer reports removing only its own two test containers by exact name; Docker's event history no longer reaches back far enough to confirm either way. Reported to the operator.
- **Spawning the Reviewer** (Sonnet) with the crew file's Review prompt. It is asked to re-run the suites and a batch of repeated pressure runs itself.
- **Operator instruction during review** (2026-11-15): the pressure tests are too slow to be part of every review; they are to run only when the watchdog code is touched. Flight Director's reading and plan: (1) the review in progress keeps its pressure runs, because this flight is exactly a change to that code; (2) so that later reviews and ordinary runs of the Docker suite do not pay for them, the two pressure cases become opt-in on their own switch, skipped by default, with the README's Development section saying when to run them; (3) from now on a Reviewer is asked for pressure runs only when the watchdog script or its tests are in the diff. Item 2 changes one of the leg's regression criteria ("`npm run test:docker` passes in full: the 12 existing cases and the 2 new ones" becomes 12 run and 2 skipped by default, 2 run on request). The leg is already `landed` and is not edited; the change is made as a post-review fix and recorded under Deviations when done. It waits until the Reviewer has finished, since the Reviewer is running tests from the same working tree.
- **Code review gate, cycle 1**: the Reviewer signalled `[HANDOFF:confirmed]`, no blocking issues. It re-ran things itself: `npm test` 270 passed / 14 skipped, typecheck and build clean, full Docker suite 14 passed in 183 s, and 10 repeated runs of each pressure case, 10 of 10 on both shells (warning after 949 to 2159 ms on dash, 961 to 2231 ms on busybox). It read the emitted script and checked it with `dash -n`. It could not reproduce the negative control (read-only review) or the 30-run counts; those stand on the Developer's record. Non-blocking: stale flight status and log summary (updated at close); an empty temp directory left outside the repository by the Developer's interrupted run (removed by the Flight Director; no containers or volumes were left).
- **Finding about the test names**: the Debian case's name contains `(dash)`, which vitest's `-t` treats as a regular-expression group, so `-t "<exact case name>"` matches nothing and reports every case skipped. The Reviewer hit this and adjusted. Carried into the fix below, so the documented command for running the pressure cases cannot silently run nothing.
- **Post-review fix, on the operator's instruction**: spawning a Developer (Sonnet) to make the two pressure cases opt-in on their own switch and document when to run them, followed by a review scoped to that change.
- **Post-review fix made** (Developer): gated the pressure `describe` block on `MCPE_DOCKER_TESTS=1` and `MCPE_PRESSURE_TESTS=1` (comment updated); added `test:docker:pressure` to `package.json` using `-t 'under fork pressure'` (a phrase in both case names with no regex metacharacters); documented it in the README's Development section. Results: `npm test` 270 passed, 14 skipped; `npm run typecheck` clean; `npm run test:docker:pressure` 2 passed, 12 skipped (33 s); `npm run test:docker` 12 passed, 2 skipped (141 s).
- **Code review gate, cycle 2** (scoped to the opt-in fix): `[HANDOFF:confirmed]`, no issues. The Reviewer checked the gate in each direction (pressure switch alone: 14 skipped; Docker switch alone with the pressure filter: 0 passed, 14 skipped; both: 2 passed, 12 skipped in 31 s), confirmed the filter phrase matches only the two cases, and ran `npm test` (270 passed, 14 skipped) and typecheck. Per the operator's instruction it ran the pressure cases once, did not repeat them, and did not run the full Docker suite; the Developer's run of that suite after the fix (12 passed, 2 skipped, 141 s) is the record for it.
- **Completion**: leg 01 set to `completed` with its criteria checked off (one regression criterion is met in the changed form recorded under Deviations); leg entry status in this log updated to match; flight checkpoints and leg checked off; flight status set to `landed`. Charter criteria are left for the debrief. Project docs: README updated in the leg and the fix; nothing here belongs in `CLAUDE.md`.
- **Standing instruction from the operator, for later flights**: the fork-pressure cases are run only when the watchdog script or its tests are in the diff. `npm run test:docker:pressure` runs them; the default Docker suite skips them.
- **Commit scope**: `src/sandbox/docker.ts`, `test/docker.test.ts`, `test/integration/docker.test.ts`, `package.json`, `README.md` and `sorties/02-watchdog-survives-fork-failure/`, on `sortie/01-sandbox-idle-timeout`. No new pull request; pull request #1 carries it. `.flightops/` and `CLAUDE.md` remain untracked.

### Flight completion — 2026-11-15

**Status**: landed. One of one legs completed. One deviation (pressure cases opt-in, on the operator's instruction); anomalies as recorded by the Developer (an uncounted first batch, an interrupted run cleaned up). A sandbox at its process limit now keeps its watchdog: verified by a negative control on both shells, 30 of 30 runs per shell by the Developer and 10 of 10 per shell by the Reviewer. Those runs bound the failure rate at roughly 10%; they do not rule out a rare failure.
