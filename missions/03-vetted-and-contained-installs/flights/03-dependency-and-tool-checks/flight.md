# Flight: Checking Dependencies and Tool Descriptions

**Status**: ready
**Mission**: [Vetted and Contained Installs](../../mission.md)

> **Planned with the operator on 2026-11-23.** The mission's tentative flight 3 ("Checking what a project brings with it") held three independent clusters of design decisions. At the operator's agreement it was split: this flight takes the two checks that run inside mcp-everything and change no sandbox layout. The layout change (build output onto a volume, a scanner stage after the build) becomes flight 4, together with the `docker.ts` split and the `before` ownership fix that flight 2's debrief puts ahead of it.

## Contributing to Criteria
- [ ] With scanning on and no scanner of the operator's own configured, the operator still gets… **for GitHub repositories, its dependencies that are known to be vulnerable or malicious** (the half flight 1 left).
- [ ] With scanning on, … **generated tool descriptions, including those of tools added after the install, are checked before they are published** (the "what a build installed" half is flight 4).
- [ ] The agent can have a repository checked without installing it, and gets the same findings an install would (extended to the dependency check).
- [ ] The README describes … **what reaches outside services when scanning is on** (GitHub's API and OSV), and what these two checks do and do not catch.

---

## Pre-Flight

### Objective
Add two built-in checks under flight 1's findings and policy. **`dependencies`** asks GitHub for a repository's dependency graph and OSV for which of those exact versions are known to be malicious or vulnerable, before the repository is cloned, at install (when scanning is on) and in `check_project` (always). **`tool-descriptions`** reads every generated tool's text — description, and every string an upstream MCP server put in its input schema — at the one place tools are published, at install and at every later discovery (`discover_tools`, `refresh_mcp`, `connect_mcp_server`), and under `block` withholds a flagged tool from the agent entirely while the project's other tools stay usable. Discovery is first moved out of `installer.ts` without changing behavior, as flight 1's debrief asked before checks were added there.

### Open Questions
- [x] Does `check_project` send to GitHub and OSV with scanning off? → **Yes** (operator, 2026-11-23: an explicit ask, as flight 1's rule for `check_project`). DD2.
- [x] Levels of dependency findings → **malicious = error, vulnerable = warning** (operator, 2026-11-23). DD3.
- [x] What happens to a flagged tool under `block` → **withheld** (operator, 2026-11-23). DD6.
- [x] HAT leg → **yes** (operator, 2026-11-23).
- [x] Split the mission's flight 3 → **yes** (operator, 2026-11-23); this flight and flight 4.
- [x] Does the dependency graph answer without a token? → **Yes**, measured 2026-11-23: `GET /repos/tomnomnom/gron/dependency-graph/sbom` answered 200, SPDX 2.3, 10 packages with `pkg:golang/…` purls; rate limit 60/hour unauthenticated. DD2.
- [x] Does OSV flag malicious packages through the batch query? → **Yes**, measured 2026-11-23: `POST https://api.osv.dev/v1/querybatch` with `pkg:npm/flatmap-stream@0.1.1` answered three ids including `MAL-2025-20690`; `pkg:npm/lodash@4.17.15` answered five `GHSA-` ids; the batch returns ids only (no summary or severity). DD2, DD3.
- [x] What does the graph give for a repository without a lockfile? → **Ranges**, measured 2026-11-23: `expressjs/express` lists 54 packages with `versionInfo` such as `^0.7.1` and purls such as `pkg:npm/cookie@%5E0.7.1`, development dependencies (`mocha`) included. DD2.
- [x] Is generated description text bounded already? → **Descriptions yes, schemas no.** `oneLine(…, 900)` for CLI tools and `oneLine(…, 1000)` for MCP tools (`src/toolgen/discover.ts`), which strips control characters but keeps zero-width, bidirectional and tag characters; an upstream MCP server's `inputSchema` passes through unchanged up to `MAX_SCHEMA_BYTES` (`mcpTools`), so its property descriptions reach the agent uncleaned. DD5.

### Design Decisions

**DD1 — Extract discovery first, without changing behavior.** `discover`, `foldAliases`, `discoverMcp` and their helpers (about 320 lines of `src/install/installer.ts`) move to `src/install/discovery.ts`. They use `this.cfg`, `this.docker`, `this.proxy`, `this.execFor`, `this.launchSpec` and `this.publish`, so the new module takes **an explicit context object** carrying exactly those (named in the leg), and `Installer.discover` becomes a thin call into it. `publish` stays in the installer. No test is edited beyond imports; `test/installer.test.ts`'s counts are unchanged.
- Rationale: flight 1's debrief (recommendation 3) and the pattern that worked in flight 1 (DD9): extract, then change. The tool-description check sits at the end of discovery.
- Trade-off: a leg with no visible outcome.

**DD2 — The dependency check: what it asks, and of whom.** A built-in check named `dependencies`, run in-process on its own call path (not in the clone script), **before the clone**, in `checkClone` (so at a checked install and in `check_project` alike).
- **When it runs**: at an install only when `MCPE_SCAN` is not `off`; in `check_project` always (operator, 2026-11-23). With scanning off, an install sends nothing to an outside service, as the mission requires.
- **Only GitHub repositories.** For GitLab or another forge: status `not-run`, "GitLab has no public dependency graph" (or the forge's name).
- **The calls**, each with its own time limit (15 s) and the check as a whole bounded at 60 s, outside `MCPE_SCAN_TIMEOUT` (which bounds containers):
  1. `GET https://api.github.com/repos/{owner}/{name}` for `default_branch` (only when the install names a `ref`; see below).
  2. `GET https://api.github.com/repos/{owner}/{name}/dependency-graph/sbom`, with `Authorization: Bearer` from the existing `GITHUB_TOKEN`/`GH_TOKEN` when set (`cfg.githubToken`), as `search_projects` does. Response at most 16 MB, read with a byte cap; larger is a failure.
  3. `POST https://api.osv.dev/v1/querybatch` with one `{"package":{"purl":…}}` per looked-up package, in chunks of at most 1000, following `next_page_token` up to a fixed bound.
  4. `GET https://api.osv.dev/v1/vulns/{id}` **only for the findings kept for display** (at most 20 per DD3 of flight 1), for the summary and severity. Ids not fetched are still counted.
- **Which packages are looked up**: every package in the SBOM except the document's own root (the `DESCRIBES` relationship), that has a `purl` external reference whose version is exact. A version that is a range or absent (`^0.7.1`, `>=2`, none) cannot be looked up: it is counted and named in a note ("37 of 54 dependencies have no exact version on the default branch, usually because there is no lockfile, and were not looked up"), and the check's status is `incomplete`. Purls are passed to OSV as GitHub gives them; the check does not resolve ranges.
- **A pinned `ref`.** The graph describes the default branch. When the install or check names a `ref` other than `default_branch` (compared by name; a commit sha never equals it), the check is `not-run` with "GitHub's dependency graph describes the default branch (<name>), not <ref>; check without a ref to see it", and nothing is sent to OSV. (Reporting default-branch findings at `note` was rejected at design review: at `MCPE_SCAN_BLOCK_AT=note` they would count, DD9.)
- **Failures** — network error, timeout, 403/429 (rate limit), 5xx, a redirect, a body that is too large or not the expected JSON — make the status `failed` with a cleaned reason; never blocking (mission constraint). A 404 from the graph (no graph: private, disabled) is `not-run`, "no dependency graph for this repository". A 200 with no packages besides the root is `ran` with zero findings and the note "the graph lists no dependencies".
- **What is sent, and to whom** is stated in every report that includes a `dependencies` outcome other than `not-run` for a non-GitHub forge, in the server instructions and in the README: the repository's owner and name to GitHub; package names and exact versions to OSV. Nothing from the clone; **the token goes to `api.github.com` only**, never to OSV (unit-pinned). This statement is a fixed sentence rendered by the report formatting from the outcome's presence, **not one of the outcome's `notes`** (DD9).
- **The HTTP helper** is new (`forge/search.ts`'s `getJson` has no byte cap): it streams the body with a byte cap, uses `redirect: "error"`, and applies a per-request `AbortSignal` timeout.
- **Concurrent with the clone.** The lookup starts with the staging clone (`docker.probe`) and is awaited after it. Nothing from the repository runs either way, so "before any of its code runs" holds, and the install does not wait up to 60 s longer.
  - Its catch, which turns a throw into a `failed` check exactly as `build-hooks` does, is **attached when the promise is created**, not at the await. A throw from it never reaches `checkClone`'s `catch` (which reports a clone failure), and no rejection goes unhandled when the probe throws first.
  - It runs under an `AbortController` that `checkClone`'s `catch` aborts, so a failed clone stops the outside calls.
- **Whether it runs is a `checkClone` argument**, because the function is shared. `installChecked()` passes `cfg.scan.mode !== "off"`, and `check()` passes `true`. Both callers are unit-pinned. That argument is what makes "an install with scanning off sends nothing" enforceable.
- A `ref` that is absent, empty or `HEAD` counts as the default branch.
- Rationale: the mission's "before any of its code runs" and "no clone needed"; the dependency check needs nothing a clone gives. No short-circuit on a blocking finding: one report with every check.
- Trade-off: the graph is GitHub's reading of manifests on the default branch, including development and test dependencies, and misses anything a build resolves itself (flight 4 checks what a build installed). Unauthenticated, 60 graph calls an hour are shared with `search_projects`; the README recommends `GITHUB_TOKEN`.

**DD3 — Dependency findings.** One finding per affected package, not per advisory:
- **`error`** when any of its OSV ids starts with `MAL-` (operator, 2026-11-23). Rule id `malicious-package`.
- **`warning`** otherwise (known vulnerable). Rule id `vulnerable-package`. The highest CVSS base score among the fetched advisories, when OSV gives one, is shown as `securitySeverity` (not used by the policy, as flight 1's DD3).
- Message: the package and version, the ids (at most 5, then "and N more"), and the first fetched summary. Location: the purl's ecosystem and name (`npm:lodash`), not a file (the graph does not say which manifest).
- Every string from GitHub or OSV is third-party text and goes through flight 1's cleaning and bounds (message 200, location 120, rule id 80; at most 20 findings kept, highest level first, `omitted` counted).
- Notes: how many packages were looked up; what was not looked up and why. They follow flight 1's existing rule (they count only under `MCPE_SCAN_BLOCK_AT=note`, as `build-hooks`' notes do; DD9). "What was sent where" is not a note (DD2).

**DD4 — Where the dependency check sits in the report.** Its outcome is a `CheckOutcome` of `kind: "builtin"`, placed first in `ScanReport.checks` (`dependencies`, `build-hooks`, then the operator's scanners). Flight 1's `decide()` and the existing report formatting take it unchanged. The `ProjectRecord.scan` field already holds the whole report; no record change.
- Injected through a narrow interface (`fetch`-like, with timeouts and byte caps) so that unit tests use hand-written responses in the test file (not golden files) and never reach the network.
- **Inert unless injected.** `checkClone` is shared by `check()` and `installChecked()`, which existing unit cases already run under warn and block. `Installer` is built positionally in about 8 test sites and `App` in about 20, so the lookup has to default to something that makes no network calls:
  - `Installer`'s constructor gains a trailing parameter, and `AppOptions` gains `dependencies?`. Both default to an inert lookup that answers `not-run` ("not configured") and records that it was called. No existing case reaches the network, and their counts are unchanged.
  - The real client is wired in `src/index.ts` only, and a unit test pins that wiring: a missed wiring would otherwise mean the check silently never runs.
  - The Docker-gated `gron` case passes the real client explicitly.
- **`CheckOutcome` gains an optional `contacted?: ("github" | "osv")[]`** (`src/scan/types.ts`), recording which outside services this check actually called. The formatter renders the "what was sent" sentence from it. `not-run` alone does not say whether anything was sent: a pinned `ref` or a 404 did call GitHub, while GitLab called nothing. Tests pin it for a pinned ref, a 404, GitLab and a check that ran. The field is optional and lives inside `ProjectRecord.scan`, so the registry version stays the same.

**DD5 — The tool-description check: what it reads and what it flags.** A built-in check named `tool-descriptions`. It runs in-process and is pure (no I/O). It covers every tool in the catalog, published or not, since `find_project_tools` and `project_info` show unpublished tools too. It reads **only text that came from the project**, never mcp-everything's own template text, so a repository named `aws-credentials` must not flag every one of its tools.
- **Where that text comes from** (second design review): it can't be recovered exactly by stripping the stored description. The description is rendered with `oneLine` (which also removes U+FEFF as whitespace) and truncated with template suffixes, and a CLI description interleaves template wording with project text that is not stored separately. So:
  - `src/toolgen/discover.ts` gains `buildToolsWithText(input) => { tools, sources: Map<ToolDef, string[]> }`, and `buildTools` stays a thin wrapper, so `test/discover.test.ts` is unchanged.
  - `sources` is **transient and never stored on `ToolDef`**, so the record's shape doesn't change. `vetCatalog` reads it in memory inside `discover`, the only place it runs.
- **What it holds.**
  - For an MCP tool: the raw upstream name and description, the server name, and every string in the upstream `inputSchema` (property names, `description`, `title`, `enum` values, defaults, recursively, bounded by `MAX_SCHEMA_BYTES`).
  - For a CLI tool: the help summary, usage, subcommand names, the command path and `argv`, and each option's flag and description. It excludes the shared template properties (`args`, `stdin`, `cwd`, `timeout_seconds`, `code`, `script`).
- Raw text is a superset of what reaches the agent (it includes the part truncation cut). A finding in the cut part is an accepted over-report, and tests rely on raw text.

Flags:
- **`error`**:
  - hidden Unicode: tag characters (U+E0000–U+E007F) and bidirectional overrides and embeddings (U+202A–U+202E) — text the agent reads and a person reviewing it does not see;
  - instructions that override the agent's instructions or hide from the user ("ignore (all|any|the) previous instructions", "do not (tell|inform|mention) (this to) the user", "the user (must not|should not) (know|see)");
  - naming, as a whole word (`\b`), one of mcp-everything's own tools that change trust or reach (`install_project`, `set_project_hosts`, `set_project_network`, `sandbox_exec`, `sandbox_write_file`, `connect_mcp_server`, `select_project_tools`, `call_project_tool`, `uninstall_project`) — a third-party tool has no reason to steer the agent to them.
- **`warning`**:
  - bidirectional isolates (U+2066–U+2069) and zero-width characters (U+200B, U+200C, U+200D, U+2060, U+FEFF) — they occur in genuine right-to-left and Persian text, so warning only; a ZWJ between two emoji is not flagged;
  - directives aimed at the agent: `<important>`/`<system>`-style tags, "before (using|calling) (this|any other) tool", "you must (first|always)" combined with read/send/call;
  - credentials or secret files (`~/.ssh`, `id_rsa`, `.env`, `mcp.json`, `claude_desktop_config`, `credentials`, `api key`) **only in the same sentence as a directive or exfiltration verb** (read, send, include, pass, upload, attach, post). Bare mentions are ordinary help text (`--env-file`, cloud CLIs' credentials, ssh tools).
- No `note` patterns. Patterns are matched case-insensitively on the text after Unicode normalization (NFKC), so full-width or styled letters do not evade them.
- **Findings never quote the matched text** (the check exists to keep that text out of the agent's context): the rule id, the tool, and the field (`ruff__ruff_check: inputSchema.properties.path.description`) as the location, and for hidden characters their code points (`U+E0041 ×12`). Tool names are printed through `oneLine`.
- **Before the leg's patterns are locked** they are run over the catalogs of the suite's projects (`gron`, the MCP fixtures) and the leg records that nothing fires (a divert criterion).
- Rationale: the patterns that matter are injection into the agent's context and steering toward mcp-everything's own trust-changing tools; length needs no check (DD of the Open Questions: already bounded).
- Trade-off: patterns can be evaded and can misfire on a security tool that legitimately documents prompt injection; the README says the list is a reading aid, as flight 1's DD5 says of `build-hooks`. The patterns may be tuned at the HAT.

**DD6 — When it runs, and what `block` does.** A new step, **`vetCatalog(record)`**, runs at the end of `discover`, after `buildTools` and just before `publish` (`installer.ts` ~1204). It runs inside the existing discipline: a Docker-unavailable throw leaves the record unwritten, and `vetCatalog` itself does no I/O. So it runs on every path that builds a catalog: install, `rediscover` (`discover_tools`), `refreshMcp`, `connectMcp` and `disconnectMcp`. **`publish` keeps today's behavior** (`selectPublished` and its warnings), and **`reselect` (`select_project_tools`) calls only `publish`** and never touches `toolCheck`. Running the check from `publish` was rejected at design review: `reselect` works on the stored catalog, which is already filtered, so it would have replaced the record of what was withheld with a clean result, or deleted it under `off`.
- `vetCatalog` runs **whenever `MCPE_SCAN` is not `off`** in the session making that discovery (`cfg.scan`, read once at startup, as the installer and server already read it). With scanning off, the catalog is as today and `toolCheck` is removed (DD7).
- **Under `block`**, a tool with a finding at or above `MCPE_SCAN_BLOCK_AT` is **withheld** (operator, 2026-11-23). It is removed from `record.tools`, so it is not in the tool list, `find_project_tools` or `call_project_tool`, and `select_project_tools` cannot publish it. Its identity and finding are kept in `toolCheck.withheld` (DD7). The project's other tools stay usable. The install itself is not blocked, and its `ScanDecision` is unchanged: the tool check never enters `decide()`.
- **Under `warn`**, every tool is published as today and its findings are reported.
- **A failure** of the check (it throws) is a failed check: reported, never blocking, and nothing is withheld (mission constraint). The catalog is never left half-filtered: the check computes first, then the catalog is filtered in one step.
- **Projects installed before this flight** are checked at their next discovery; until then `project_info` says their tool descriptions have not been checked. No startup pass rewrites records.
- **Runtime lists are not a gap**: mcp-everything does not follow an upstream server's `listChanged`; a proxied server's tools reach the agent only through discovery.
- **Sessions with different settings** share one registry. A discovery in a `warn` or `off` session publishes tools a `block` session withheld. That follows from the mission's rule that the operator configures each session; the README says so. Concurrent discoveries remain last-writer-wins, as today.
- **A registered MCP server all of whose tools are withheld** stays in `mcpServers` (the operator registered it). `toolCheck` records "server X: all N tools withheld", and `refresh_mcp` and `connect_mcp_server` report that, not a failure to start (DD7).
- `check_project` runs no discovery, so it does not run `tool-descriptions`. Its report and the README say so: "the same findings an install would", except the tools that exist only after a build.

**DD7 — What the record and the agent are told.**
- The record gains an optional **`toolCheck`** field, separate from `scan`: `{ at, mode, blockAt, outcome: CheckOutcome, withheld: [{ tool, server?, upstream?, ruleId, level }], withheldOmitted }`. `withheld` is bounded by one constant (50), and entries past it are counted in `withheldOmitted`. Each entry is keyed by its upstream identity (`server` and the upstream `mcp.tool` for an MCP tool, the command path for a CLI tool), because `makeToolName` may give a different deduplicated name at the next discovery. The generated name is kept for display.
  - Written by `vetCatalog` only. Every checked discovery replaces it, and an unchecked one (scanning off) removes it, so it always describes the catalog as it stands. `reselect` keeps it (unit-pinned).
  - `openInstall` builds a fresh record without it on a reinstall, and the first checked discovery supplies it.
  - The other registry writers spread the current record (`registry.update`) or store the whole record (`putKeeping`), so `tools` and `toolCheck` always land together.
  - It is separate from `scan` because `scan` describes the install's commit and is written once, while discoveries happen later and in sessions with other settings.
  - No registry `version` bump (flight 1's DD8 rule: optional fields, writers spread records).
- **Freshness.** The registry file is the only source of truth. No published-tool cache exists beyond the registry copy:
  - `listTools` and `find_project_tools` read `registry.list()` on every call, and `callTool` refreshes first.
  - The registry watcher refreshes and sends `listChanged`, so another session sees a withheld tool disappear within one watcher tick. That is the maximum staleness.
  - A discovery or reinstall in any session invalidates it.
- **`describe()`** (`project_info`, an install result) gains a line after `security:`:
  - `tool descriptions: checked <date> under <toolCheck.mode>: N error, N warning; withheld: a (rule), b (rule)`, or `tool descriptions: not checked`.
  - The mode shown is the one recorded at the check, not the current session's.
  - Every name is printed through `oneLine`, and no matched text is quoted (DD5).
- **Three existing surfaces read `toolCheck.withheld`** (design review: removal alone made them misreport):
  - `findGenerated` (`server.ts`): when a tool is not found, it then consults `toolCheck.withheld`. A call to a withheld tool answers "withheld by the tool-description check (<rule>)", not "Unknown tool".
  - `refresh_mcp`: both counts change, the `bare` "with no tool in the catalog" count and the `failed` (`proxied === 0`) count. A server whose tools were all withheld is reported as "started; all N tools withheld".
  - `connect_mcp_server`: says how many tools were withheld beside how many were published.
- Withheld entries are informational. Each discovery recomputes them from scratch; nothing matches an old entry against a new discovery.
- **The results of `discover_tools`** say how many tools were withheld and why, in one line, when any were.
- **Server instructions** (generated, flight 1's DD8): the checks line lists `dependencies (GitHub repositories; sends the repository name to GitHub and package versions to OSV)` and `tool-descriptions`, and says that under block a flagged tool is withheld.
- **README**:
  - both checks, and what each catches and does not;
  - what reaches GitHub and OSV, and when, including `check_project` with scanning off;
  - `GITHUB_TOKEN` for the rate limit;
  - withholding under block, and that sessions with other settings can publish what one withheld.

  `test/readme.test.ts` pins README text, so the legs that change the README update that test too.

**DD9 — The policy after this flight** (design review).
- **`decide()` is not changed.** Its rule stands: at `MCPE_SCAN_BLOCK_AT=note`, a check's notes count. DD2 and DD3 avoid emitting statements as notes. The "what was sent" sentence is rendered by the report formatting. A pinned `ref` is `not-run`, not a set of notes.
- **`unreachableBlock` becomes untrue**, because `dependencies` can now report `error` (`MAL-`). It can no longer say "cannot block". In leg 2 it becomes an informational sentence for `block` at `error` with no operator scanner. Its tests (`test/scan-policy.test.ts`), its two call sites (the instructions, `server.ts` ~48, and the startup log, ~613) and the instructions change with it. The sentence says three things:
  - `block` at `error` now blocks only on a known-malicious dependency of a GitHub repository;
  - nothing else built in reports above `warning`;
  - `tool-descriptions` never blocks an install; it withholds tools (DD6).
- **The README adds two warnings.**
  - `block` at `warning` now also blocks any GitHub repository with a known-vulnerable dependency. That is very common, since development and transitive dependencies are included. The default (`error`) does not.
  - `block` at `note` blocks a repository whose graph has ranges (an `incomplete` check's note counts there), as flight 1's rule already does for `build-hooks`' notes.

**DD8 — Verification apparatus.**
- **Unit**:
  - **The dependency check**, over hand-written SBOM and OSV responses through the injected interface:
    - which packages are looked up: exact versions; ranges; the root package skipped; a 200 with no packages;
    - findings: `MAL-` gives an error, vulnerable gives a warning; a pinned `ref` gives `not-run` with nothing sent to OSV;
    - failures: 404; 403 with `x-ratelimit-remaining: 0`; timeout; a redirect refused; an oversized body; malformed JSON; GitLab;
    - the token sent to GitHub only, never to OSV;
    - an install with scanning off never calls the interface.
  - **The tool-description patterns**: one positive and one negative case each; NFKC evasion; the schema walk; `mcp.tool` and `argv` read; the generated prefix not read (a repository named `aws-credentials`); RTL text with isolates only a warning; no matched text in any finding.
  - **`vetCatalog`**:
    - under off, warn and block; withholding;
    - `reselect` keeping `toolCheck`;
    - a throwing check withholding nothing;
    - `toolCheck` replaced, and removed by an off discovery;
    - the three surfaces of DD7 (a withheld call, `refresh_mcp`, `connect_mcp_server`).
  - **`unreachableBlock`'s** new text.

  No network in the unit suite.
- **Docker-gated suite**: the existing `check_project` of `tomnomnom/gron` additionally asserts a `dependencies` outcome that ran (`gron`'s graph has exact Go versions; zero findings expected at planning) — this is the one live call to GitHub and OSV, and it is acceptable for it to report `failed` under a rate limit (the assertion accepts `ran` or a rate-limit `failed`, never a crash). No new destructive Docker case: the Docker gate does not apply.
- **HAT**: a repository with a known-vulnerable or known-malicious pinned dependency, and a real MCP server's tool descriptions, chosen there (the suites must not depend on a third party's advisories staying put).
- Rationale: nothing in this flight needs a container to observe; the acting surface is `App.callTool` and the observing surface is the tool result text and `project_info`, both existing.

### Prerequisites
- [x] `api.github.com` dependency graph answers unauthenticated (measured 2026-11-23).
- [x] `api.osv.dev/v1/querybatch` answers and returns `MAL-` ids (measured 2026-11-23).
- [x] Docker reachable for the Docker-gated suite (server 29.8.2; unchanged since flight 2).
- [ ] Unit and Docker suite baselines recorded at the start of execution (flight 2's debrief: 2751 passed, 71 skipped, 17.4 s unit).

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [ ] Prerequisites verified (the baseline is execution-time by design)
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
1. **Extract discovery** into `src/install/discovery.ts` (DD1); behavior unchanged, tests unchanged but for imports.
2. **The dependency check** goes in a new `src/scan/dependencies.ts`: SBOM parsing, choosing which purls to look up, the OSV batch and detail calls, and the findings.
   - A small HTTP helper enforces the time limit, the byte cap and the no-redirect rule.
   - It is injected into `Installer`, with a test default in `test/helpers.ts`.
   - It is started concurrently with the staging clone in `checkClone`.
   - `unreachableBlock` is rewritten; the instructions and README cover the check.
3. **The tool-description check** goes in a new `src/scan/tool-text.ts`: the pure patterns and the schema walk over text that came from the project.
   - `vetCatalog` runs at the end of `discover`, withholding tools under block.
   - `toolCheck` is added to the record.
   - `describe()`, `findGenerated`, the results of `refresh_mcp`, `connect_mcp_server` and `discover_tools`, the instructions and the README all report it.
4. **HAT.**

### Checkpoints
- [ ] Discovery extracted; `npm test` count unchanged.
- [ ] `check_project` on a GitHub repository reports a `dependencies` outcome, with what was sent, alongside the clone's report.
- [ ] Under `block`, a flagged tool is absent from the tool list, `find_project_tools` and `call_project_tool`, and `project_info` names it.
- [ ] README and instructions describe both checks and what reaches outside services.

### Adaptation Criteria

**Divert if**:
- GitHub's dependency graph requires authentication or changes shape (the check would need a token as a prerequisite; operator decision).
- The tool-description patterns flag a large share of ordinary tools in the test projects (`gron`, the suite's MCP fixtures): the levels go back to the operator before landing.
- Withholding a tool proves to break an invariant of the catalog that cannot be resolved inside `vetCatalog` and the three surfaces of DD7. Design review found none: `CommandSpec.aliases` is a CLI note. A `selection` include naming a withheld tool yields `selectPublished`'s existing "matches no tools" note, which is accepted.

**Acceptable variations**:
- Exact bounds (time limits, the number of advisory details fetched) tuned in the leg with a reason in the log.
- Pattern wording adjusted at the leg's design review or the HAT, keeping the levels' intent.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [ ] `extract-discovery` - Move discovery out of `installer.ts` behind the same calls, with no behavior change. Only the installer changes; nothing in `src/toolgen/` (low risk).
- [ ] `dependency-check` - GitHub dependency graph and OSV lookups as the `dependencies` built-in check, before the clone, at checked installs and in `check_project`. Includes `CheckOutcome.contacted`, the lookup that is inert unless injected (`Installer` and `AppOptions`; the real client in `index.ts`), the rewritten `unreachableBlock`, the report, the instructions and the README (high risk: third-party input parser, outside services).
- [ ] `tool-description-check` - `buildToolsWithText` with transient sources, the `tool-descriptions` check in `vetCatalog` at the end of discovery, withholding under block, `toolCheck` on the record, what the agent is told, the instructions and the README (high risk: changes what is published and callable).
- [ ] `hat-and-alignment` - Guided HAT session with iterative fixes (operator, 2026-11-23).

---

## Post-Flight

### Completion Checklist
- [ ] All legs completed
- [ ] Code merged
- [ ] Tests passing
- [ ] Documentation updated

### Verification
- `check_project` on a GitHub repository with scanning off reports `dependencies` and what was sent; an install with scanning off sends nothing (unit-pinned: the injected interface is never called). Under `block` at `error` with no operator scanner, the startup log and instructions say what can still block.
- Under `block`, a pinned dependency with a `MAL-` advisory blocks the install before any build; a vulnerable one is reported at warning and does not block at the default threshold.
- Under `block`, a tool whose description carries a tag character or names `set_project_hosts` is withheld at install and after `refresh_mcp`, and the rest of the project's tools work.
- `npm test`, `npm run typecheck`, and the Docker-gated suite pass; the HAT confirms both against real repositories.
