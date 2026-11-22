# Flight: Checking a Project's Own Code Before It Runs

**Status**: in-flight
**Mission**: [Vetted and Contained Installs](../../mission.md)

> **Design review 1** (Architect, 2026-11-21): approve with changes. Four high issues (a blocked reinstall reported as success; the staging sequence colliding with the install's first step; container timeouts that leave containers running; the built-in walk overflowing the clone's output cap) and the medium ones are folded in below; the claims were spot-checked by the Flight Director against `src/util/exec.ts`, `src/sandbox/docker.ts`, `src/server.ts` and `test/docker.test.ts`. Legs 2 and 4 were split.
>
> **Design review 2** (Architect, 2026-11-21, the last pass the method allows): approve with changes. Folded in: the installer's outcome as a separate entry point so the scan-off contract and its ~100 unit cases stay as they are (DD8); the bound on a scanner's run stated as a mechanism (DD2); the record's time and slug re-read after a long check (DD6.1); what tools do while a project is being checked (DD6.1); the clone script's walk details and the output cap (DD5); the sweep's sources and its place in the coverage test (DD6, DD11); the scanner's volume guarded like the copy's (DD2). Leg 3 was split.

## Contributing to Criteria
- [ ] With nothing configured, installs behave as they do today, and the agent is told so (scanning, containment and runtime status always visible). *(This flight reports containment as "not contained" and the runtime as Docker's default or the one named; flight 2 changes the containment line.)*
- [ ] The operator turns scanning on from the environment and can add scanners of their own choice without a change to mcp-everything; the agent cannot change scanners or policy.
- [ ] With scanning on, a repository is checked before any of its code runs; findings, scanners run and scanners failed are reported; a blocking policy stops the build and leaves an installed project working; a failed scanner does not block.
- [ ] With scanning on and no operator scanner, the operator gets the list of what the repository's build will run. *(The dependency half of this criterion is flight 3's.)*
- [ ] The agent can have a repository checked without installing it; nothing from the repository runs.
- [ ] README: what is checked and when, adding a scanner, the policy, what none of this protects against. *(Flight 1's part; flights 2 and 3 add theirs.)*

---

## Pre-Flight

### Objective
Give mcp-everything a way to check a repository after it is cloned and before any of its code runs: a contract that lets the operator plug in any scanner packaged as a container image, a built-in check that lists what the repository's build will run and flags a few red-flag patterns in it, an operator-set policy that either reports findings or blocks the build, a check tool the agent can call without installing, and a security status the agent always sees. A reinstall that the policy blocks leaves the installed project as it was, which means the check has to happen before the old sandbox or its record is touched, and what gets built has to be exactly what was checked.

### Open Questions
- [x] What "scanning on" means without a policy → DD1 (warn; operator).
- [x] What the built-in check reports → DD5 (list plus a few red flags; operator).
- [x] What the check tool does with scanning off → DD7 (runs: an explicit ask; operator).
- [x] HAT leg → yes (operator, 2026-11-21).
- [x] Staging clone: adopt or copy → DD6 (copy).
- [x] Built-ins under the container contract or not → DD5 (same findings and policy, not the container contract).
- [x] Where findings go → DD3, DD8.
- [x] Scanner caches: per-scanner volume, or network as the norm → DD2 (network as the norm; caches deferred).
- [x] Total scan time → DD2 (sequential, one overall bound).
- [x] `block` that nothing configured can reach → DD4 (stated, not a startup error).
- [x] A built-in check that throws → DD4 (a failed check; never blocks).

### Design Decisions

**DD1 — The operator's switches.** Read at startup like every other `MCPE_*` setting; an invalid value is a startup error, never a silent fallback (squawk 0015's rule).
- `MCPE_SCAN`: `off` (default) | `on` | `warn` | `block`. `on` means `warn` (operator, 2026-11-21).
- `MCPE_SCAN_BLOCK_AT`: `error` (default) | `warning` | `note`. Read only under `block`; set under any other value it is a startup error, so an operator cannot believe they are blocking when they are not.
- `MCPE_SCAN_TIMEOUT`: the overall bound on one check's scanners, in seconds (default 900, max 3600). See DD2.
- `MCPE_SCANNERS`: path to a JSON file listing the operator's own scanners (DD2). Read and validated once at startup; a change needs a reconnect. It may be set while `MCPE_SCAN` is `off`: the check tool uses it (DD7).
- Rationale: one place the operator decides; nothing an agent can reach.
- Trade-off: no per-project policy, no live reload. A startup error prints a stack trace until squawk 0027 is fixed; accepted.

**DD2 — The scanner contract.** The `MCPE_SCANNERS` file:
```json
{ "scanners": [
  { "name": "trivy",
    "image": "aquasec/trivy@sha256:…",
    "command": ["fs", "--quiet", "--format", "sarif", "/scan/repo"],
    "network": true,
    "timeout_seconds": 300,
    "env": [] } ] }
```
- `name` (`[a-z0-9-]`, unique, at most 32), `image` and `command` required; `network` default `false`; `timeout_seconds` default 300, max 1800; `env` lists variable names whose values are read from mcp-everything's own environment at each run. `stage` is accepted only as `"source"`; later flights add others. Unknown keys are a startup error.
- **How a scanner runs.** Under the act-on-the-id pattern mission 02 set. The staging volume is classified as this installation's before it is mounted (a bare `-v` would create or use any volume), as `createContainer` does. Then `docker create` with a name that carries the installation id and a form no slug can produce (`<prefix><id>-scan-<hex>`; slugs never contain `-`), labels for the owner and `mcp-everything.role=scan`, `limits()` (so a named runtime applies), `--network none` unless `network: true` (then the bridge; flight 2 decides what "network" means once containment exists), the staging volume mounted **read-only at `/scan`** (so the checkout is `/scan/repo`), working directory `/scan/repo`, no TTY, and credentials through an `--env-file` written with mode 0600 as the MCP proxy's are and removed as soon as `create` returns (Docker has read it by then), never in argv (squawk 0020). Then **`docker start -a <id>` through the existing runner**, with the scanner's time as its `timeoutMs` and its byte cap (8 MB stdout): one call, stdout and stderr kept apart for a container without a TTY, and independent of the daemon's log driver (where `docker logs` can fail). Docker has no timeout of its own for this; the runner's timeout kills only the client (`src/util/exec.ts`), so **on a timeout or a truncated stdout, `rm -f <id>` is the kill**, by the id `create` returned. `rm -f <id>` also follows every run, whatever its outcome.
- **The scanner writes SARIF 2.1.0 to stdout**; stderr is its log. The exit code is ignored when stdout parses as SARIF. Truncated stdout is a failure, not a partial result.
- **A failure** is: the image could not be pulled, the container could not be created, the time ran out, or stdout is not complete SARIF. It is reported with a cleaned, bounded tail of stderr and never blocks (mission constraint).
- **Order and total time.** Scanners run one at a time, in the file's order, after the built-in check. Each gets the smaller of its own limit and what is left of `MCPE_SCAN_TIMEOUT`; one that cannot start for lack of time is reported as not run. So a whole check is bounded by the clone's 600 s plus `MCPE_SCAN_TIMEOUT`, which DD6's sweep uses.
- **Network is the norm for vulnerability scanners**, which fetch their databases. The README's example has `network: true` and says so. A per-scanner cache volume (written by a scanner that has just read hostile content) is deferred: flight 2 may revisit it beside the proxy.
- Rationale: stdout needs no writable mount, so a scanner writes nothing mcp-everything reads except its own output.
- Trade-off: a scanner that can only write SARIF to a file needs a one-line wrapper (`sh -c 'tool -o /tmp/r.sarif >&2; cat /tmp/r.sarif'`); the README shows it. Every database download is repeated per check.

**DD3 — What a finding is, and how it is cleaned.** From each SARIF result: the scanner's name, `ruleId`, the level (the result's `level`, else the rule's `defaultConfiguration.level`, else SARIF's default `warning`; `none` is dropped), `message.text`, the first location as `uri:startLine`, and `properties["security-severity"]` when present (shown, not used by the policy). Every string is repository-influenced and goes through the existing cleaning (`cleanTerminalText`/`oneLine`): message at most 200 characters, location 120, rule id 80. Counts per level are kept exactly; at most 20 findings per scanner are kept, highest level first, with "N more" stated. The bounded result is all that is stored and shown.

**DD4 — The policy.**
- Under `warn` the build always proceeds. Under `block` it does not proceed when any check, the built-in included, has a finding at or above `MCPE_SCAN_BLOCK_AT`.
- A failed check never counts (operator, 2026-11-21). That includes the built-in check failing for an infrastructure reason (it throws, or the clone's file listing was cut short): reported as a failed or incomplete check, never as clean, never blocking.
- **A `block` nothing configured can reach** (the built-in check stops at `warning`, so `block` at `error` with no operator scanner) is not a startup error, since an operator may be adding scanners; the startup log and the security paragraph (DD8) say "blocking at error, but no configured check reports at that level".
- Every report says what the policy decided and why ("blocked: 2 findings at error or above, from trivy").

**DD5 — The built-in check: what the build will run.** A check named `build-hooks`, always present, run in-process on files the clone container reads. It shares DD3's findings and DD4's policy; it is not a container under DD2's contract.
- **The walk.** The clone script additionally walks the checkout (skipping `.git`, `node_modules`, `vendor`) for files that hold build code: every `package.json`, `setup.py`, `pyproject.toml`, `build.rs`, `Cargo.toml`, `CMakeLists.txt` and `*.cmake`, `configure`/`configure.ac`, `Makefile` variants, `*.gemspec`, `extconf.rb`, `Rakefile`, `binding.gyp`. At most 200 files, at most 64 KB each, and **at most 2 MB in total**.
  - **In the script**: busybox `find` with `-prune`, `-name` and `-type f` (which also skips symlinks), output sorted for a stable order, and guarded so that `set -eu` cannot abort the clone on a `find` error. The counters live inside the `while read` loop's subshell, so the loop itself prints an `INCOMPLETE` line when a budget is reached. A name containing a newline is skipped and also marks the walk incomplete.
  - **Its output** is a new line, `BUILD <base64 path> <base64 content>` (paths may contain spaces), parsed by a branch of its own into a new `ProbeData` field, not `files`, which detection reads. The clone's stdout cap rises from 8 MB to 16 MB: the existing manifests alone (300 KB each, base64) can approach 8 MB.
  - **Never clean when partial**: when the script reports `INCOMPLETE`, or the runner reports truncated output, the check says **incomplete** and what it did not read.
- **The report**, for the recipe the project will be built with, lists each piece of the repository's own code that recipe runs, as a `note`: npm lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`) and `build` of the root and workspace packages; `setup.py` or the build backend for pip; `build.rs` and proc-macro crates for Cargo; the Makefile, CMake or configure scripts; the gemspec and `extconf.rb`. For Go, it says that `go install` runs nothing from the repository.
- **Red flags**, raised to `warning`, in that code: a download piped into a shell or interpreter (`curl`/`wget` … `| sh`, `bash`, `python`, `node`); code decoded and then executed (`base64 -d`, `atob`, `Buffer.from(…, 'base64')`, `b64decode`, `fromhex` reaching `eval`, `exec`, `Function`, `sh -c`); writes to paths outside the checkout (`~/.ssh`, `/etc/`, `/root/`, `$HOME/.`). No pattern raises to `error`.
- It always states what it cannot see: dependencies' build code, unknown until the build resolves them (flight 3).
- Trade-off: the patterns can be evaded; the README says the list is a reading aid, not a verdict.

**DD6 — Check before anything changes.** Applies to an install or reinstall **when `MCPE_SCAN` is not `off`**, and to every check (DD7).
1. **Nothing of the existing project is touched first.** Today the install's first act is to overwrite the record with an `installing` one and remove the old sandbox. Under scanning, that whole prelude (the record write, closing proxied servers, the removal) moves after the check. Until then a reinstalled project's record stays as it was and its sandbox keeps serving. The install's phase gains a state before `old`: **checking**, in which a failure (Docker not answering, a staging volume that cannot be made) is reported as a failed check and the project is untouched. It must never be reported as "the old sandbox could not be removed". A first install whose clone fails while checking ends as today's does: nothing was installed.
   - **After the check, the registry is read again.** A check can take up to the clone's 600 s plus `MCPE_SCAN_TIMEOUT`, and another session can uninstall, reinstall or take a slug meanwhile. So the slug, the old record (`before`) and whether the names changed are recomputed after the check, and `installedAt` is set at the prelude's write, not when the record object was first built (otherwise a long check eats into the interrupted-install window). Staging names carry the installation id, not the slug, so nothing made during the check depends on the slug.
   - **While a project is being checked**, its install job exists, so the tools that refuse during an install refuse during a check too (`sandbox_exec`, `discover_tools`, `connect_mcp_server`, `uninstall_project`); calling a reinstalled project's tools still works, since that refusal also needs the `installing` status, which is not written until the prelude. `project_info` and `list_projects` say the project is being checked. For a first install, which has no record yet, `project_info` on its repository names the running job instead of answering "no installed project".
   - **Accepted**: today another session sees an `installing` record at once; under scanning it sees nothing until the check has passed, so two sessions can both check and then race into the prelude. The same race exists today between two sessions' preludes; it is not made worse in kind.
2. Clone into a **staging volume** `<prefix><id>-stg-<hex>`, labelled with the owner and `mcp-everything.role=staging`. The clone container itself becomes named and labelled (`role=clone`) and is removed by id on a timeout, which fixes for every install the leak `run()`'s timeout has today.
3. Run the built-in check, then the operator's scanners (DD2).
4. **Blocked**: remove the staging volume and stop. The installer returns an outcome that says so, not a record (see DD8).
5. **Allowed**: do the prelude (record, close, retire the old sandbox, as today), create the sandbox's volume, **copy** the staging volume into it, remove the staging volume, and build. The build runs on exactly the bytes that were checked.
- **The copy** is a guarded Docker method: it classifies both volumes as this installation's before mounting either (a bare `-v` would create or use any volume), runs in a container of the clone image with no network and the staging volume read-only, and preserves symlinks, modes and ownership (`cp -a`). Measured against the real daemon in leg 4 (a divert criterion).
- With `MCPE_SCAN=off` the install sequence is unchanged; the clone goes straight into the sandbox's volume.
- Rejected: adopting the staging volume as the project's volume. Volumes cannot be renamed, and a record whose volume is not named after its container breaks an assumption the ownership work rests on.
- **What is left behind** when a process dies mid-check (scanner, clone and copy containers; staging volumes) is swept at startup, **beside the reconciliation** (asynchronous; not with the file sweeps, which make no Docker call): selected by an explicit allowlist of roles (`scan`, `clone`, `copy`, `staging`) **and** the owner label equal to this installation, so no project's sandbox (which has no role) can ever match. Containers first (age from `.Created` in `docker inspect`), then volumes (age from `{{.CreatedAt}}` in `docker volume inspect`; `volume ls` does not give it), each older than the clone's 600 s plus `MCPE_SCAN_TIMEOUT` plus 30 minutes. The age is the only thing protecting another session of the same installation mid-check, so it is derived from the configuration, never fixed. Another installation's are never touched.

**DD7 — The check tool, `check_project`.** Takes `repo`, `ref`, `submodules`, `wait_seconds`. Always listed, and **runs whether or not scanning is on** (operator, 2026-11-21: an explicit ask). It does DD6 steps 2 and 3 and removes the staging volume; it builds nothing, runs nothing from the repository, and does not touch the registry.
- **Long checks** use the install's job pattern (progress, `wait_seconds`, the job outliving the call), keyed `check:<repo id>`. They are never put under the repository's own key, which `install_project` would join and other tools would report as "still installing".
- It reports the commit checked, each check's outcome and findings, and what an install would do under the current configuration: with `block`, built or blocked; with `warn`, built with these findings reported; with scanning off, that installs are not scanned at present.
- A check may run beside an install of the same repository; they share nothing but the clone image.
- Annotation: `openWorldHint`.

**DD8 — What the agent is told.**
- **A checked install has its own entry point with an outcome.** `Installer.install` keeps its contract (it returns the record) and is what runs with scanning off; its ~100 unit cases and the Docker suite's two call sites stay as they are, and the existing reinstall cases describe the scan-off path only (they are not to be "fixed"). A new entry point, used when scanning is on, returns one of: **built** (the record), **blocked** (the report, and the installed project left in place if there was one), **check failed** (why, and the installed project left in place if there was one). Both entry points share leg 1's extracted pieces. The `install_project` handler branches on the kind, never on `status`: today it reads `status === "ready"` as success, so a blocked or failed check returning an untouched, `ready` record would print "Generated tools are callable". This belongs to the sequence (leg 5).
- **A blocked first install** keeps no record; the result carries the report and says nothing was built. **A blocked reinstall** says the installed project was left as it was, at its old commit. One warning naming the blocked commit and date is written with `registry.update` (locked and re-read; never a spread of the stale copy the install holds), replacing any earlier warning of the same kind.
- **Server instructions** become generated from the configuration, with a security paragraph: scanning off / warn / block at a level (and DD4's statement when that level is unreachable); the checks (built-in and the operator's names); "sandbox networks are not contained: a build, and a sandbox with its network on, can reach the internet and the local network"; the isolation runtime (Docker's default, or the one named in `MCPE_DOCKER_RUNTIME`); that `check_project` checks a repository without installing it.
- **`describe()`** gains a `security:` line that separates what was done at install from the current setting, since sessions with different settings share one registry: "scanned at install (commit, counts, decision)" or "not scanned at install", plus "scanning is currently off/warn/block". `project_info` and an install result also list the bounded findings.
- **The record** gains an optional `scan` field holding the bounded result. Records written by earlier builds have none. No registry `version` bump: records have gained optional fields before (`mcpServers`, `published`, `selection`), the registry does not validate fields, and writers spread records. A reinstall with scanning off drops `scan`, correctly.
- `search_projects` and `set_project_network` are unchanged in this flight.

**DD9 — Split `Installer.install` first, without changing behavior.** Mission 02's debrief: the method is about 225 lines with three state variables for two facts; it was edited in three legs, and its one false statement to the operator came from that. Split it before the next change. Leg 1 does the three extractions the debrief named (retiring the old sandbox; the build attempts; settling a failure), with the phase as one value, **leaving room for a state before `old`** (DD6's `checking`) without adding it. Leg 5 then owns the new sequence end to end.

**DD10 — The clone image is pinned.** `alpine/git:latest` clones every repository, now reads its build code, and runs the copy. It becomes a digest-pinned reference, still overridable with `MCPE_PROBE_IMAGE`, per the mission's constraint on images mcp-everything chooses. Landed in leg 3, before the real-Docker cases depend on it. Build images (`node:lts` and so on) are left alone: version detection chooses their tags. Trade-off: the pin goes stale until someone bumps it.

**DD11 — Verification apparatus.**
- **Unit**: the existing Docker test double for the contract, the runner's sequence of Docker calls, parsing, cleaning, the policy, the built-in patterns and budgets, the install's sequences and outcomes; SARIF written by hand in the test files (not golden files). Every new Docker method is added to the coverage test's lists (`test/docker.test.ts`, which asserts the class's methods are exactly those lists): the runner, the copy and the sweep act on what they listed or created, so they go in the guarded table, not `NOT_GUARDED`.
- **Docker-gated suite**, with a scanner that needs no custom image: pinned `alpine` running `sh -c` to print a fixed SARIF document, print garbage, or sleep past its time. Cases: a check of `tomnomnom/gron` (the Go path: "runs nothing"); an install under `block` with the always-error scanner (blocked, no record, nothing left in Docker); a reinstall of an installed project under the same (blocked; the old sandbox still answers a tool call); a timed-out scanner (reported, not blocking, its container gone); a copy that preserves a symlink and an executable bit; the startup sweep (old leftovers of this installation removed, another owner's left).
- **Act and observe**: the suite drives `App` through `callTool`, as today. It observes the tool results, `docker ps -a` / `docker volume ls` filtered on the suite's own owner label, and a tool call into the old sandbox.
- **Guard**: new cases use the suite's own name prefix; `mayRemove` is extended deliberately for the staging, scan, clone and copy names, not loosened, and its self-test gains cases for each, including negatives (the same names under the operator's own prefix must be refused). Mission 02's rule holds: the first run of the new destructive cases is gated on the Flight Director's go-ahead, with the operator's container and volume ids recorded at the start of execution.
- A repository with npm hooks (a real `build-hooks` report through a real build) is left to the HAT leg, chosen there: the suites must not depend on a third party's package scripts staying put.

### Prerequisites
- [x] Docker reachable; server 29.8.2 (measured at planning, 2026-11-21).
- [x] `tomnomnom/gron` installs in the Docker suite today (its existing fixture).
- [ ] Unit and Docker suite baselines recorded at the start of execution (counts and times), not at planning.
- [ ] The operator's existing containers and volumes listed by id at the start of execution, before the first Docker-suite run.
- [ ] Digests for DD10's clone image and the test scanner's `alpine`, read from the registry at execution, not from memory.

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [ ] Prerequisites verified (the three left open are execution-time by design)
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
- **Leg 1 — split.** DD9. Suites green and unchanged.
- **Leg 2 — scan rules (no Docker).** Configuration (DD1) in `config.ts`; a new `src/scan/` module with the scanner file's validation (DD2), SARIF parsing, cleaning and bounds (DD3), the policy (DD4), and the built-in check's analysis over given file contents (DD5's report and red flags). Pure functions, unit-tested; nothing calls them yet.
- **Leg 3 — the clone's walk.** The clone container named, labelled (`role=clone`) and removed by id on a timeout; a role parameter on the probe; DD5's walk in the clone script, its `BUILD` and `INCOMPLETE` lines, their parser, and the raised cap; the clone image's pin (DD10). Coverage-test lists updated; a Docker-suite case for the walk's output on a real clone.
- **Leg 4 — scanners, copy and sweep in Docker.** The scanner runner (DD2); the guarded volume copy (DD6); listing and sweeping this installation's leftovers by role and age. Coverage-test lists updated. Docker-suite cases for the runner (SARIF, garbage, timeout), the copy and the sweep.
- **Leg 5 — the sequence.** The checked install's entry point with DD6 (the `checking` state, the re-read after the check, the moved prelude, staging, copy) and DD8's outcome; the `install_project` handler's branching and wording; the warning through `registry.update`; the record's `scan`; the "being checked" status in `project_info` and `list_projects`; the sweep wired beside the reconciliation. `Installer.install` with scanning off is the current sequence unchanged. Docker-suite cases for blocked install and blocked reinstall.
- **Leg 6 — what the agent sees.** `check_project` with its job pattern (DD7); the generated instructions and `describe()` lines (DD8); the README section; Docker-suite case for the check tool.
- **Leg 7 — HAT and alignment** *(optional, agreed)*: the operator, in their own client, sees the status with scanning off, turns it on, checks and installs a project with npm hooks, adds a scanner, blocks a reinstall.

### Checkpoints
- [ ] Leg 1: suites green with no behavior change.
- [ ] Leg 2: every failure kind, bound and DD5 pattern has a unit case.
- [ ] Leg 3: a real clone's walk is read in full, or says incomplete; a timed-out clone leaves no container.
- [ ] Leg 4: a timed-out scanner leaves no container; a copy preserves the checkout; against real Docker.
- [ ] Leg 5: a blocked reinstall leaves a working project and says so; against real Docker.
- [ ] Leg 6: with scanning off, the agent is told so in the instructions, the install result and `project_info`; `check_project` runs with scanning off.
- [ ] Leg 7: the operator accepts.

### Adaptation Criteria

**Divert if**:
- Copying a volume through a container does not preserve the checkout (ownership, symlinks, executable bits) in a way the build depends on.
- Leg 1's split cannot be done without a behavior change.
- A mainstream scanner cannot be made to put SARIF on stdout even with a wrapper.
- Moving the install's prelude after the check (DD6.1) turns out to conflict with mission 02's ownership guarantees.

**Acceptable variations**:
- The exact hook files and red-flag patterns, as long as the README lists what is checked.
- Bounds (finding counts, string lengths, the walk's budgets, the sweep's margin) tuned from measurement.
- README work moving between legs 5 and 6.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [ ] `split-install` - Split `Installer.install` into the three pieces mission 02's debrief named, with no change in behavior
- [ ] `scan-rules` - Configuration, the scanner file, SARIF findings and their cleaning, the policy, and the built-in check's analysis; no Docker
- [ ] `clone-walk` - The named clone container, the bounded walk of build code and its parser, the pinned clone image
- [ ] `scan-in-docker` - The scanner runner, the guarded copy, the leftovers sweep
- [ ] `check-before-build` - The checked install: checking state, re-read, moved prelude, staging and copy, blocked installs and reinstalls, the outcome
- [ ] `agent-view-and-docs` - `check_project`, the security status in instructions and results, the README
- [ ] `hat-and-alignment` *(optional)* - Guided HAT (human acceptance test) session with iterative fixes

---

## Post-Flight

### Completion Checklist
- [ ] All legs completed
- [ ] Code merged
- [ ] Tests passing (unit suite on the hosted check; Docker suite locally)
- [ ] Documentation updated (README)

### Verification
- Unit suite: new cases pass; no existing case fails.
- Docker suite, locally: check of `tomnomnom/gron`; blocked first install leaves nothing; blocked reinstall leaves a project whose tool still runs; failed scanner reported, not blocking, its container gone; copy preserves the checkout; old leftovers swept, another owner's left.
- HAT: the operator's own client shows the status with scanning off and on, and a real npm project's hooks.
