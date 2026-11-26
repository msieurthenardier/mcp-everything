# Mission Debrief: Vetted and Contained Installs

**Date**: 2026-11-25
**Mission**: [Vetted and Contained Installs](mission.md)
**Status**: completed
**Duration**: 2026-11-21 – 2026-11-25. Drafted, checked for viability and approved on 2026-11-21. Five flights, merged as #27, #30, #31, #33 and #34, with one squawk turnaround (#32) between flights 3 and 4.
**Flights Completed**: 5 of 5. The tentative list had four. The original flight 3 was split in two at its planning, and the README move, the code split and the old-sandbox fix were split out of flight 4 into a flight of their own.
**Plugin version**: mission-control 1.2.4 throughout

Each flight's debrief holds its own detail, test numbers and evidence. What this debrief adds:
- the outcome against the mission's own sentence, criteria and constraints;
- the Architect's reading of the system across the five flights;
- the operator's decisions at this debrief;
- the methodology findings counted across flights.

## Outcome Assessment

### Success Criteria Results

| # | Criterion (abridged) | Status | Notes |
|---|---|---|---|
| 1 | Out of the box nothing changes, and the agent is told: scanning, scanners, containment and runtime always visible | Met | The server's instructions, every install result, `project_info` and the `security:` line state each, off by default (flight 1 for scanning; flight 2 for containment and the runtime). Cosmetic gap: `network: unknown` for a sandbox made before ownership (squawk 0061). |
| 2 | The operator turns scanning on and adds scanners from the environment; the agent cannot change scanners or policy | Met | `MCPE_SCAN`, `MCPE_SCAN_BLOCK_AT`, `MCPE_SCAN_TIMEOUT` and `MCPE_SCANNERS` only; no tool parameter reaches them (flight 1 DD1–DD2). The scanners file gained `entrypoint` (flight 1's HAT) and `stage` (flight 5). Soft spot, documented: sessions with different scan modes share one registry, last writer wins (flight 3). |
| 3 | Checked before any code runs; scanners reported; under block, not built, and an installed project left working; a failed scanner never blocks | Met for the check before the build; **carve-out** for the check after it | The check runs on a staging clone before anything of an installed project is touched, and the build runs on exactly the checked bytes (flight 1 DD6). A blocked reinstall leaves the old project working with one warning. **Carve-out (flight 5 DD6, operator's choice):** a block by a build-stage scanner on a reinstall cannot keep the old version, because it was replaced before the build. The project is left `failed` and held until reinstalled, and the result says so. |
| 4 | With no scanner of the operator's own: the list of what the build will run, and, for GitHub, known-vulnerable or malicious dependencies | Met | `build-hooks` (flight 1) and `dependencies` (GitHub's graph against OSV, flight 3). At flight 3's HAT, NodeGoat gave `MAL-2023-462`. A pinned ref or another forge is `not-run`, and version ranges are counted, not looked up (`incomplete`); all documented. |
| 5 | Check without installing; the same findings; nothing runs | Met | `check_project` (flight 1 DD7, `dependencies` from flight 3); it works with scanning off. Its findings are the source stage's. It says that build-stage scanners and tool-descriptions did not run, since nothing was built. |
| 6 | What a build installed, and generated tool descriptions, checked before they are published | Met, with one **fail-open gap** to fix | Tool descriptions are checked after every discovery path (flight 3 DD6), and flagged tools are withheld through one accessor (flight 4). Build output is checked by a `"stage": "build"` scanner before discovery, and a block holds the project (flight 5). **Gap:** if the check after the build *errors*, rather than finds something, the project is `failed` but not held, so `discover_tools` could publish unchecked output. The operator chose to fix it (Decisions at this debrief). |
| 7 | With containment on, no clone, build or sandbox reaches the host, the local network or link-local, whatever its network setting, except operator-allowed addresses; agent-added hosts only | **Partly met** | Met for every sandbox this installation records. Each gets its own `--internal` network and a proxy that resolves and pins addresses and refuses private, link-local and mapped ranges. Startup contains existing sandboxes and never loosens them. CI's native-Linux run passed 31 of 31 contained cases, and flight 2's HAT ran Trivy and a real Node project contained. **Not met:** a sandbox carrying mcp-everything's label with no registry record is never contained (`src/network/startup.ts`, rule R1; flight 4 left it "needs design"). Sandboxes made before ownership are never started by mcp-everything since flight 4, but live on in Docker until the operator removes them. |
| 8 | Registry-only builds install as today; a refusal names the host and how to allow it | Met | Per-ecosystem default hosts (flight 2 DD5), measured against the projects the suites install. Refusals name the host and `set_project_hosts`. **Weakness:** a build refused its registry retries until its 600 s timeout before the refusal surfaces (about 3.1 million refused connections in 11 minutes, flight 2). Taken up as a follow-up (Decisions). |
| 9 | A named isolation runtime is used for every container and can be required | Met; **verified only in CI** | Naming a runtime requires it: `docker info`, then a trial container; a sandbox made under another runtime is refused (flight 2 DD11). Verified with gVisor's `runsc` installed only in the native-Linux CI job (`.github/workflows/docker-gvisor.yml`): the whole Docker suite plus `test/integration/gvisor.test.ts`, which checks every container's `HostConfig.Runtime`, green on flights 2–5. Never on the operator's Docker Desktop, which cannot run it. The job runs on pull requests and by hand only, and is not required: to be scheduled (Decisions). |
| 10 | The README covers what is checked, scanners and policy, containment, the runtime, outside services, upgrading, and what none of it protects against | Met | The three chapters moved to `docs/checking.md`, `docs/containment.md` and `docs/security-model.md` (flight 4), and the README summarizes and links them; `test/readme.test.ts` checks every anchor. Each flight's debrief read its part against the code. The fail-open gap of criterion 6 is not yet among `docs/checking.md`'s limits; the fix replaces it. |

### Overall Outcome
**The mission achieved its outcome, with three stated exceptions.** The operator confirmed at this debrief that the outcome is what they wanted.

The outcome sentence: "an operator can let an agent install open source projects knowing that, when they turn the protections on, each project is checked before any of its code runs by scanners the operator chose, and whatever a project runs can reach only the hosts it needs, never the operator's machine or local network; and that the agent can always see how well protected an install is". Here is what was built, against each clause.

- **"Checked before any of its code runs".** True of the repository's own code and its declared dependencies:
  - checked on a staging clone before any build;
  - the build runs on exactly the checked bytes;
  - a block there keeps an installed project working.

  What the build installs is checked too, after the build and before anything it built runs. A block there cannot keep the previous version on a reinstall.
- **"By scanners the operator chose".** True: the operator's own scanners, at the source stage or the build stage, plus three built-in checks. The agent cannot add, skip or change any of them.
- **"Can reach only the hosts it needs, never the operator's machine or local network".** True for every sandbox the installation records, when containment is on. Not true for labelled sandboxes with no record, which are never contained.
- **"The agent can always see"**: true.

What the mission says it does not take, it did not take:
- **A hostile agent.** `sandbox_exec` can still change a checked tool; a build repaired by hand is not rechecked.
- **Non-root builds**, deferred.
- **Catching everything.** Ten limits are written in `docs/checking.md`, and containment's in `docs/containment.md`.

**The constraints held.**
- **Off by default:** both scanning and containment are off until the operator turns them on.
- **Operator-only configuration.**
- **Nothing new installed on the host:** scanners, the proxy and the clone run as containers.
- **New Docker objects owned as mission 02 defined.** Mission 02 itself was tightened by this mission: sandboxes made before ownership are now refused everywhere (flight 4 DD4). This supersedes mission 02's criterion 2 ("a sandbox from before the change is acted on as today"), on purpose. Treating an owner-less label as everyone's had been found to be a data-loss path.
- **mcp-everything's own images pinned by digest.**
- **Text from repositories bounded and cleaned.**
- **Tool names and variable names unchanged.**
- **The registry's `version` still 1**, through the network's three states (flight 2 DD7) and `scan.build` (flight 5).

**Value delivered.** An operator can now let an agent install projects with three things on that are opt-in, each visible to the agent:
- a check of the repository and its dependencies, and of what the build installed;
- a network that reaches only registries and named hosts;
- a stronger isolation runtime.

When nothing is on, the agent is told so on every install.

## Flight Summary

| Flight | Status | Legs | Key Outcome |
|---|---|---|---|
| 1. [Checking a project's own code before it runs](flights/01-checks-before-code-runs/flight.md) | completed (#27) | 11 (designed at 5) | The scanner contract (SARIF on stdout, env-file credentials, the stages field), the policy, the staging clone before any removal, the built-in `build-hooks` list, `check_project`, and the security status in every result. |
| 2. [Contained network and isolation runtime](flights/02-contained-network-and-runtime/flight.md) | completed (#30) | 15 (planned at 11; 2 added from CI, 2 splits) | A proxy per project on an `--internal` network; three network states; agent hosts and operator local access; requiring the runtime; startup containment; a gVisor CI job. The flight with the most friction: an unbounded background wait ran 7 h 46 min, and legs were added after a red CI run. |
| 3. [Checking dependencies and tool descriptions](flights/03-dependency-and-tool-checks/flight.md) | completed (#31) | 4 | `dependencies` (GitHub's graph against OSV, in mcp-everything's own process, inert unless injected), and the tool-description check on every discovery path, withholding under block. Split from a larger flight 3 at planning. |
| 4. [Groundwork, and leaving old sandboxes alone](flights/04-groundwork-and-old-sandboxes/flight.md) | completed (#33) | 5 | The security chapters moved to `docs/`; `docker.ts` and `containment.ts` split; slow tests out of the default run; sandboxes made before ownership never touched again. Split out of the tentative flight 4 at planning. |
| 5. [Checking what a build installed](flights/05-checking-what-a-build-installed/flight.md) | completed (#34) | 3 (planned at 2) | Build output on the sandbox's volume behind `/opt/mcpe`; a `"stage": "build"` scanner after the build and before discovery; a blocked project held until reinstalled. Planned "small" at the operator's request, and it stayed small in code. |

**Flight patterns.**
- **Flights 3, 4 and 5 ran smoothly.** Each was scoped to one cluster of decisions at planning, by splitting before design, and each had empirical premises checked first: services in flight 3, the call graph in flight 4, throwaway containers in flight 5.
- **Flights 1 and 2 were too large.** Each grew from its design (5 → 11 legs; 11 → 15), and each split at leg design cost a rewrite and usually a second review.
- **One pattern ran through all five flights: reviews found real defects before code.** The examples:
  - a bypass at flight 1's leg 3;
  - the gateway check at flight 2;
  - the data shapes at flight 3;
  - the cycle in flight 4's split;
  - the block that one `discover_tools` call would have undone, at flight 5.

  Defects found at design cost a leg rewrite; none reached code.

## What Went Well
- **The order of the flights.** Flight 1 built the contract and the staging clone the other checks plugged into. Flight 2 replaced how every sandbox joins a network, as its own risk point. Flight 4 then paid down the debt the first three made (the 2,898-line `docker.ts`, a 1,596-line README) before flight 5 built on it.
- **Premises verified before design decisions locked**, and the practice spread:
  - flight 2 tested runsc in CI;
  - flight 3 probed the services;
  - flight 4 computed the call graph by hand;
  - flight 5 ran throwaway containers for the venv and gems.

  Each time a premise was checked first, its decisions held.
- **One guard that every caller crosses**, applied each time a security property was added:
  - `refuseUnless` for ownership;
  - `App.withheldOf` for withheld tools;
  - `assertNotBlocked` in the installer, not the server, for a blocked build.

  The Architect calls this the mission's best structural habit.
- **The mutation trial in review.** From flight 3 on, the Reviewer made changes to the source and checked that a test failed. That found assertions that could not fail, in two flights running, and the gap in flight 5's guard.
- **HAT sessions** caught what reviews could not:
  - flight 1: the `entrypoint` key a real scanner needed;
  - flight 3: the README's size, which became flight 4's docs move;
  - flight 4: a doubled name in refusals, and the operator's own uncontained `gron` sandbox, eight days old, removed and reinstalled.
- **Docker hygiene, every run.** The Flight Director diffed Docker's object lists around every suite run and read every new destructive test before its first run. Twice it identified another tool's objects (the `afp-*` objects; `mymusic-runtime`'s transient containers) instead of touching them.

## What Could Be Improved
- **Size flights by decisions earlier.** Flights 1 and 2 each held more than one cluster of decisions, and grew at leg design: twelve legs added between them, and about eight extra review agents in flight 1 alone. Flights 3 and 4 were split at planning and ran clean. The lesson took two flights to learn.
- **Shell writes by Developers.** The Edit/Write-only rule was restated in every spawn. Developers still wrote files with shell commands in flights 2, 3 and 4, most often in the short "Fix Review Issues" spawn. Flight 5 had none. The rule is now in the crew file's prompts (Local fixes).
- **Debrief interviews missing context.** The Developer interview read long flight logs only partly in flights 1 and 2. In flight 5 it did not read the legs at all and could not judge their accuracy. The crew prompt now names the files to read (Local fixes).
- **The suites grew slower, and nothing reports why:**
  - unit tests (`npx vitest run`): 13.4 s with 1,511 tests at flight 1, then 29.1 s with 3,072 at flight 5. The default run was cut to about 6 s by moving the slow files out (flight 4);
  - the Docker suite: about 280 s at flight 1, then 670–724 s (flight 4) and 1,258 s (flight 5).

  There are no per-describe timings (squawk 0063).
- **An intermittent unit failure has been seen twice** (flights 3 and 4) and never named.
- **CI's floor of passing tests** is still 867 against 3,072 (squawk 0062).

## Lessons Learned

**Technical**
- **Check what Docker made, not its version.** Flight 2's probe-then-pin, such as the gateway check after creating a network, held where version assumptions would not have. Docker 29 changed an error message under it (squawk 0057).
- **Ownership by absence is ownership by everyone.** A label without an owner reads as everyone's, and every installation claimed it (flight 4). Fail closed on missing facts.
- **A new state needs its exits audited, not only its entry.** Flight 5's block was correct where it was set and undone one call later. Grep every path to `ready` and every path that runs the project's programs.
- **A stage that errored is not a scanner that failed.** "A failed scanner never blocks" is the right rule for one scanner among several. A whole stage that could not run leaves nothing checked, and should hold (the operator's decision at this debrief).
- **Trial on the environment that ships.** gVisor could not run on the development machine, so flight 2 made CI the trial column. Designing nine legs on runc evidence first cost rework.

**Process**
- **Split by decision cluster at planning.** "Enforce vs tell" (flight 5) and "groundwork vs feature" (flight 4) are risk boundaries, not splits by task type.
- **Name the test doubles a plan depends on at flight design.** Flight 5's `FakeDocker.runScanner` could never return a result, and two flight reviews missed it.
- **For a move or split leg, compute the call graph, and make the normalized diff an acceptance criterion** (flight 4).
- **Bound every background wait**, and make sure it cannot match itself (flight 2).

**Domain**
- **Forge scanners cannot be borrowed.** Public dependency graphs plus OSV cover dependencies for GitHub only, and nothing public covers what a build runs. Hence the built-in list.
- **An allowed host is an exit as well as an entrance.** Release downloads on GitHub are anyone's, so containment narrows an evasion; it does not close it. The docs say both.

**Conventions to document** (squawk 0064, and the Architect's list): the integration suite's own-installation pattern, the three test entry points, where the ownership gate lives, the runc/runsc behavior table, and the in-process outbound exemption.

## Methodology Feedback
Plugin version 1.2.4 throughout. Each finding restates observations already in the flight debriefs named, so a later sweep counts each occurrence once.

### Methodology observations
1. **The leg breakdown grows after flight design** (flights 1, 2 and 5; 3 of 5).
   - *Where:* `/mission-control:flight` Phase 5b, then `/mission-control:agentic-workflow` Phase 2a. Flight 1 was designed at 5 legs and flew 11. Flight 2 was planned at 11 and flew 15. Flight 5 was planned at 2 and flew 3.
   - *Cost:* a leg rewrite and usually a second design review per split; about eight extra review agents in flight 1.
   - *Expected:* the skill's sizing guidance to recognize, at flight design, the risk boundaries leg design later found:
     - enforcement vs reporting;
     - groundwork vs feature.

     Two reviews disagreed about one such split in flight 5, and the skills give no tie-breaker.
2. **The premise audit names "act and observe", but not the environment, the data or the test doubles** (flights 2, 3 and 5; 3 of 5).
   - *Where:* `/mission-control:flight` Phase 4.
   - *What happened, by flight:*
     - flight 2 designed on runc for a gVisor feature;
     - flight 3 verified the services but not the shapes of the data the criteria depended on;
     - flight 5's plan assumed a test double could return results it could not.
   - *Cost:* rework of nine legs' evidence (flight 2), three leg-artifact revisions (flight 3), and a high-severity leg review finding (flight 5).
   - *Expected:* the audit to name the target environment, the data shapes, and the doubles or fixtures the criteria assume.
3. **Developers wrote files with shell commands, despite a project rule restated in every spawn** (flights 2, 3 and 4; 3 of 5).
   - *Where:* `/mission-control:agentic-workflow` Phase 2b and 2d spawns.
   - *Cost:* a Flight Director check for invisible characters and stray files each time; one misplaced log entry. No damage.
   - *Destination:* the rule is the project's, so its fix is local (below). Recorded for the sweep because it recurred under the default spawn shape, most often in the short fix spawn.
4. **The debrief's Developer interview reports from partial context** (flights 1, 2 and 5; 3 of 5).
   - *Where:* `/mission-control:flight-debrief` Phase 2.
   - *Cost:* corrections by the Flight Director (flights 1 and 2); no leg-spec input (flight 5).
   - *Destination:* the crew prompt is the project's, so the fix is local (below). Recorded because the default prompt does not name the files.
5. **No written flow for a leg added after the flight's code was committed and reviewed** (flight 2; 1 of 5).
   - *Where:* `/mission-control:agentic-workflow`. The Flight Director improvised design, implementation, diff review and a fix commit after a red CI run.
   - *Cost:* none observable; recorded once.
6. **Unbounded background waits** (flight 2; 1 of 5). One self-matching wait held an agent for 7 h 46 min. It was fixed by the Flight Director's prompts for the rest of the mission and did not recur.

Positive data points for the sweep:
- the HAT fix-vs-feature gate worked as written (flights 3 and 4);
- the "max 2 design review cycles" backstop worked (flight 1);
- the squawk qualification gate refused a design item correctly (flight 2);
- planning MCP reconnects into HAT steps (flight 4) answered flight 3's observation.

### Local fixes
Applied in this debrief's pull request, with the operator's OK:
- **`.flightops/agent-crews/leg-execution.md`:** the "Implement" and "Fix Review Issues" prompts state the Edit/Write-only rule themselves (observation 3).
- **`.flightops/agent-crews/flight-debrief.md`:** the Developer interview reads the legs and the flight log's Summary and Leg Progress first, including HAT changes and review fixes (observation 4).

### Local lessons
- **The Flight Director's planning probes:** throwaway containers with `--rm`, and object lists diffed around them. Worth keeping as habit; they cost minutes.
- **Read every destructive test before its first run** (from flight 2's incident, kept through flight 5).
- **Expect other tools' objects on a shared daemon.** Identify them by inspecting what is live (one auto-named container caught in 15 seconds) before calling anything an anomaly of ours.
- **Low-risk legs skip the design review, so their listed verification steps are the only gate before the flight-end review** (flight 3). Check that they were done.

## Decisions at this Debrief
Operator, 2026-11-25:
- **An errored build stage holds the project.** A check that could not run holds the project as a block does, with the reason. The rule "a scanner that fails never blocks" stays for individual scanners. This closes criterion 6's gap. It changes a lifecycle path, so it is a sortie or the next mission's, not a squawk.
- **To be taken up next**, by the next mission or by sorties:
  - containing labelled sandboxes that have no record (criterion 7's gap; needs design);
  - proxy-side backoff for a build refused its registry (criterion 8's weakness);
  - the gVisor CI job, scheduled weekly and considered as a required check;
  - moving Go's module cache and Cargo's registry onto the volume, so the build stage sees them.
- **The two crew-file fixes** are applied (Local fixes).
- **The outcome is what the operator wanted.**

## Action Items
- [ ] **Hold on an errored build stage** (Decisions). A sortie: a lifecycle change plus the docs' limit.
- [ ] **Contain labelled sandboxes with no record** (criterion 7). Needs design: a sortie, or the next mission.
- [ ] **Proxy-side backoff for refused registries** (criterion 8). A sortie.
- [ ] **gVisor CI on a weekly schedule**, and decide whether it becomes required. Small: a workflow change, probably a squawk.
- [ ] **Go and Cargo caches onto the volume.** A sortie: `GOPATH`/`GOMODCACHE` and `CARGO_HOME`, per image.
- [ ] **Squawk turnaround for 0061–0064:**
  - 0061: `project_info`'s network line for an old sandbox;
  - 0062: the CI floor;
  - 0063: Docker suite timings;
  - 0064: the integration suite contributor note.
- [ ] **Name the intermittent unit failure** (flights 3 and 4). A loop of `npm test` under load, then a squawk.
- [ ] **Later:**
  - `isHeld(record)` once a second hold exists;
  - extracting `finishInstall`'s endings;
  - `server.ts` at 1,817 lines;
  - non-root builds;
  - Docker Desktop and Windows verification.
- [ ] **`/mission-control:routine-maintenance`** before the next mission, as the methodology runs it after a mission debrief.
