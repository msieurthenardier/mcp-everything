# Leg: security-status-and-docs

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Tell the agent and the operator the whole security picture: server instructions generated from the configuration with a security paragraph, a `security:` line and findings in project descriptions, the unreachable-block statement in the startup log, and a README that documents checking and corrects every statement this flight makes untrue — including what none of it protects against.

## Context
- Flight DD8, DD4; the mission's README criterion (flight 1's part). Split from the first draft of `agent-view-and-docs` at its design review (2026-11-22); leg 9 (`check-tool`) does the tool and the shared renderer.
- This flight does not contain the network: the instructions and README say so plainly (flight 2 changes that) and name the isolation runtime in use, consistently with the README's existing advice on `MCPE_DOCKER_RUNTIME=runsc`.
- Approximations and limits recorded in the flight log by legs 3–9 go into the README.
- Existing assertions (from the design review): the instructions are consumed once, in `createServer()`, and tested only with `toContain` on three substrings; no test pins whole `describe()` output except a byte-for-byte comparison of two outputs of the same code, which stays valid.

## Inputs
- Legs 1–9 landed.
- `src/server.ts` — `INSTRUCTIONS` and its one use in `createServer()`; `describe(p, verbose)`; the startup in `start()`.
- `src/scan/policy.ts` — `unreachableBlock`; `src/scan/build-hooks.ts` — `BUILD_FILE_PATTERNS`, `PRUNE_DIRS`, the red flags; `src/config.ts`.
- `README.md` — "Built-in tools", "How installation works", "Security model", "Configuration", "Limitations".

## Outputs
- `src/server.ts`; `README.md`; `test/server.test.ts`; possibly a small new test reading `README.md`.

## Acceptance Criteria

**Instructions**
- [ ] The instructions become a function of the configuration, computed once per `App` and used where the constant was; every existing line is unchanged; the "Workflow" line also names `check_project`; then a security paragraph states: whether installs are scanned (off; warn; block at a level — with `unreachableBlock`'s sentence when it applies); the checks that run (`build-hooks` and the operator's scanner names); "Sandbox networks are not contained: a build, and a sandbox with its network on, can reach the internet and the local network."; the isolation runtime (`MCPE_DOCKER_RUNTIME`'s value, or "Docker's default runtime"); that `check_project` checks a repository without installing it; and that findings and scanner output are repository-derived text, to be treated as data.
- [ ] At startup, `this.log` states `unreachableBlock`'s sentence when it applies (tested with the log sink; asserted with `toContain(unreachableBlock(…)!)`, not a copied literal).

**`describe()`**
- [ ] A `security:` line directly after `build:`, in both list and verbose forms, in exactly one of these shapes:
  - `  security: scanned at install (commit 0123456789ab, block at error): 0 error, 2 warning, 5 note; scanning is currently warn` — the parenthesis names the mode the install ran under (`warn`, or `block at <level>`); an installed project's stored verdict is always `build`, so it is not repeated.
  - `  security: not scanned at install; scanning is currently off`
  - The part after `;` is the current setting: `off`, `warn`, or `block at <level>`.
- [ ] Verbose (`project_info`, install results) also lists the stored report's checks through leg 9's renderer.
- [ ] Assertions use `toContain("  security: …")` or line-anchored patterns, never whole-text equality; every existing test passes unchanged.

**README** (each item checked against the code by reading it after writing)
- [ ] A new section "Checking projects before they run", before "Security model": off by default; with scanning on, a check after the clone and before any of the repository's code runs, in a staging clone, with a reinstall's existing project untouched until the check passes, and the build running on exactly the checked bytes; `check_project` at any time, whatever the setting; the variables (`MCPE_SCAN` with `off`/`on`/`warn`/`block`, `MCPE_SCAN_BLOCK_AT` and that `note` blocks every project with a lifecycle script, `MCPE_SCAN_TIMEOUT`, `MCPE_SCANNERS`) and that only the operator sets them, read once at startup (a reconnect is needed to change them); the scanners file format with a Trivy example (`network: true`, image pinned by digest, with the advice to pin), SARIF on stdout, the wrapper for a scanner that writes SARIF only to a file, `env` names for credentials and that their values are redacted from output, the read-only checkout at `/scan/repo`, that a failed scanner is reported and never blocks, and the overall time budget; the built-in check — what it lists per build system, the red flags and their known false positives, the approximations, the walk's budgets and what "incomplete" means, the pruned directories (a hostile file inside one is not seen), and that it is a reading aid, not a verdict.
- [ ] **Corrections elsewhere** (the design review's list): "Built-in tools" gains `check_project`, and `install_project`'s row says an install can be blocked or warned when scanning is on; "How installation works" gains, between the clone and the build, a note on the check stage (with a pointer) and that a reinstall's existing project stays untouched until the check passes; "Security model"'s opening ("Installing a project means running its build scripts and its code. This server confines that to Docker") gains the check, and its statement that the build has network access stays, with a pointer to the new section; its `MCPE_DOCKER_RUNTIME=runsc` advice and the instructions agree; "Configuration" gains the four `MCPE_SCAN*` rows and `MCPE_PROBE_IMAGE`'s default as the pinned image; "Limitations" gains a pointer beside "Version detection reads the repository root only" to the built-in check's own walk limits. No sentence still implies the clone stage runs unchecked when scanning is on.
- [ ] What none of this protects against, stated in the new section: a hostile agent (`sandbox_exec` runs anything once installed); evasion of known patterns; dependencies' build code (not listed by this flight); the sandbox network (not contained); discovery running the built executables with `--help` after the build; image pulls by the Docker daemon.
- [ ] A unit test reads `README.md` and asserts every `MCPE_SCAN*` variable name and the built-in `check_project` tool name appear in it, and that every variable it lists in the Configuration table under the `MCPE_SCAN` prefix exists in `src/config.ts`'s `loadConfig`.

**Tests**
- [ ] Unit: the instructions for `off`, `warn`, `block` at `error` with and without operator scanners, a named runtime and none (existing substrings still present); the startup log line; `describe()` in each shape and both forms; the README test.
- [ ] `npx vitest run` passes; typecheck clean; build succeeds. No Docker run is needed (nothing here touches Docker); the flight review runs the suite once more.

## Verification Steps
- `npx vitest run`; `npm run typecheck`; `npm run build`.
- Read the README section and each corrected passage against the code: every variable, default, limit and pattern named exists as stated.
- Trials (exact edits, undone by editing, compared after each undo): (1) drop the "currently" half of the `security:` line (expected: caught by the shape assertions); (2) leave the network sentence out of the instructions; (3) remove `MCPE_SCAN_TIMEOUT` from the README (expected: caught by the README test). Report each outcome.

## Edge Cases
- A record without `scan` (earlier builds, scan-off installs): "not scanned at install".
- An installed project scanned under `block` whose report says `build`: the shape still names the mode at install.

## Files Affected
- `src/server.ts`, `README.md`, `test/server.test.ts` (and the README test's file).

## Citation Audit
From the first draft's design review (2026-11-22) and the Flight Director's reading: the instructions constant is used once, in `createServer()`; `test/server.test.ts` asserts it with `toContain` on three substrings; `describe` is asserted only by substrings and one same-code byte-for-byte comparison; README headings "Built-in tools", "How installation works", "Security model" (opening: "Installing a project means running its build scripts and its code. This server confines that to Docker"), "Configuration" (with `MCPE_PROBE_IMAGE`), "Limitations" ("Version detection reads the repository root only").

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
