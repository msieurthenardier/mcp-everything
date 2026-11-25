# Flight: Checking What a Build Installed

**Status**: landed
**Mission**: [Vetted and Contained Installs](../../mission.md)

> **Planned with the operator on 2026-11-25**, after flight 4 (PR #33) merged. The operator asked that it not be over-engineered: it has the smallest shape that meets the criterion. Three things were decided with the operator:
> - a block after the build is accepted on a reinstall, and the result says so (DD6);
> - Ruby gems are moved onto the volume as well (DD2);
> - there is no HAT leg.

## Contributing to Criteria
- [x] **With scanning on, what a build installed is checked before its tools are published**, and generated tool descriptions are checked before they are published.
  - Flight 3 did the tool descriptions.
  - This flight does the first half: a scanner stage that runs after the build and before discovery. Build output is put where that stage can read it.
- [x] **With scanning on, a repository is checked before any of its code runs. … A project already installed under that slug is left working as it was.**
  - The check before the build is unchanged and still keeps the old project working.
  - The new check after the build cannot do the same on a reinstall: by then the old sandbox has been replaced (DD6). The docs say so.
- [x] **Which scanners run is always visible to the agent.** The server's instructions, install results and `project_info` name the build-stage scanners and their findings separately from the source-stage ones.
- [x] **The README describes what is checked and when, … what existing projects need after upgrading, and what none of this protects against.**
  - `docs/checking.md` gains the build stage and its limits.
  - The upgrade note says that existing projects keep working, and get the build check only once reinstalled.

---

## Pre-Flight

### Objective
Check what a build installed, before any of it runs. A new sandbox keeps its build output on the volume it already has: `/opt/mcpe` becomes a symlink to `/workspace/.mcpe`, and Ruby's gems go there too.
- **The build stage.** A scanner the operator marks `"stage": "build"` runs after a successful build. It runs before discovery runs any built program, and before the network policy is applied.
- **What the scanner sees.** The sandbox's volume, read-only, at `/scan`.
- **Same rules as today's scanners:** SARIF, time limits, and a failed scanner never blocks.
- **The policy** is applied to the build stage's findings on their own.
  - Under `block`, findings at or above the threshold stop the install: the project is `failed`, its sandbox is offline, and no tools are discovered.
  - Under `warn`, the findings are reported and the install goes on.
- **Older sandboxes.** They keep their layout and keep working, and are checked after the build only once reinstalled.

### Open Questions
- [x] How far to go → **the smallest shape that meets the criterion**; no new Docker object, no build-beside-and-switch (operator, 2026-11-25). DD1, DD6.
- [x] A block at the build stage on a reinstall → **accepted and stated**; the previous version was replaced before the build (operator, 2026-11-25). DD6.
- [x] What the build stage can see beyond `/opt/mcpe` → **Ruby gems too**; Go's module cache and Cargo's registry stay where they are (operator, 2026-11-25). DD2.
- [x] HAT → **none**; the unit and Docker suites and the review verify it (operator, 2026-11-25).
- [x] Does a venv, and do gems, work through a symlink into the volume? → **Yes**, verified by the Flight Director on 2026-11-25 with throwaway containers (`--rm`, anonymous volumes; nothing left behind). DD1, DD2.
  - **`python:3.13`:**
    - `python3 -m venv /opt/mcpe/venv` and `pip install cowsay` worked through the symlink;
    - the console script's shebang is `#!/opt/mcpe/venv/bin/python3`, and it ran;
    - the package was in `/workspace/.mcpe/venv/lib/python3.13/site-packages`.
  - **`ruby:3`**, with `GEM_HOME=/opt/mcpe/gems`:
    - `bundle install` and `gem install lolcat` both installed into `/workspace/.mcpe/gems/gems`;
    - `command -v lolcat` was `/opt/mcpe/gems/bin/lolcat`, and it ran.
- [x] Reinstall over a sandbox made before ownership (flight 4 debrief, recommendation 1) → **already satisfied**, so not part of this flight. See the Reconnaissance Report in the flight log.

### Design Decisions

**DD1. Build output goes on the sandbox's existing volume, through a symlink**: the recipe prelude makes `/opt/mcpe` a symlink to `/workspace/.mcpe`.
- **Before anything else, each build attempt:**
  - removes `/workspace/.mcpe`;
  - makes it again, empty;
  - links `/opt/mcpe` to it.

  The removal matters: a retry on the fallback image runs in a new container on the same volume, and must not see the first attempt's output.
- **The prelude's sequence**, inserted before its `mkdir -p ${BIN_DIR}` (`src/install/recipes.ts`, `PRELUDE`):
  1. `mkdir -p /opt`, which not every image has;
  2. `rm -rf /workspace/.mcpe` and `mkdir -p /workspace/.mcpe`, always, so that a retry never leaves the first attempt's output on the volume;
  3. if `/opt/mcpe` is a real directory (`[ -d ] && [ ! -L ]`), print `MCPE_WARN` and leave it alone; otherwise `ln -sfn /workspace/.mcpe /opt/mcpe`.

  *(Steps 2 and 3 were reordered at leg 1's design, 2026-11-25: the clearing used to run only in the link branch.)*

  A plain `ln -s` onto an existing directory would silently create `/opt/mcpe/.mcpe`; the explicit test is what prevents it.
- **Nothing writes `/opt/mcpe` before the recipe.** The Architect checked `createContainer`, containment, and `CLEAN_SCRIPT` on a retry (`src/install/installer.ts`, `buildAttempts`). A stopped and restarted sandbox keeps the link, which is in its container layer.
- **Nothing else changes:**
  - the path `/opt/mcpe` (`BIN_DIR`, `VENV_DIR` and `PREFIX` in `src/sandbox/scripts.ts`);
  - the recipes;
  - discovery (`src/install/discovery.ts:128` and `:156` read `VENV_DIR` and `BIN_DIR`);
  - the sandbox's `PATH`.
- **An image that already has `/opt/mcpe`** (an operator's or a caller's own image) is left as it is. The prelude prints `MCPE_WARN`, which reaches the record's warnings, and the build stage sees only what is on the volume.
- Rationale:
  - no new Docker object, so no new ownership surface;
  - no path changes in the code, so older sandboxes are untouched;
  - the build-stage scanner reads one volume that the existing `requireVolumes` gate already covers.
- Trade-off:
  - source and output share a volume, so a build-stage scanner sees both (output at `/scan/.mcpe`, the checkout at `/scan/repo`);
  - a hidden directory on the volume can be changed with `sandbox_exec`, as `/opt/mcpe` could be before. A hostile agent is outside the mission.

**DD2. Ruby gems go on the volume as well; Go's and Cargo's caches do not.**
- Every new sandbox is created with `GEM_HOME=/opt/mcpe/gems`, and `/opt/mcpe/gems/bin` is added to its `PATH`, after `BIN_DIR` and before the venv's `bin` (`createContainer`, `src/sandbox/docker.ts`, the `env` block and `path`). The variable is harmless in a non-Ruby image.
- Go's module cache (`/go/pkg/mod`) and Cargo's registry (`/usr/local/cargo`) are not moved:
  - they hold the dependencies' source, which the source stage's dependency check already covers for GitHub repositories;
  - the binaries built from them land in `/opt/mcpe/bin`;
  - `/usr/local/go` is the Go toolchain, not build output (the mission text listed it).
- Rationale: without `GEM_HOME`, a Ruby project's installed gems would be invisible to the check.
- Trade-off: what a Go or Rust build downloaded is seen only through the binaries it produced. This is stated as a limit.

**DD3. Older sandboxes are not migrated.** A sandbox created before this flight keeps a real `/opt/mcpe` in its container layer, its `PATH` and no `GEM_HOME`, all fixed when it was created.
- It keeps working, and nothing reads `/workspace/.mcpe` at run time.
- The check after the build runs only when a build runs, that is on install and reinstall, so an older project gets it once reinstalled.
- The upgrade note in the docs says this.
- Rationale: as mission 02 did for ownership labels; nothing breaks.
- Trade-off: until reinstalled, an older project's build output has never been checked.

**DD4. The scanner contract gains `"stage": "build"`.**
- **The `stage` field.**
  - `src/scan/scanners-file.ts` accepts `"source"` (the default) or `"build"`. Any other value is refused at startup, as today.
  - `ScannerSpec` gains an optional `stage?: "source" | "build"`, where absent means `source`. The parser, `runScanner` and the source stage's filter all read it that way, so the specs built inline in tests (`test/scan-policy.test.ts`, `test/scan-run.test.ts`, `test/integration/docker.test.ts`) keep compiling.
  - Each entry runs at one stage; a scanner wanted at both is listed twice, under two names.
- **How a build-stage scanner runs:**
  - in the one-shot `scan` role container scanners use today, with the same limits, runtime, network rules (`network`, `hosts` under containment), `env` handling and redaction;
  - the sandbox's volume is mounted read-only at `/scan`, and **the working directory is `/scan`**, not `/scan/repo` as at the source stage. Scanners default to `.`, and the build's output is outside the checkout: `/scan/.mcpe` (DD1), and Rust's and CMake's `/scan/target` and `/scan/build`. The docs name all three paths;
  - it is given no other volume.
- **Each stage runs only its own scanners.** The source stage (`checkClone`, which `check_project` also uses: `src/install/installer.ts`, the `runScanners` call) is given only `stage: "source"` scanners. Without that filter, build-stage scanners would also run over the staging clone.
- **How the Docker method knows the stage.** `runScanner` reads `spec.stage`:
  - `source` requires a staging volume and sets the working directory to `/scan/repo`, as today;
  - `build` requires a sandbox volume (no role) and sets `/scan`.

  `ScanDocker` and `runScanners` (`src/scan/run.ts`) keep their signatures. A build spec given a staging volume is refused by `requireVolumes`, and so is the reverse, so a mix-up fails closed.
- **`unreachableBlock`** (`src/scan/policy.ts`) stays as it is. It counts every scanner, so a build-only scanner silences its note. That is correct: blocking is reachable, at the build stage.
- **Built-in checks.** None at this stage: `build-hooks` and `dependencies` stay at the source stage.
- **Time budget.** Build-stage scanners have their own budget of `MCPE_SCAN_TIMEOUT`, counted as the source stage's is (`runScanners`, `src/scan/run.ts`).
- **Source-stage scanners** run as today, and the source stage's built-in checks are unchanged.
- Rationale: it is the extension the field was reserved for (`docs/checking.md`: "`stage` is accepted with the value `"source"` and has no effect today").
- Trade-off: listing a scanner twice for both stages repeats its entry. It is simpler than a list of stages, and the file caps entries at 16.

**DD5. When the build stage runs, and when it does not.**
- **It runs** after a build attempt that exited 0: before the network policy is applied (`setNetwork`), before discovery, and before the record turns `ready`. It comes after the build's refusals are read.
- **Where.** In `finishInstall` (`src/install/installer.ts`), right after the failed-build branch (`if (res.code !== 0)`) and before `wantNetwork`. That one place serves both the contained and the uncontained branch.
  - `finishInstall` reads `this.cfg.scan.mode`. The server sends an install to `install` only when scanning is off, and to `installChecked` otherwise, so the unchecked path never runs the stage.
  - If `record.scan` is unset (`install` called directly, as tests do), the stage is skipped. A `build` part cannot be stored without the source report it belongs to. `installChecked` sets `record.scan` before `finishInstall`.
- It runs only when:
  - scanning is on (`MCPE_SCAN` is `warn` or `block`), and
  - at least one scanner has `"stage": "build"`.
- **It does not run:**
  - after a failed build, which publishes nothing anyway;
  - in `check_project`, which builds nothing. Its report says the build stage was not run, when build-stage scanners are configured;
  - in `discover_tools`, `refresh_mcp` or `connect_mcp_server`.
- Rationale:
  - discovery runs the built programs (`--help`) and starts MCP servers, so the check must come first;
  - building by hand with `sandbox_exec` is the agent's own act, and a hostile agent is outside the mission.
- Trade-off: a process the build left running can change files after the check. So can anything that runs later. This is stated as a limit, not engineered around (no `docker pause`).

**DD6. What a block at the build stage does.**
- **The verdict.** The policy (`decide`, `src/scan/policy.ts`) is applied to the build-stage outcomes alone. Under `block`, findings at or above `MCPE_SCAN_BLOCK_AT` make the verdict `block`.
- **What happens on a block:**
  - the sandbox is taken offline, through the same path a failed build uses (`takeOffline(record, "failed", sandbox)`);
  - the record is `failed`;
  - the record's error says the build-stage check blocked it, with the counts and the findings in the report;
  - discovery does not run, and no tools are published;
  - the branch reuses the failed build's ending: `status = "failed"`, `takeOffline`, `putKeeping`, return. Under containment it first pushes the build's refusal warnings (`refusalWarnings(refused, …)`), which today are pushed only later in the success path and would otherwise be lost.
- **A reinstall** was blocked after its old sandbox had already been replaced (`retireOldSandbox` runs before the build). The result and the record's error say that the previous version was replaced before the build and is not restored (operator, 2026-11-25).
- **Under `warn`**, findings are reported and the install goes on.
- **A scanner that fails or times out** is reported and never blocks, as today.
- Rationale:
  - the operator chose the smallest shape;
  - building beside the old sandbox and switching over would touch names, the registry, and containment's per-sandbox network and proxy.
- Trade-off: a blocked reinstall at this stage leaves the project without a working sandbox until the operator decides. The source-stage check, which runs first, still keeps the old project on its own blocks.

**DD7. The record holds the build stage's report alongside the source stage's.**
- `ScanReport` (`src/scan/types.ts`) gains an optional `build?: { checks: CheckOutcome[]; decision: ScanDecision; at: string }`, kept in `record.scan`.
- The registry's `version` stays 1:
  - an older build reading the file ignores the field;
  - a newer build reading an older record finds no `build` and shows none.
- How the report is shown:
  - `renderReport` (`src/server.ts`) shows the build stage after the source stage, under its own heading, in install results and `project_info`;
  - the server's instructions name build-stage scanners separately from the source-stage ones (`src/server.ts:58`).
- **`project_info`'s `security:` line** (`securityLine`, `src/server.ts`) adds the build stage's counts after the source stage's.
  - When build-stage scanners are configured now and the record has no `build`, it says "build output not checked at install". That covers an older sandbox, or scanning that was off then. Without it, "scanned at install: 0 error" would hide that the output was never checked.
- **Reading a stored `build`.** It is read through a type guard: a malformed stored value is treated as absent, as other stored fields are.
- **Freshness.** The report is a snapshot taken at install. Its source of truth is the build output as it was when checked. It is never refreshed by `discover_tools`, `refresh_mcp` or `sandbox_exec`; only a reinstall replaces it. The docs say "at install".
- Rationale: one report per install, and the agent can see which stage found what.
- Trade-off: none worth naming. The shape is additive.

**DD8. The build-stage scanner goes through the ownership gate. No new way to obtain a `SandboxRef`.**
- The Docker method that runs a build-stage scanner requires the sandbox's volume to be this installation's sandbox volume (`requireVolumes([{ name, role: "none" }])`, `src/sandbox/docker.ts`), and so goes through `refuseUnless`. A `before`, another's or not-ours volume is refused, as everywhere else.
- It takes a volume name, not a container, and returns a `OneShotResult`.
- **The method** is `runScanner`, which picks its role from `spec.stage` (DD4).
  - `role: "none"` admits any role-less volume this installation owns. The caller passes the record's own volume; the gate does not bind to one sandbox, and the docs and comments do not claim it does.
  - Its row in the bypass table (`test/docker-bypass.test.ts`, `runScanner: "a one-shot scanner"`, next to `copyVolume`) is updated in the same leg (flight 4 debrief, recommendation 1).
  - `test/sources.ts` has no row for it and needs none.
- Rationale: carried from flight 4's debrief. Every Docker call that reads a sandbox's volume is gated.
- Trade-off: none.

**DD9. Limits stated in `docs/checking.md` under "What none of this protects against"**:
- a build can leave a process that changes files after the check;
- a build by hand followed by `discover_tools` is not checked again;
- Go's module cache and Cargo's registry are seen only through the binaries built from them;
- an image that has its own `/opt/mcpe` keeps its output off the volume;
- older sandboxes are checked after the build only once reinstalled;
- a block after the build on a reinstall leaves no working sandbox;
- while the build-stage scanners run, the sandbox is still on its build network (or its build allowlist under containment), so a process the build left running keeps that reach for up to `MCPE_SCAN_TIMEOUT`;
- a scanner runs with all capabilities dropped, so a file the build made unreadable (mode 000) is hidden from it, and a scanner that fails for it never blocks;
- code installed outside the volume is not seen: `npm install -g` of pnpm or yarn, and system packages from `apt-get` (the CMake and autotools recipes' `need`);
- absolute symlinks under `/scan/.mcpe` (`link_elves`, Ruby's executables, the venv's `python`) dangle inside the scanner. Their targets are on the volume under `/scan/repo` or `/scan/build`, or in the image.

**DD10. A project blocked after its build stays blocked until it is reinstalled.** The Architect found that without this the block would be one call deep: `discover_tools` has no status gate (`src/server.ts`, `case "discover_tools"`), and `rediscover` ends in `finish()`, which sets `ready` (`src/install/installer.ts`). The failed-install advice even tells the agent to "repair the build with sandbox_exec … and then run discover_tools". That runs the blocked programs and publishes their tools.
- **The marker** is `record.scan.build.decision.verdict === "block"`, read through DD7's guard. There is no new field.
- **What refuses.** The check is in the installer, not the server, so that any caller meets it.
  - One helper, `assertNotBlocked(project)`, is called at the top of the four installer methods that end in `finish()`: `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp`. It throws before `discover` runs anything. A check inside `finish()` would come too late.
  - The thrown message is what `discover_tools`, `refresh_mcp`, `connect_mcp_server` and `disconnect_mcp_server` return: the project was blocked by the check after the build, and it can be reinstalled (`install_project` with `reinstall: true`) or the policy changed by the operator.
  - `refresh_mcp`'s own `failed` gate in the server stays. Its message no longer says "repair … run discover_tools" for a blocked project.
- **Already safe, checked by the second review:**
  - `call_project_tool` requires `ready`;
  - `listTools` and `find_project_tools` skip records that are not `ready`;
  - `select_project_tools` publishes from an empty catalog;
  - startup reconciliation touches only `installing`.
- **`set_project_network` on a blocked project stays allowed.** It runs no program; a networked, blocked sandbox is reachable only through `sandbox_exec`, which is the agent's own act.
- **The advice after a failed install** (`src/server.ts`, the `installed.status !== "ready"` branch) splits on the marker:
  - blocked: "blocked after the build; reinstall, or ask the operator to change the policy";
  - otherwise unchanged.
- **The server's instructions** (`src/server.ts:39`, "If automatic installation fails or finds no commands, finish the build yourself with sandbox_exec, then run discover_tools.") add that this does not apply after a block by the check after the build: reinstall instead.
- **The marker clears only by a reinstall**, which replaces the record. Nothing else turns a blocked record `ready`.
- Rationale: the block must hold through the server's own documented recovery path, not only through the install.
- Trade-off: the agent cannot repair a blocked build by hand. Repairing by hand is meant for a broken build, not a refused one.

### Prerequisites
- [x] Flight 4 merged to `main` (PR #33, `1034afb`).
- [x] The default sandbox images are present locally for the premise checks and the Docker suite: `python:3.13`, `ruby:3`, `golang:1`, `rust:1` and `node:lts`, checked 2026-11-25.
- [x] The venv and gems work through the symlink, verified 2026-11-25 (Open Questions).
- [x] Docker available for `npm run test:docker` before the PR is marked ready, as in flights 1–4 (Docker 29.8.2, Docker Desktop on WSL2).

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [x] Prerequisites verified (Docker is checked at the leg's start)
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
**Leg 1: output on the volume.**
- **The prelude** (`src/install/recipes.ts`, `PRELUDE`) gains the symlink step of DD1, before its `mkdir -p ${BIN_DIR}`. It refers to the paths through the existing constants (a new `OUTPUT_DIR` constant of `/workspace/.mcpe` in `src/sandbox/scripts.ts`), never through anything from the repository.
- **`createContainer`** gains `GEM_HOME` and the gems `bin` on `PATH` (DD2).
- **Unit tests** pin the prelude's text and the container's environment.
- **The Docker suite's Go install** (gron, `test/integration/docker.test.ts`, the leg 8 contained install and the first uncontained one) additionally asserts that:
  - `/opt/mcpe` is a symlink to `/workspace/.mcpe`;
  - the built binary is at `/workspace/.mcpe/bin/gron`.

  The npm install (cowsay) needs no change: it already builds into the repo.
- **The retry test** (`FailsFirstBuild`, `test/integration/docker.test.ts`) writes its debris to `/workspace/.mcpe/bin/stale` and asserts it is gone after the retry. Today it fakes the first attempt without the prelude, so it would pass without proving DD1's clearing.

**Leg 2: the build stage.**
- **The contract and the stage:**
  - `stage` in the scanners file and `ScannerSpec` (DD4);
  - the gated Docker method (DD8);
  - the build stage in `finishInstall` (DD5);
  - the source stage's filter (DD4);
  - the block path (DD6);
  - `ScanReport.build`, its rendering and the `security:` line (DD7);
  - the refusals and advice for a blocked project (DD10).
- **Telling the agent:**
  - the server's instructions;
  - `check_project`'s note that the build stage was not run;
  - the docs (`docs/checking.md`'s scanner section, the stage, the limits of DD9; the upgrade note).
- **Unit tests** with the scripted Docker:
  - parse `stage`;
  - a warn and a block at the build stage, on an install and a reinstall;
  - a failed build-stage scanner does not block;
  - build-stage scanners do not run at the source stage or in `check_project`;
  - after a block, `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp` throw, tested on the installer itself and once through `discover_tools`; the status stays `failed`;
  - the `security:` line with and without a `build` report;
  - the build stage does not run after a failed build, with scanning off, or with no build-stage scanner;
  - rendering;
  - the ownership refusal of a `before` volume.
- **The Docker suite** gains one case:
  - install gron with a build-stage scanner that is a shell script in the probe image;
  - the script lists `/scan/.mcpe/bin` and prints one SARIF result naming `gron`;
  - run it under `block` with the threshold at the result's level: the project is `failed`, has no tools, its sandbox is offline, and `discover_tools` is refused;
  - and under `warn`: `ready`, with the finding in `project_info`.

### Checkpoints
- [x] Leg 1: new sandboxes keep their build output on the volume; the Docker suite passes with the new assertions.
- [x] Leg 2: a build-stage scanner's findings reach the agent, and under `block` stop the install before discovery; the Docker suite passes with the new case.
- [x] The flight-end review confirms; the Docker suite passes on the final tree.

### Adaptation Criteria

**Divert if**:
- A default image's build does not work through the symlink in the Docker suite in a way the prelude cannot fix. Raise it to the operator: the fallback is a second, owned volume, which brings back the new ownership surface DD1 avoided.
- Running the build stage before the network policy turns out to need a change to containment's sequence, beyond reading the volume. Raise it before changing containment.

**Acceptable variations**:
- Whether the gated scanner method is new or a parameter of `runScanner` (DD8).
- The wording and placement of the build stage in `renderReport`, within DD7.
- Extra unit cases for edge cases found in the leg.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `output-on-the-volume` - `/opt/mcpe` a symlink to `/workspace/.mcpe`, cleared per attempt; `GEM_HOME` on the volume; the Docker suite asserts where gron's binary is (DD1–DD3).
- [x] `build-stage-scanners` - `"stage": "build"`, the gated scanner run after the build and before discovery, the block path and its hold (DD4–DD6, DD8, DD10), with the Docker case.
- [x] `build-stage-reporting` - the build stage's report, the `security:` line, the instructions, `check_project`'s note, and `docs/checking.md` with DD9's limits and the upgrade note (DD5, DD7, DD9).

*(At design, the original leg 2 was split into these two, 2026-11-25. The leg design review found it too large for one pass, and enforcement and reporting are a risk boundary. They are reviewed and committed together.)*

No HAT leg (operator, 2026-11-25).

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [ ] Code merged
- [x] Tests passing (`npm test`, `npm run test:slow`, `npm run typecheck`, `npm run build`, `npm run test:docker`)
- [x] Documentation updated (`docs/checking.md`, the README's summary if it names the stages)

### Verification
- **Unit tests:** `npx vitest run` passes. The new cases cover:
  - the `stage` field;
  - the build stage's warn, block, failure and skip paths;
  - a block on a reinstall;
  - the report's rendering;
  - the refusal of a volume that is not this installation's.
- **Docker suite:** `npm run test:docker` passes, with:
  - gron's binary on the volume behind the `/opt/mcpe` symlink;
  - the build-stage case: blocked under `block`, ready with the finding under `warn`.

  The Flight Director diffs Docker's object lists before and after each run.
- **An older sandbox still works.** A sandbox created before this flight keeps working: the Docker suite's existing reinstall-beside and old-sandbox cases still pass, unchanged.
- **The docs** name the build stage, what it sees, its limits and the upgrade note, and `test/readme.test.ts` passes.
