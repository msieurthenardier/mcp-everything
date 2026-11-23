# Flight Debrief: Contained Network and Isolation Runtime

**Date**: 2026-11-23
**Flight**: [Contained Network and Isolation Runtime](flight.md)
**Status**: completed
**Duration**: 2026-11-22 (planning) – 2026-11-23
**Legs Completed**: 15 of 15 (fourteen autonomous and the HAT; planned at 11, plus legs 13 and 14 added from CI findings, and two splits at design review)
**Plugin version**: mission-control 1.2.4

## Outcome Assessment

### Objectives Achieved
An operator can now contain every network mcp-everything gives a repository, with one switch, and require a stronger isolation runtime:
- **`MCPE_NETWORK=contained`.** Each project, clone and networked scanner gets an `--internal` Docker network of its own, with an isolated gateway that is checked after creation and no IPv6. The only way out is a proxy of mcp-everything's own (`src/network/proxy/proxy.cjs`, run read-only, as `node`, with no capabilities). The proxy:
  - resolves names itself and connects only to the addresses it checked;
  - refuses host, local and link-local addresses;
  - allows only the build system's sites, the project's added hosts and the operator's exact local-access pairs.
- **Three network states** (off, contained, open) without a registry `version` bump:
  - every exec and start passes through one containment hook;
  - existing sandboxes are contained at startup and never loosened;
  - a per-project lock serializes replacements across sessions.
- **Agent tools.**
  - `set_project_network` contains rather than opens.
  - `hosts` on install and `set_project_hosts` change a project's hosts without a reinstall.
  - Refusals are reported with an advisory hint that does not invite the agent to allow a host because a tool's output asks.
- **The operator's local access** (`MCPE_LOCAL_ACCESS`): a host name and port per repository, reached only by that repository.
- **The isolation runtime.** Naming one in `MCPE_DOCKER_RUNTIME` is requiring it: it is checked by `docker info` and a trial container before anything starts, and a sandbox made under another runtime is refused with "reinstall".
- **Proven on Linux in CI** (`docker-gvisor.yml`, advisory):
  - **`gvisor`:** under `runsc` the whole Docker suite gives 65 passed and 3 skipped with named causes, and a runtime proof shows every container mcp-everything starts runs under gVisor;
  - **`contained-linux`:** containment under `runc` on native Linux, 31 of 31.
- **README**: containment, what it allows and how to change it, local access, the runtime (including gVisor's `--overlay2=none` requirement and its limits), Trivy's measured hosts, and the standing gaps.

The HAT on the operator's own installation passed steps 1–5 and 7 (6 skipped as covered):
- Trivy ran under containment with only `mirror.gcr.io` and `ghcr.io`.
- A refused host was allowed with `set_project_hosts` and worked at once.
- A real Node project (`morluto/rea`) installed contained.
- The operator **stays contained**.

### Mission Criteria Advanced
| Mission criterion | This flight |
|---|---|
| Nothing configured: as today, and the agent is told | **Met**: the instructions state "not contained", how to turn containment on, and the runtime truthfully |
| Containment from the environment; clone, build and sandbox each reach only what they need; the agent adds hosts but not local addresses | **Met, with two standing gaps.** Sandboxes made before ownership labels, and labelled sandboxes with no record, are never contained (documented in the README) |
| With containment on, registry-only builds install as today; a refused host is named with how to allow it | **Met.** One weakness: a build refused its registry (npm) retries until the install timeout (600 s) before reporting |
| A named stronger runtime is used for everything and can be required | **Met** and proven under gVisor in CI |
| README (flight 2's part) | **Met** |

## What Went Well
- **The core architecture held.** DD1 (one switch), DD3 (an isolated-gateway network, judged by inspecting what Docker made rather than by its version), DD4 (our own proxy), DD5/DD6 (host tables, agent hosts), DD7 (three states without a registry bump), DD9, DD10, DD11, DD12 and DD15 shipped as designed. The layering `Containment` (policy) over `Docker` (primitives), with one `ensureContained` hook every exec and start passes, and `test/docker-bypass.test.ts` pinning every unhooked caller, is the pattern to carry forward.
- **Security catches at design review**, before code: the trailing dot and hex shorthand in the host grammar, pipelining on the proxy, sweep role collisions, twin sandboxes, and refusal hints as an injection channel (leg 9, made advisory).
- **Trials were the method.**
  - T1–T13 at planning, and T14–T18 during the flight, each a throwaway on the operator's Docker and removed.
  - T17 (create a proxy with a fixed IP and MAC) and T18 (a reconnect loses the MAC) settled leg 14's design in two commands each.
  - Mutation trials (weaken the code, confirm a test fails, restore) caught real gaps. Leg 13's review found one uncaught; leg 14's review caught 8 of 9.
- **CI found what no local run could.** Asking to prove gVisor in CI ("if we are going to advertise gvisor we should probably prove it works") paid for itself: the first full run showed containment and gVisor did not work together as built (21 failures). Two legs later both work, proven.
- **The Docker gate held for fifteen legs.**
  - The Flight Director read every new destructive case before its first run.
  - The operator's containers kept their ids throughout.
  - Volume lists were diffed before and after every run.
  - Leaks were found the same day and fixed: the one-shot `rm -f`, the test helpers and `rmContainer` all moved to `-v`. Runs since leave nothing.
- **Scope control.** Destructive housekeeping (orphan proxies and networks, stale locks) was moved out of the startup pass at leg 10's review into squawk 0052, keeping the containment pass about containment.
- **The HAT found a real problem of the operator's**, unrelated to this flight's code. The operator's other installation had likely removed `mcpe-rea` (see Technical). Reinstalling it under containment doubled as the contained-install step.

## What Could Be Improved

### Process
- **gVisor was a design variable, and planning treated it as a CI checkbox.**
  - DD2's proxy alias rested on Docker's embedded DNS (`127.0.0.11`) and on hot-plugging the network into a running sandbox. Both were trialled only under runc on Docker Desktop, which cannot run `runsc`.
  - Under gVisor, embedded DNS does not answer, a hot-plugged NIC is unseen, and the neighbor cache keeps a swapped proxy's old MAC.
  - The first full gVisor run came at leg 12, after nine legs of runc-only design. It cost two added legs (13 and 14), two CI rounds of about 15 minutes each, and three rewrites of the replacement path.
  - Leg 4's measurement workflow already ran on native Linux. Installing `runsc` there and probing alias resolution, a NIC hot-plug and a proxy swap would have caught all of it before the design froze. The pre-flight named "Docker Desktop cannot run runsc" but did not schedule a trial on an environment that could.
- **The leg count grew from 11 to 15.**
  - Two splits at design review were sound: `linux-measurements` out of `contained-networks`, and `project-network-primitives` + `containment-hook` out of `project-proxy-lifecycle`.
  - The two added legs were the trial gap above, not leg shape. Each was well sized (one concern) once added.
  - The flight 01 recommendation (one leg per kind of risk) was followed and held.
- **A full green Docker run was owed from leg to leg.** Leg 5's run was settled only at leg 7, which weakened the per-leg gate. The suite's length (up to 1,081 s at leg 10) is why.
- **A background wait loop ran for 7 h 46 min.** A Developer's `while pgrep -f 'vitest run test/integration' …; do sleep 15; done` matched its own command line and never ended, which kept an agent's task "waiting". The operator spotted it. Crew prompts since require bounded waits that do not match themselves.
- **Developers kept reaching for heredocs and shell edits** against the Edit/Write-only rule. They were harmless or denied by the classifier, but repeated across legs. One trial restore left a dropped space, found by reading the line.
- **Five-plus writers on one flight log.** It worked, by ordering and the Edit tool's stale-file refusal, but the log is now over 1,300 lines and the debrief interviews read it only partly.

### Technical
- **`src/sandbox/docker.ts` is 2,895 lines** (+1,716 this flight). It now carries:
  - sandbox lifecycle and one-shots;
  - project network and proxy primitives (probe-then-pin, fixed IP and MAC, detach, create, restore);
  - local-access writing;
  - the runtime assertion and the runc/non-runc branches;
  - ownership classification.

  `src/network/containment.ts` (1,246) mixes the lock scheme with replacement and repair. Both want a mechanical, behavior-preserving split before the next flight touches them.

  | File | Before | After |
  |---|---|---|
  | `src/sandbox/docker.ts` | 1179 | 2895 |
  | `src/server.ts` | 1266 | 1641 |
  | `src/install/installer.ts` | 1231 | 1384 |
  | `src/network/` (new) | — | 3404, of which `proxy/proxy.cjs` 1378 and `containment.ts` 1246 |
  | `test/docker.test.ts` | 2038 | 5985 |
  | `test/integration/docker.test.ts` | 1563 | 3063 |
- **Runtime-dependent behavior in one code path.**
  - `isRuncRuntime`, `whileStopped` (stop, attach, start) and the rollback's `restartAfterRestore` behave differently under gVisor.
  - Only the advisory CI job exercises them for real; runc-only developers get no local signal.
  - T14 is skipped under runsc, because runsc cannot clean up a failed start.
- **`RESTART_AFTER_SWAP` is dormant.** CI showed the fixed MAC is enough, so the switch, `restartForSwap` and the public `restartSandbox`'s swap use are permanent surface with "the switch is off" tests. Delete it, or document it as a supported option.
- **The lock-file scheme is bespoke concurrency in a security path.**
  - It works like this: a lock file under the data directory, a 90 s deadline, stale takeover by rename then mtime check then an exclusive `link` put-back, and release only after `fn` settles.
  - It took two review rounds, and leaves crash leftovers (squawk 0052 items 3–4).
  - It is correct under its tests. Revisit with a simpler arbiter (Docker's own name uniqueness is already used elsewhere), or give it one contract test file.
- **Source-scan tests are brittle.**
  - Tests that scan the source for `--alias`, `mcpe-proxy` and `--ip` counts were rewritten in both leg 13 and leg 14.
  - Several test bugs surfaced only on real Docker: `eth1` versus `eth0`, a stale registry record, and `.internal` refused by `parseHostEntry`. Assertions were written before real output was observed.
  - Prefer behavioral fakes, and observe once on Docker before pinning.
- **One untested branch:** a failed `docker stop` in `whileStopped`. The code throws correctly, but no test pins it; it was the one mutation leg 14's review could not make fail.
- **The `before` ownership class is unsafe with more than one installation.**
  - A sandbox with the generic label and no owner is treated as its own by *every* installation.
  - This is the likely way the operator's other installation (`bde0aedf`, on Windows against the same Docker Desktop) removed `mcpe-rea` at 07:50 on the HAT day. That is a **data-loss path**, not only a containment gap.
  - Such sandboxes are also never contained (the operator's `gron`).
  - The operator chose not to squawk it. It needs a design decision (explicit claim or adopt, removal only with ownership evidence) and belongs in a sortie or the next flight's first leg, **not** in squawks 0052/0053.
- **npm floods a refused registry.** About 3.1M refused CONNECTs in 11 minutes in leg 8's case.
  - The refusal record is bounded (one row per host with a count), but the install runs to its 600 s timeout.
  - Two designs: proxy-side backoff, which is local and helps every client; or an installer early stop, which is a lifecycle and policy change.
  - Lead with proxy backoff. A sortie, as recommended at the HAT.
- **gVisor needs `--overlay2=none`.** gVisor's default root overlay discards the container layer when a sandbox stops, losing build output outside volumes. CI registers `runsc` with `--overlay2=none`, the README requires it, and startup warns. This is a real operator burden.

### Documentation
- **The README covers the operator-facing design:** proxy by address, gVisor's limits, `--overlay2=none`, Trivy's measured hosts, and the standing gaps. Not written down anywhere a Developer reads:
  - the runc/runsc behavior table (below);
  - probe-then-pin;
  - the Docker gate's bypass-test rule;
  - the mutation-trial discipline.
- **The Java DB download of Trivy was not exercised** by the HAT's runs. Its registries are the same per Trivy's defaults; the README says so.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Proxy reached by fixed IP and `/etc/hosts`, not an alias (leg 13) | Docker's embedded DNS does not answer under gVisor | Yes: never rely on embedded DNS for something a sandbox must reach |
| Probe-then-pin subnet, proxy at the last usable host, `--ip-range` lower half | Needed a known address before the proxy exists | Yes, for any Docker-assigned identity a sandbox must carry |
| Fixed proxy MAC per network; stop–attach–start for a running non-runc sandbox (leg 14) | A gVisor NIC hot-plug is unseen; its neighbor cache goes stale after a swap | Yes under non-runc runtimes; T17/T18 are the evidence |
| Rollback restarts a running non-runc sandbox (T18) | A reconnect gives the proxy a new random MAC; no Docker option keeps it | Yes |
| Replacement became detach, create, check, remove-old, with rollback | No overlap of two proxies at one fixed address | Yes; `assertLive` between detach and create |
| Housekeeping moved to squawk 0052 (leg 10) | Destructive cleanup has its own races | Yes: keep the containment pass to containment |
| `MCPE_LOCAL_ACCESS` and agent hosts are names only | A contained sandbox can dial only names that resolve to its proxy | Accepted limit; revisit if operators need IP-only services |
| Criterion amended: an online sandbox also reaches its registries (DD6) | Operator, 2026-11-22 | Yes |
| `--overlay2=none` required for runsc | gVisor's root overlay discards writes outside volumes | Yes, documented and warned |
| T14 skipped under runsc | runsc cannot clean up a failed start (stale containerd task) | Yes, with its cause named in the test |
| The gVisor job is advisory, PR trigger narrowed | Operator's choice at the HAT; ~15 min per run | Revisit: add a scheduled run to catch runsc/Docker drift |

## Key Learnings
- **Treat the isolation runtime as a design variable from day one.** Anything touching DNS, network hot-plug, overlay state or process lifetime needs a runsc column in the trial table. Known gVisor facts from this flight:
  - embedded DNS is unavailable;
  - a hot-plugged NIC is unseen;
  - the neighbor cache is stale after a swap;
  - `/sys/class/net` is empty (use `/proc/net/dev`);
  - the root overlay discards the container layer without `--overlay2=none`;
  - a failed start leaves a stale containerd task.
- **Trial on the environment that ships.** A Docker Desktop trial proved runc behavior and nothing about runsc. The environment named as unavailable in the pre-flight should have become the first measurement leg.
- **Check what Docker made, not what its version says** (DD3). The same principle carried probe-then-pin and the gateway check.
- **A wait loop must not be able to match itself.** `pgrep -f '<pattern>'` inside a shell whose command line contains the pattern never ends. Wait on a PID, use `'[v]itest'`, and always bound the wait.
- **Ownership by absence is ownership by everyone.** "No owner label" was read as "mine" by every installation; with two installations on one daemon, that is a removal path.

## Methodology Observations
- **Flight skill, Pre-Flight prerequisites (1.2.4).** The pre-flight correctly named "Docker Desktop cannot run `runsc`" and put native Linux in CI, but nothing in the skill turns an unavailable target environment into a trial gate before design decisions lock. The flight designed nine legs on runc evidence for a feature whose headline is gVisor. Expected: the skill's "a DD that rests on an empirical premise should have that premise verified before it's locked" to say *on the environment the feature targets*, and Pre-Flight to stop when that environment is unavailable for trials. Cost: two added legs, two CI rounds, three rewrites of the replacement path.
- **Agentic-workflow, leg cycle (1.2.4).** Crew background waits are unbounded by default. One self-matching `pgrep` loop ran for 7 h 46 min and kept an agent "waiting on background work"; the operator found it. Expected: the crew prompts to require bounded waits that cannot match themselves. Cost: one agent's slot for most of a day; no work lost. Fixed for this flight by the Flight Director's prompts after the discovery.
- **Agentic-workflow, Developer rules (1.2.4).** The project's "edit only with Read/Edit/Write" rule was restated in every spawn, and Developers still attempted heredocs and shell edits in several legs: harmless, or denied by the classifier. Expected: no attempts. Cost: small, but repeated; recorded for the sweep.
- **Agentic-workflow, leg added mid-flight (1.2.4).** Legs 13 and 14 were added after CI results, with the HAT renumbered twice. The skill covers adding legs, but not a leg added *after* the flight's code was committed and reviewed (a fix leg after a red CI run). The Flight Director improvised: design, implement, diff review, fix commit. It worked; the flow is not written down.
- **Flight-debrief skill, crew interview (1.2.4).** As in flight 01, the Developer interview read the flight log only partly (it is over 1,300 lines) and reported two items already settled: the volume leak was fixed, and the README does document the design. Corrected by the Flight Director. Expected: a log this size needs a summary the interviews can read first.
- **Squawk skill, log (1.2.4).** The operator chose "npm floods a refused registry" as a squawk at the HAT, and the qualification gate correctly refused it (a design choice and a lifecycle change). The gate worked. Recorded because the HAT's multi-select offered it as a squawk candidate before qualifying it: the Flight Director should qualify before offering.

## Recommendations
1. **Fix the `before` ownership class before anything else touches ownership** (sortie, or the next flight's first leg). Decide whether a sandbox made before ownership labels is ever removable or containable without an explicit operator claim. Make removal require ownership evidence (the registry record naming this installation, or a one-time adopt step). Until then, no sweep, startup pass or install path should remove a `before` object. This is a data-loss path that was likely hit on the operator's machine during this flight.
2. **Split `src/sandbox/docker.ts` and `src/network/containment.ts` mechanically**, with no behavior change and no test edited beyond imports. Split `docker.ts` into network/proxy primitives, runtime, ownership and sandbox lifecycle; take the lock scheme out of `containment.ts`. Do this before the next flight in this area.
3. **Plan the refused-registry slowness as a sortie.** Lead with proxy-side backoff on repeated refusals of one host; add an installer early stop only if builds still run to their timeout.
4. **Make the runtime a trial column.** For any future network, runtime or state work, the first measurement leg installs `runsc` on the Linux runner and runs the trials there before design decisions lock. Also add a scheduled weekly run of `docker-gvisor.yml` so drift in runsc or Docker shows up without a PR.
5. **Bring the unit suite back under control** (flight 01's recommendation, still open, now 17.4 s). Move the real-socket `test/proxy-server.test.ts` (17.1 s, new) and the real-shell walk cases in `test/docker.test.ts` into a tagged or separate project, so the default run is fast and the slow ones run in CI.

## Action Items
- [ ] Sortie: the `before` ownership class (recommendation 1). The operator's `gron` keeps the exposure until then.
- [ ] Sortie: refused-registry backoff (recommendation 3).
- [ ] Next flight in this area: the mechanical split of `docker.ts` / `containment.ts` as its first leg.
- [ ] Squawk 0054: a unit test where `docker stop` fails in `whileStopped` and nothing is attached or started.
- [ ] Squawk 0055: delete the dormant `RESTART_AFTER_SWAP` fallback (`restartForSwap` and its tests; `restartSandbox` stays for the T18 rollback), now that CI shows the fixed MAC suffices.
- [ ] Squawk 0056: split the two statements sharing a line in `test/docker-bypass.test.ts` (`whileStopped` callers).
- [ ] Squawk 0052 (housekeeping) and 0053 (nine leftover test volumes, removal needs the operator's OK): next turnaround.
- [ ] Squawk 0051: still deferred from flight 01; refresh its evidence at the next turnaround.
- [ ] The operator: rea's MCP server now offers 263 tools, so none are published individually (28 CLI tools are); publish a subset with `select_project_tools` if wanted. That tool-limit policy predates this flight.

## Test Metrics
Measured on the flight branch at `7896fd2`, one run.
- **Unit suite** (`npx vitest run`): 38 files passed, 2 skipped (the Docker-gated files). 2751 passed, 71 skipped, 0 failed; 17.40 s (vitest). No flake on this run.
  - Against flight 01: 1511 passed, 37 skipped, 13.35 s. That is +1,240 tests and +4 s.
  - Against mission 02 flight 01: 833 tests, 1.78 s.
- **Per file** (files run in parallel workers; the suite is now bound by its longest file):

  | File | Tests | Time | Flight 01 |
  |---|---|---|---|
  | `proxy-server.test.ts` (new: spawns the real proxy, real sockets) | 94 | 17.1 s | — |
  | `docker.test.ts` | 725 | 15.6 s | 300, 12.7 s |
  | `server.test.ts` | 236 | 1.7 s | 215, 1.64 s |
  | `scan-sarif.test.ts` | 31 | 1.55 s | 1.03 s |
  | `proxy.test.ts` | 92 | 1.3 s | 89, 1.04 s |
  | `installer.test.ts` | 209 | 0.8 s | 161, 0.40 s |
  | `containment.test.ts` (new) | 129 | 0.59 s | — |
  | `network-tools.test.ts` (new) | 75 | 0.36 s | — |

  Skips: `test/integration/docker.test.ts` 68 and `test/integration/gvisor.test.ts` 3, all gated, as expected.
- **Docker suite, local** (`npm run test:docker`, Docker Desktop):

  | Run | Result | Duration |
  |---|---|---|
  | leg 5 | — | 293.8 s |
  | leg 7 | — | 355 s |
  | leg 10 | 64 passed, 2 skipped | 1081 s |
  | after shortening leg 8's refused-host case | — | about 650 s |
  | leg 14 | 65 passed, 1 failed (a stale assertion, fixed and re-run alone), 5 skipped | 646 s |

  Against flight 01's baseline (about 280 s, 35 cases) it is about 2.3× for about 30 more cases. Each contained case builds a project network, proxy and sandbox. The leg 10 spike was leg 8's refused-registry case running to npm's 600 s timeout.
- **Docker suite, CI** (`docker-gvisor.yml` on `3cba097`; the first CI timings in this project's debriefs):
  - `gvisor` Run A: 65 passed, 3 skipped, 590 s. Run B: 3 of 3, 27 s.
  - `contained-linux` (runc): 31 passed, 276 s.
- **Typecheck**: clean. **Build**: clean.
