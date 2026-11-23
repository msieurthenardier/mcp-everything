# Flight Debrief: Checking Dependencies and Tool Descriptions

**Date**: 2026-11-23
**Flight**: [Checking Dependencies and Tool Descriptions](flight.md)
**Status**: completed
**Duration**: 2026-11-23 (planning) – 2026-11-23
**Legs Completed**: 4 of 4 (three autonomous and the HAT; HAT step 6 skipped by the operator)
**Plugin version**: mission-control 1.2.4

## Outcome Assessment

### Objectives Achieved
Two built-in checks now sit under flight 1's findings and policy.

**`dependencies`.** For a github.com repository, it asks GitHub for the dependency graph (SPDX SBOM) and asks OSV which exact versions in it are known to be malicious (`error`, `malicious-package`) or vulnerable (`warning`, `vulnerable-package`).
- **When it runs:** concurrently with the staging clone, at checked installs, and in `check_project` whatever `MCPE_SCAN` says.
- **What it reports:** every report says what was sent where (`CheckOutcome.contacted`, rendered by the formatter rather than as a note).
- **When it does not run:**
  - a pinned ref other than the default branch gives `not-run`, naming the default branch;
  - other forges get `not-run` and nothing is sent.
- **Safety:** HTTP is byte-capped and refuses redirects, and the GitHub token goes to GitHub only.
- **Default:** the lookup is inert unless injected, and the real client is wired only in `src/index.ts`.

**`tool-descriptions`.** It reads every piece of project-derived text a generated tool carries (`buildToolsWithText`), at the end of every discovery (`vetCatalog`, before `publish`).
- **Rules:** six, kept as data (`src/scan/tool-text.ts`).
- **Findings** never quote project text.
- **Under `block`,** a flagged tool is withheld. It disappears from the tool list, from `find_project_tools` and from `call_project_tool`, which answers "withheld". `project_info` names it. The project's other tools stay usable.

**Discovery** was first moved out of `installer.ts` into `src/install/discovery.ts` with no behavior change. That took `installer.ts` from 1,384 to 1,096 lines.

**The HAT on the operator's own installation** passed steps 1–5 and 7 with no code changes:
- **NodeGoat:** 1 error and 130 warnings, with 1,091 packages sent to OSV. The error is a real OSV `MAL-2023-462` entry for `fsevents 1.2.9`.
- **A pinned ref** (`gron v0.7.1`) gave `not-run`, and only GitHub was contacted.
- **A GitLab repository** gave `not-run`, and nothing was sent.
- **rea:** no finding across its 263 upstream tools and 28 generated ones.

### Mission Criteria Advanced
| Mission criterion | This flight |
|---|---|
| Scanning on with no scanner of the operator's own still finds known-bad dependencies | **Met** for GitHub repositories with exact versions (lockfiles). Ranges are counted, not looked up (`incomplete`); other forges are `not-run` |
| Generated tool descriptions, including tools added after the install, are checked before they are published | **Met** at every discovery (install, `discover_tools`, `refresh_mcp`, `connect_mcp_server`, `disconnect_mcp_server`). "What a build installed" is flight 4 |
| `check_project` gives the same findings an install would | **Met**, extended to `dependencies`; `tool-descriptions` does not apply (no tools without an install) |
| README: what reaches outside services, and what the checks catch and miss | **Met** ("The dependency check", "The tool-description check", "What reaches outside services") |

## What Went Well
- **Premises measured against the live services at planning.** These premises were measured before any design decision locked:
  - the SBOM answers without a token (60 an hour);
  - OSV's batch returns `MAL-` ids;
  - a repository without a lockfile gives ranges;
  - descriptions are bounded, but schemas are not.

  The HAT then matched them case for case.
- **Design reviews caught the design's real misses before code.**
  - **Review 1** had four highs:
    - the check in `publish` would be undone by `reselect`;
    - removing a tool made three surfaces misreport;
    - notes counted at `BLOCK_AT=note`;
    - `unreachableBlock` was stale.
  - **Review 2:** the inert-unless-injected lookup, and a structured `contacted` field.
  - **Leg 2's review:** an inert `not-run` would have broken four tests, and `isExactVersion` became an allowlist.
  - **Leg 3's reviews:**
    - `\b` missed `mcp__mcp-everything__install_project`;
    - sentence splitting cut `~/.ssh`;
    - "api key" fired on ordinary help, so the rule now needs a verb.

  None of these became rework in code.
- **Mutation trials as the evidence that tests mean something.**
  - **Legs 2 and 3:** six trials each, every one making a named test fail. One trial exposed a policy test that built its outcome by hand and would not have failed; it now runs the real lookup.
  - **The flight review:** about 40 mutations, with four uncaught. All four were closed with a mutation proof each.
- **Extract-then-change (DD1) worked again.** The moved bodies were verified identical by a normalized diff (`this.`/`ctx.`/`deps.` as one token), so leg 3 could add `vetCatalog` to a 453-line module of its own.
- **Risk tiering was proportionate.**
  - Leg 1 (low risk) skipped design review.
  - Legs 2 and 3 (high risk) got two reviews each.
  - The flight-end review found no blocking issue.
- **The fix-vs-feature gate held at the HAT.** The operator's "the README got really big" was routed to flight 4's first leg rather than done inline: a reorganization across four flights' documentation, `package.json` and a test.
- **The Docker gate held.**
  - The Flight Director read the new destructive cases before the first run.
  - The operator's containers, volumes and networks were diffed before and after: 23/254/8, unchanged.
  - The one failure was triaged to flight 2's code and squawked (0057).

## What Could Be Improved

### Process
- **A Developer again wrote files with shell commands.** Leg 3's Developer used node scripts, heredocs and `sed` against the Edit/Write-only rule restated in its spawn prompt. Flight 2 recorded the same.
  - The Flight Director checked what was written: no literal invisible characters in `src` or `test`, and no stray files.
  - The Reviewer read the affected files closely, and nothing was mangled.
  - The operator's call at this debrief: keep restating the rule (no hook).
- **Leg 1's Developer skipped a listed verification step** (the side-by-side read of the moved bodies); the Flight Director did it. The step was in the leg's Verification Steps, not its Acceptance Criteria, which is likely why it was treated as optional.
- **Planning measured the services but not the data shapes edge cases depend on.** Three facts surfaced only at leg design review:
  - pypi versions are bare;
  - GitHub Actions are pinned by sha (as `pkg:githubactions`);
  - the suite's own fixtures include two hostile catalogs.

  The last made leg 3's planned divert criterion ("no finding on the suite's catalogs") unsatisfiable as written. Each cost a leg-artifact revision, not code.
- **Flight text not corrected after an accepted variation.** DD3 still says "highest CVSS base score". OSV gives a CVSS *vector*, so GitHub's `database_specific.severity` label is used. That is recorded in leg 2 and the flight log, and now annotated in the flight.

### Technical
- **`src/server.ts` is the debt now: 1,723 lines** (1,641 before; 1,266 before flight 2).
  - Six surfaces must each remember withheld tools: `findGenerated`, `refresh_mcp`, `connect_mcp_server`, `discover_tools`, `find_project_tools` and `describe`.
  - A shared accessor over `toolCheck` would stop a seventh from forgetting.
  - The sent-statement is rendered at three `renderReport` sites.

  | File | Before | After |
  |---|---|---|
  | `src/install/installer.ts` | 1,384 | 1,096 |
  | `src/install/discovery.ts` (new) | — | 453 |
  | `src/server.ts` | 1,641 | 1,723 |
  | `src/scan/dependencies.ts` (new) | — | 502 |
  | `src/scan/tool-text.ts` (new) | — | 202 |
  | `src/toolgen/discover.ts` | — | 521 |
  | `README.md` | 1,472 | 1,596 |
- **The first outbound path outside containment.** The dependency lookup runs in mcp-everything's own process, with these mitigations:
  - fixed hosts;
  - `redirect: "error"`;
  - byte caps;
  - 15 s per request and 60 s overall;
  - the token sent to GitHub only.

  The README states it, but no design decision in the containment code records the exemption. Flight 4's split of `src/network/containment.ts` should say explicitly that this path is not the proxy's, so a later "everything through the proxy" change does not break or silently re-route it.
- **The inert-unless-injected default fails silently.** If `src/index.ts` stopped injecting the real lookup, the check would simply never run. One regex test over `src/index.ts` is the only pin. A sturdier signal would be a typed required option, or a startup self-report.
- **One registry, per-session scan modes, last writer wins.** A `warn` session's discovery republishes what a `block` session withheld. This is documented in the README, not enforced. `toolCheck.mode` is recorded but not consulted at call time.
- **Upstream tool-list changes are not watched.** mcp-everything announces its own `listChanged`, but a proxied server that changes its tools later is not checked until the next discovery (`refresh_mcp`). The freshness contract states this; it is a limit, not a defect.
- **Small leftovers:**
  - `GithubOsvOptions.now` is declared ("Reserved") and never read (`src/scan/dependencies.ts:232`).
  - `src/scan/sarif.ts` now exports its internal helpers (`isObject`, `own`, `clean`) for `dependencies.ts`. A small `src/scan/util.ts` is their natural home.
- **`secret-reference` false-positive rate.** On ten ordinary texts the reviewer wrote to be ambiguous, five fired, at `warning` only. At the default `block` threshold (`error`) that withholds nothing. A `BLOCK_AT=warning` operator would see it, and the README's "can misfire" covers it.

### Documentation
- **README size.**
  - 1,596 lines, against 1,032 at the mission's start.
  - About 935 of those lines are the three security chapters.
  - **Decided at the HAT:** flight 4's first leg moves them, unchanged, to `docs/checking.md`, `docs/containment.md` and `docs/security-model.md`. It also adds `docs` to `package.json` `files` and repoints `test/readme.test.ts`. The name is not `SECURITY.md`, which GitHub reads as the vulnerability-reporting policy.
- **Not written down anywhere a Developer reads:**
  - the `scan` versus `toolCheck` split (different lifetimes: `scan` is install-time, `toolCheck` is per discovery);
  - the withheld-tool contract across the six surfaces;
  - the inert-unless-injected pattern for outside-service stages.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| `vetCatalog` at the end of `discover`, not in `publish` (DD6) | `reselect` calls `publish` on the stored, already-filtered catalog | Yes: a check that changes the catalog runs where the catalog is built |
| Project text carried transiently (`buildToolsWithText`), not stripped back out of stored descriptions (DD5) | Template text cannot be removed exactly | Yes, for any check on derived text |
| The inert lookup answers `undefined` (no outcome), not `not-run` (leg 2) | `not-run` would have added an outcome to every existing installer test | Yes: an inert default must be invisible |
| `isExactVersion` as an allowlist | A denylist let npm specs and Maven placeholders through | Yes |
| "N looked up" as a `lookedUp` field, not a note | Notes count at `BLOCK_AT=note` | Yes: informational text that is not a finding is never a note |
| Severity label is GitHub's `database_specific.severity`, not CVSS (DD3) | OSV gives a vector, not a score | Accepted; DD3 annotated |
| `names-control-tool` uses alphanumeric lookarounds, not `\b` | `\b` treats `_` as a word character, missing `mcp__…__install_project` | Yes |
| `secret-reference` needs a sending verb in the same sentence | "api key" alone fired on ordinary help text | Yes |
| README's security chapters move to `docs/` in flight 4 (HAT) | README size; operator's request | Yes |

## Key Learnings
- **Measure the data shapes, not only the services.** The planning trials proved GitHub and OSV answer. The leg reviews then found the shapes that mattered: bare pypi versions, sha-pinned actions, `pkg:github` for the repository itself, and hostile fixtures in the suite. For any check over third-party data, sample at least one repository per ecosystem the check claims, and read the test fixtures, before locking criteria.
- **An inert default must add nothing.** A default that reports `not-run` changes every existing caller's output. One that answers nothing changes nothing. Wire the real thing at one place, and pin that place.
- **A check that removes tools has to be visible everywhere tools are named.** Removing a tool affected six surfaces in this flight. Any future catalog filter should go through one accessor.
- **Never quote what you flagged.** Findings name the tool, the rule and a position. They never quote the text, which would re-deliver the injection to the agent being protected.
- **A client caches a server's instructions per session.** To verify the instructions mid-session, the Flight Director rendered them from the running process's own environment (`buildInstructions(loadConfig())`), because its own copy was from session start.

## Methodology Observations
- **Agentic-workflow, Developer rules (1.2.4).**
  - **What happened:** the project's Edit/Write-only rule was restated in leg 3's Implement spawn, and the Developer still wrote files with node scripts, heredocs and `sed` for test appends and multi-site replacements. It disclosed this in its log entry.
  - **Expected:** no shell writes.
  - **Cost:** a Flight Director check (grep for literal invisible characters, a stray-file check) and a closer Reviewer read; no damage.
  - **History:** the second flight running (flight 2 recorded the same).
  - **Operator's choice:** keep restating the rule rather than add a hook. Recorded for the sweep.
- **Agentic-workflow, low-risk leg verification (1.2.4).**
  - **What happened:** leg 1 (low risk, no design review) listed "a side-by-side read of the moved bodies" under Verification Steps. The Developer ran the typecheck, build and tests but did not do the read.
  - **Expected:** the Developer performs the listed verification steps, or says it did not.
  - **Cost:** the Flight Director did the normalized diff itself before leg 2.
  - **Why it matters:** for a low-risk leg there is no other gate before the flight-end review, so a skipped verification step is the whole check.
- **Flight skill, Phase 4 premise audit (1.2.4).**
  - **What happened:** the skill's "a DD that rests on an empirical premise should have that premise verified" was followed for the services (reachability, auth, `MAL-` ids, range-only graphs), but not for the data shapes the edge cases depended on (per-ecosystem purl shapes, the suite's own fixtures).
  - **Cost:** three leg-artifact revisions at leg design review (leg 2's version allowlist and actions exclusion; leg 3's unsatisfiable divert criterion). No code rework.
  - **Expected:** the premise audit to name "the shapes of the data the criteria depend on" alongside "can the apparatus act and observe".
- **Agentic-workflow, HAT legs that verify an MCP server (1.2.4).**
  - **What happened:** HAT step 1 asked to confirm the server's instructions after a reconnect, but the Flight Director's own view of them is fixed at session start.
  - **Workaround:** rendered from the live process's environment.
  - **Expected:** a HAT step that verifies what a client sees to say how it will be observed (an observability premise, as the flight skill already asks of behavior tests).
  - **Cost:** a few minutes; recorded because the next MCP HAT will meet it.
- **Agentic-workflow, HAT fix-vs-feature gate (1.2.4).**
  - **What happened:** worked as written. An operator request at the HAT (split the README) was classified out loud, routed to a later flight with the operator's agreement, and recorded in the mission.
  - **Why recorded:** as a positive data point for the sweep.
- **Flight-debrief, crew interviews (1.2.4).**
  - **What happened:** given explicit paths and a summary of the flight's shape, both interviews returned usable, mostly accurate input this time.
  - **Corrections needed:**
    - The Developer did not reconcile the test delta. The +236 is 109 (leg 2) + 124 (leg 3) + 3 (flight review).
    - The Architect read "no `listChanged` handling" too broadly; mcp-everything does announce its own changes.
  - **Expected:** none beyond this. Recorded as the comparison point to flights 1 and 2, where the interviews read the long logs only partly.

## Recommendations
1. **Clear squawks 0057 and 0058 in a turnaround before flight 4** (operator, at this debrief). 0057 widens `POOL_OVERLAPS` for Docker 29's "conflicts with network". 0058 replaces the 8 MB wall-clock bound with a relative one. Flight 4 then starts from a clean Docker run and a stable unit baseline.
2. **Give the withheld-tool view one home in `src/server.ts`.** Add one accessor over `toolCheck` that `findGenerated`, `refresh_mcp`, `connect_mcp_server`, `discover_tools`, `find_project_tools` and `describe` all use, so a seventh surface cannot forget. This fits the mechanical-split leg of a later flight, or a sortie; it changes structure, not behavior.
3. **In flight 4's design, state the in-process outbound path explicitly.** The containment split and the post-build scanner stage must record that the dependency lookup is mcp-everything's own traffic, not the proxy's. Any new stage that calls an outside service follows the same pattern: inert unless injected, `contacted` recorded, a sent-statement rendered.
4. **Sample data shapes at planning for checks over third-party data.** Planning should cover one repository per claimed ecosystem, the suite's own fixtures, and every identifier form the parser will meet. Do this before locking acceptance criteria that depend on them.
5. **Bring the unit suite's two slow files out of the default run** (flight 01's and 02's recommendation, still open). These are `proxy-server.test.ts` (17.2 s, real sockets) and `docker.test.ts` (14.5 s, real shells). They pin the suite at 18.2 s; this flight's new files add almost nothing.

## Action Items
- [ ] Squawk turnaround before flight 4: 0057, 0058, 0059 and 0060 (operator's decision).
- [ ] Flight 4, leg 1: move the README's security chapters to `docs/` (decided at the HAT; recorded in `mission.md`).
- [ ] Flight 4 design: record the in-process outbound exemption (recommendation 3), and carry recommendation 4 into its planning trials.
- [ ] A later structural leg or sortie: the withheld-tool accessor (recommendation 2).
- [ ] Squawk 0059: delete the unused `GithubOsvOptions.now` (deferred to the turnaround before flight 4).
- [ ] Squawk 0060: move `isObject`, `own`, `clean` from `sarif.ts` to `src/scan/util.ts` (deferred to the same turnaround).
- [ ] Backlog (new behavior, not a squawk): the number of tools checked on the `tool descriptions:` line, offered at the HAT and not taken up.

## Test Metrics
Measured on the flight branch at `7cba933`, one run.
- **Unit suite** (`npx vitest run`): 2,987 passed, 71 skipped, 0 failed; 18.2 s wall clock. No flake on this run; squawk 0058's test took its usual time (`scan-sarif.test.ts` 1.46 s).
  - Against flight 02: 2,751 passed, 71 skipped, 17.4 s. That is +236 tests (leg 2: 109, leg 3: 124, flight review: 3), skips unchanged, and +0.8 s.
  - Against flight 01: 1,511 passed, 13.35 s.
- **Per file** (parallel workers; the suite is bound by its longest file):

  | File | Tests | Time | Flight 02 |
  |---|---|---|---|
  | `proxy-server.test.ts` | 94 | 17.2 s | 94, 17.1 s |
  | `docker.test.ts` | 725 | 14.5 s | 725, 15.6 s |
  | `server.test.ts` | 273 | 1.75 s | 236, 1.7 s |
  | `scan-sarif.test.ts` | 31 | 1.46 s | 31, 1.55 s |
  | `proxy.test.ts` | 92 | 1.34 s | 92, 1.3 s |
  | `installer.test.ts` | 235 | 0.98 s | 209, 0.8 s |
  | `scan-build-hooks.test.ts` | 209 | 0.73 s | — |
  | `containment.test.ts` | 129 | 0.63 s | 129, 0.59 s |

  The new `scan-dependencies.test.ts` and `scan-tool-text.test.ts` do not reach the top ten: fake fetch and the inert lookup, no network.
- **Flakes this flight:**
  - The baseline's first run had 1 failure under load (35.9 s), which did not repeat.
  - The flight review saw `scan-sarif`'s 8 MB timing test fail once in three runs.
  - Both are squawk 0058.
- **Docker suite** (`npm run test:docker`, Docker 29.8.2, Docker Desktop): 65 passed, 1 failed, 5 skipped in 756.8 s. Flight 02's leg 14 run took 646 s.
  - **The failure** was `containment hook (leg 7) > two contained projects cannot reach each other`: a subnet race with a transient network, not retried because of Docker 29's wording. It passed alone, and is squawk 0057, in flight 2's code.
  - **The live dependency case** (`check_project` on gron with the real lookup) passed.
  - **The operator's Docker objects** were unchanged.
- **Typecheck**: clean. **Build**: clean.
