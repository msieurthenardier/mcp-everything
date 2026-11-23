# Leg: dependency-check

**Status**: completed
**Flight**: [Checking Dependencies and Tool Descriptions](../flight.md)

## Objective
Add the `dependencies` built-in check. It asks GitHub for a github.com repository's dependency graph, and OSV for which exact versions in it are known to be malicious (`error`) or vulnerable (`warning`). It runs concurrently with the staging clone in `checkClone`: at a checked install only when scanning is not `off`, and in `check_project` always. Each report says which outside services were contacted. `unreachableBlock`, the instructions and the README are updated to match.

## Context
- Flight DD2 (what is asked and of whom, the pinned `ref`, failures, concurrency), DD3 (findings), DD4 (place in the report, injection, `contacted`), DD9 (policy unchanged; `unreachableBlock` rewritten; README warnings). The operator's decisions of 2026-11-23: `check_project` sends with scanning off; malicious is `error`, vulnerable is `warning`.
- Measured premises (flight Open Questions):
  - **GitHub's dependency graph** (`GET /repos/{o}/{n}/dependency-graph/sbom`) answers unauthenticated with SPDX 2.3, `sbom.packages[]` and `externalRefs[]` of `referenceType: "purl"`.
  - **Exact and range versions.** `gron` gives exact `pkg:golang/…@0.33.0`, while `expressjs/express` gives ranges such as `pkg:npm/cookie@%5E0.7.1` (`^0.7.1`).
  - **OSV's batch query** (`POST /v1/querybatch` with `{"queries":[{"package":{"purl":…}}]}`) answers `results[i].vulns[] = {id, modified}` and an optional `next_page_token`. It flagged `flatmap-stream@0.1.1` with `MAL-2025-20690`.
- Leg 1 (`extract-discovery`) touched only discovery in `installer.ts`. This leg changes `checkClone`, `check`, `installChecked` and the constructor, which leg 1 did not move.

## Inputs
- `src/install/installer.ts`:
  - `checkClone(params, log)` (it runs `docker.probe`, then `analyzeBuildHooks`, then `runScanners`, then `decide`);
  - `check()` and `installChecked()`, its two callers;
  - the constructor (positional: `cfg, docker, registry, proxy, choose, env, containment`).
- `src/scan/types.ts` `CheckOutcome`; `src/scan/sarif.ts` (the private `clean(text, max)`, `MAX_FINDINGS`, and the bounds 80/200/120/16); `src/scan/policy.ts` `unreachableBlock`, `decide`.
- `src/server.ts`:
  - `AppOptions` (≈495) and the construction of `Installer` (≈534);
  - `securityParagraph` (≈38–60; the line "Checks that run on a repository: build-hooks (built-in)…");
  - `renderReport` (≈475);
  - the startup log's use of `unreachableBlock` (≈613).
- `src/index.ts` (`new App({ cfg, log })`). `src/config.ts` `githubToken`. `src/forge/repo-ref.ts` `RepoRef` (`forge`, `host`, `path` = `owner/name`, `id`).
- Tests that pin text this leg changes:
  - `test/scan-policy.test.ts` (≈82–91, `unreachableBlock` "cannot block");
  - `test/server.test.ts`:
    - ≈70–77, the source-order test whose regex `new Installer\([^)]*opts\.env, this\.containment\)` pins the installer's last argument;
    - ≈2354 and ≈2377, the "Checks that run on a repository" text;
  - `test/readme.test.ts`.

## Outputs
- **New `src/scan/http.ts`**: `getCapped` / `postCapped` over an injected `fetch`. Each request has `redirect: "error"`, an `AbortSignal` that combines the per-request timeout with the caller's signal (`AbortSignal.any`), and a body read as a stream and cut at a byte cap (over the cap is an error, not a partial body). Results are `{ status, headers, text }`. No request ever follows a redirect.
- **New `src/scan/dependencies.ts`**:
  - `interface DependencyLookup { check(repo: RepoRef, ref: string | undefined, signal: AbortSignal): Promise<CheckOutcome | undefined> }`;
  - `githubOsvLookup({ fetch, githubToken?, now? })`, the real one;
  - `inertDependencyLookup()`, which answers **`undefined`** (no outcome is added to the report) and records its calls (`calls: Array<{ repo, ref }>`). (Design review: an inert `not-run` outcome would sit first in every existing report and break `test/installer.test.ts` ≈1997, 2110, 2165 and 2203–2204, which read `checks[0]`, and would add "dependencies did not run" to every decision's reason.)
  - the pure parts, exported for tests: `parseSbom(text)`, `isExactVersion(type, v)`, `dependencyFindings(…)`.
- `src/scan/types.ts`: `CheckOutcome` gains two optional fields:
  - `contacted?: ("github" | "osv")[]`;
  - `lookedUp?: number`, how many packages were sent to OSV. This is a structured count, not a note, so it never counts for the policy.
- `src/install/installer.ts`:
  - the constructor gains a trailing `dependencies: DependencyLookup = inertDependencyLookup()`;
  - `checkClone` gains an argument saying whether to look up dependencies, and runs the lookup concurrently with the probe;
  - `check()` passes `true`; `installChecked()` passes `cfg.scan.mode !== "off"` (always true there today, since it runs only when scanning is on, but pass it explicitly).
- `src/server.ts`:
  - `AppOptions.dependencies?: DependencyLookup`, defaulting to the inert one, and passed to `Installer`;
  - `renderReport` renders the sent-statement from `contacted`;
  - `securityParagraph` names `dependencies`;
  - the startup log and the instructions use the rewritten `unreachableBlock`.
- `src/index.ts`: `new App({ cfg, log, dependencies: githubOsvLookup({ fetch: globalThis.fetch, githubToken: cfg.githubToken }) })`.
- `src/scan/policy.ts`: `unreachableBlock` rewritten (see criteria).
- README: the built-in checks section, "What reaches outside services", and the two DD9 warnings. Tests updated to match.
- `test/integration/docker.test.ts`: the existing `check_project` of `tomnomnom/gron` passes the real lookup and asserts the `dependencies` outcome (see criteria).

## Acceptance Criteria

### Which packages are looked up
- [ ] `parseSbom` takes the response text and reads `sbom.packages[]` and `sbom.relationships[]`.
  - It skips the package that `SPDXRef-DOCUMENT` `DESCRIBES` (the repository itself).
  - For each remaining package, it takes the first `externalRefs[]` entry with `referenceType === "purl"`.
  - Every field read is an own property of a plain object, as in `sarif.ts`'s `own`. Anything else is ignored, never thrown on.
  - A body that is not JSON, or has no `sbom.packages` array, is a parse failure, and the check is `failed` ("GitHub's dependency graph answer could not be read"). Neither the body nor `JSON.parse`'s message is ever quoted.
- [ ] **Which purl types are looked up at all.**
  - `pkg:githubactions/…` (CI workflow steps, pinned by a 40-hex commit or a tag; not what the build runs) and `pkg:github/…` (a repository, such as `pkg:github/pallets/flask@main`) are **excluded**. They are never sent, and never counted as "not looked up".
  - The README says workflow actions are not checked.
  - Measured on 2026-11-23: `pallets/flask` has 106 `pkg:pypi` packages, all exact and bare (`jinja2@3.1.2`), and 9 `pkg:githubactions`, all pinned by sha. `astral-sh/ruff` has pypi, npm (ranges such as `%5E1.5.0`), cargo (exact) and githubactions.
- [ ] `isExactVersion(type, v)` is an **allowlist**. (Design review: a denylist let through npm `github:`, `file:`, `workspace:`, `link:` and `npm:` specs, npm short ranges such as `4` or `1.2`, and Maven's `${…}`, `LATEST`, `RELEASE` and `1.0.+`.)
  - Strip the purl's `?qualifiers` and `#subpath` first. Then take the version after the last `@` (an npm scope's `@` is `%40` in a purl), and percent-decode it.
  - **Exact**: it matches `^v?\d+(\.\d+)+([-+][0-9A-Za-z.+_!-]*)?$`, has no `x`, `X` or `*` dot segment, and does not contain `.+`.
  - **npm** also needs at least three numeric segments.
  - A purl without `@` is not exact.
  - A table test covers npm, pypi, golang (`v0.33.0`; the pseudo-version `v0.0.0-20210101120000-abcdef123456`; `v2.0.0+incompatible`), cargo, gem, maven (`${project.version}`, `LATEST`, `[1.0,2.0)`, `1.0.+`), composer and nuget, with positives and negatives.
- [ ] Not-exact packages are not sent to OSV. They are counted in one note: "N of M dependencies have no exact version on the default branch (usually no lockfile) and were not looked up". When N > 0, the status is `incomplete`.
- [ ] **Duplicate purls** (ruff lists `pkg:pypi/test@0.1.0` three times) are queried once and give at most one finding.
- [ ] At most **5000 packages** are considered, in the graph's order. Any beyond that are counted in a note, and the status is `incomplete`.

### Calls, bounds and failures
- [ ] **Only github.com.** A repository whose `host` is not `github.com` gets `not-run` with `contacted: []` and no request at all. The reason is "GitLab has no public dependency graph" when `forge` is `gitlab`, and otherwise "<host> has no public dependency graph".
- [ ] **A pinned `ref`.** When `ref` is non-empty and not `HEAD`, the lookup first calls `GET https://api.github.com/repos/{path}` (1 MB cap) and reads `default_branch`.
  - If `ref !== default_branch`, the check is `not-run` with "GitHub's dependency graph describes the default branch (<name>), not <ref>; check without a ref to see it" and `contacted: ["github"]`. Nothing is sent to OSV.
  - An absent, empty or `HEAD` ref skips this call.
- [ ] **The graph.** `GET https://api.github.com/repos/{path}/dependency-graph/sbom` with the headers `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`, plus `Authorization: Bearer <token>` **only when a token is configured, and only on requests to `api.github.com`**. The cap is 16 MB.
  - **200**: parse.
  - **404**: `not-run`, "no dependency graph for this repository", `contacted: ["github"]`.
  - **403 or 429**: `failed`. The text says "rate limit" when `x-ratelimit-remaining` is `0` or the status is 429, and suggests `GITHUB_TOKEN`.
  - **Any other status, a redirect, a timeout, or the cap exceeded**: `failed`, with a fixed reason naming which step failed.
  - A redirect's reason says "GitHub redirected (the repository may have been renamed or moved)".
- [ ] **OSV batch.** `POST https://api.osv.dev/v1/querybatch` with `Content-Type: application/json` and the body `{"queries":[{"package":{"purl":"<purl as GitHub gave it>"}}…]}`.
  - Chunks hold at most 1000 queries, and the cap is 16 MB per response.
  - `results[i]` is matched to `queries[i]` by index; a length mismatch is a `failed` check.
  - A `next_page_token` on a result is followed with the same query plus `page_token`, up to **10 follow-up requests per check**. Each follow-up batches only the queries that still have a token. Past that, a note says the list of advisories was cut short, and the status is `incomplete`.
  - The worst case is 1 repository call, 1 graph call, 5 batch chunks, 10 follow-ups and 20 detail calls, all inside the 60 s deadline.
  - Each `{path}` segment is URL-encoded.
  - **No `Authorization` header is ever sent to OSV**, and a unit test asserts it.
- [ ] **OSV details.** `GET https://api.osv.dev/v1/vulns/{id}` (2 MB cap, `id` URL-encoded), only for the packages kept for display (at most `MAX_FINDINGS`), fetching one id per package. For a malicious package that is its first `MAL-` id; otherwise its first id.
  - Read: `summary` (a string), and `database_specific.severity` (a string such as `HIGH` or `MODERATE`) as `securitySeverity`.
  - A failed detail fetch only drops that summary; it does not fail the check. (DD3 said "the highest CVSS base score". OSV gives a CVSS *vector*, not a score, so the GitHub severity label is used. This is an acceptable variation, logged.)
- [ ] **Time.** Each request is bounded at 15 s, and the whole check at 60 s, by a deadline `AbortSignal` combined with the caller's signal. On the deadline the check is `failed` ("the dependency check ran out of time"), with what was contacted so far.
- [ ] **`contacted`** lists, in order and without duplicates, each service a request was actually sent to. It is unit-pinned for GitLab (`[]`), a pinned ref (`["github"]`), a 404 (`["github"]`), a rate-limited graph (`["github"]`), and a check that ran (`["github", "osv"]`).

### Findings
- [ ] Each affected package gives one finding with `check: "dependencies"`:
  - **`error`**, rule `malicious-package`, when any of its ids starts with `MAL-`;
  - **`warning`**, rule `vulnerable-package`, otherwise.
- [ ] The message is `<name> <version>: known malicious|known vulnerable (<ids, at most 5>[, and N more])[: <summary>]`. The location is `<purl type>:<name>` (for example `npm:lodash`). Every string goes through the same cleaning and bounds as `sarif.ts` (message 200, location 120, rule id 80, severity 16). Export `sarif.ts`'s `clean` (or a named wrapper), rather than duplicating it.
- [ ] Counts are exact for every affected package. At most `MAX_FINDINGS` are kept, errors first and then in graph order, and `omitted` counts the rest.
- [ ] **Notes** are only the not-looked-up, cut-short and over-5000 notes above. They are never the sent-statement, and never the number looked up, which is `lookedUp`.
  - With zero packages, the status is `ran`, with `lookedUp: 0` and no note. The renderer says "the graph lists no dependencies".
  - So at `MCPE_SCAN_BLOCK_AT=note`, a dependency check counts only when it has findings or the graph had something it could not look up. A unit test in `test/scan-policy.test.ts` pins both cases through `decide`.
- [ ] **A thrown error never escapes `check`.** Any unexpected exception becomes `failed` ("the dependency check could not complete"), never with the exception's text (it may carry response content).

### Wiring
- [ ] `checkClone(params, log, lookupDependencies: boolean)`:
  - When `true`, it starts `this.dependencies.check(params.repo, params.ref, controller.signal)` **before** `docker.probe`.
    - The promise is wrapped **at creation** with `.catch(() => failedOutcome)`, so it never rejects unhandled.
    - It is awaited after `analyzeBuildHooks` and before `runScanners`.
    - `checkClone`'s `catch` calls `controller.abort()` before re-throwing.
  - When `false`, nothing is called and the report has no `dependencies` outcome. The same holds when the lookup answers `undefined` (the inert one).
  - When present, the outcome is **first** in `report.checks`.
  - **When the clone fails after the lookup sent something**, `checkClone`'s `catch` aborts the lookup and awaits its wrapped promise, which settles quickly once aborted. Its outcome carries `contacted`. The thrown reason gains a suffix, appended **after** the existing `CHECK_REASON_MAX` cut and bounded separately: " (before it failed, the dependency check sent the repository's name to GitHub[ and package versions to OSV])". A failed check never hides a send.
- [ ] `check()` passes `true`. `installChecked()` passes `this.cfg.scan.mode !== "off"`. Unit tests with a recording lookup pin both:
  - `check_project` with scanning off calls the lookup once;
  - an install with scanning off calls it **zero** times. This test goes through `App` with `MCPE_SCAN=off` and `install_project`, with a recording lookup passed as `AppOptions.dependencies`. The routing to `install()` is in `server.ts` (≈1251), so a direct `installer.install()` call would prove nothing;
  - a checked install under warn calls it once.
- [ ] `Installer`'s constructor gains a trailing `dependencies` parameter, defaulting to `inertDependencyLookup()`.
  - `App` takes `opts.dependencies`, also inert by default, and passes it as the installer's last argument.
  - The source-order test in `test/server.test.ts` (≈70–77) is **updated, not deleted**. It still pins that `this.containment` is built first and passed. It now also pins that **`opts.dependencies`, a plain expression with no parentheses** (the regex's `[^)]*` breaks on a `)`), is the last argument. `undefined` falls through to the constructor's default.
  - `test/server.test.ts` ≈2436 asserts the absence of "cannot block anything", which would then pass trivially. Update its string to the new sentence's distinguishing text.
- [ ] `src/index.ts` wires `githubOsvLookup` with `globalThis.fetch` and `cfg.githubToken`. A unit test reads `src/index.ts` as text and asserts that `githubOsvLookup(` appears in the `new App({…})` options (the same source-text technique as the test above), so that a missed wiring fails a test.
- [ ] Every existing unit test passes unchanged, except the tests named above whose pinned text this leg changes. No test reaches the network. Total: 2751 + the new cases, 71 skipped, 0 failed.

### What the agent and the operator are told
- [ ] `renderReport` (`server.ts`): after a `dependencies` outcome's line, it adds one line from `contacted`:
  - `["github"]`: "sent: the repository's name to GitHub (api.github.com)";
  - `["github", "osv"]`: "sent: the repository's name to GitHub (api.github.com), and N package names and versions to OSV (api.osv.dev)", with N from `lookedUp`;
  - `lookedUp === 0`: "the graph lists no dependencies";
  - `[]`, or `contacted` absent (records from before this flight): no line.
  - This line is not in `c.notes`.
  - It appears at all three call sites of `renderReport`: the install's blocked wording (≈1296), `check_project` (≈1357), and the verbose `project_info` listing of the stored `p.scan` (≈999), where it records what the install sent.
- [ ] `securityParagraph`:
  - `Checks that run on a repository: dependencies (built-in, GitHub repositories: sends the repository name to GitHub and exact package versions to OSV), build-hooks (built-in)…`;
  - when scanning is `off`: "check_project still runs the dependency check, which sends to GitHub and OSV; installs send nothing".
  - The tests at `test/server.test.ts` ≈2354 and ≈2377 are updated to the new text.
- [ ] `unreachableBlock(blockAt, scanners, mode)`:
  - For `block` at `error` with no operator scanner, it returns an **informational** sentence: "MCPE_SCAN=block at error with no scanners configured blocks only on a known-malicious dependency of a GitHub repository; the other built-in check reports at most warning. Set MCPE_SCAN_BLOCK_AT=warning or add a scanner to block on more." It never says "cannot block".
  - Leg 3 adds DD9's clause about `tool-descriptions` to this sentence. This leg does not.
  - Every other case is unchanged (`undefined`).
  - `test/scan-policy.test.ts` ≈82–91 is updated: the first expectation now matches the new sentence, and the five `undefined` cases stay. Rename the `describe` if its name no longer fits (rename, not delete-and-re-add).
- [ ] **README** (and `test/readme.test.ts` updated for whatever it pins):
  - **Under "The built-in check" (≈518), or a new sibling section "The dependency check":** what it asks, of whom, and when, including `check_project` with scanning off. Also: malicious is `error` and vulnerable is `warning`; ranges are not looked up (no lockfile); workflow actions are not checked; a pinned `ref` is not covered and costs one more GitHub call; it covers only github.com; and `GITHUB_TOKEN` raises the 60-an-hour limit, which `search_projects` shares.
  - **Under "What reaches outside services" (≈871):** with scanning on, an install sends the repository name to `api.github.com` and package names and versions to `api.osv.dev`, from mcp-everything's own process, so not through containment; `check_project` does so whatever the scanning setting. Nothing from the clone is sent, and the token goes only to GitHub.
  - **The two DD9 warnings:** `block` at `warning` also blocks any GitHub repository with a known-vulnerable dependency (common); `block` at `note` blocks a repository whose graph has ranges or more advisories than were read.
  - **A clone that fails after the lookup** still says what was sent.
  - **"What none of this protects against" (≈608):** the graph is GitHub's reading of the default branch's manifests, including development dependencies, and misses what a build resolves itself.

### Live
- [ ] In `test/integration/docker.test.ts`, the `check_project` describe (≈1543) builds a shared `checker = new App({ cfg })` in its `beforeAll` (≈1574), and the gron case (≈1599) is its only user. Edit that `beforeAll` construction to build the `App` with `dependencies: githubOsvLookup({ fetch: globalThis.fetch, githubToken: process.env.GITHUB_TOKEN })`. It asserts the report contains a `dependencies` line whose status is `ran` with "0 error", **or** `failed` with "rate limit" (accepted, so the suite never depends on GitHub's quota), and never a crash. This leg does not run the Docker suite; the flight runs it before landing.

## Verification Steps
- `npm run typecheck && npm run build && npx vitest run`: 0 failed. Record the new count.
- `grep -rn "Authorization" src/scan/dependencies.ts src/scan/http.ts`: only the GitHub path sets it.
- **Trials.** For each, note `git diff --stat`, make the change, run the named test file, undo the change by editing, and confirm `git diff --stat` matches. Record each in the flight log.
  1. Send the token to OSV too: the "no Authorization to OSV" test fails.
  2. Make the **unscanned** `install()` path call the lookup (temporarily): the App-level "install with scanning off calls it zero times" test fails.
  3. Remove the `.catch` at creation: the "probe throws, lookup rejects later" test fails, or reports an unhandled rejection (vitest fails on unhandled rejections).
  4. Relax npm's three-segment rule: the `1.2` negative in the table fails. Separately, accept `${…}`: the maven negative fails.
  5. Make "N looked up" a note again: the `decide` at `note` test fails.
  6. Drop the `MAL-` check, so everything is a warning: the malicious test fails.
- Read `renderReport`'s output for the five `contacted` cases in the unit test.

## Implementation Guidance
1. **`types.ts`.** Add `contacted?`.
2. **`http.ts`.**
   - Use `fetchImpl(url, { method, headers, body, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(ms), outer]) })`.
   - Read `res.body` with a reader, summing bytes, and `reader.cancel()` and throw a `CapExceeded` once over the cap. Decode with `TextDecoder`.
   - Measured on Node 22.22.0 by the design review:
     - **Redirects.** Under `redirect: "error"`, a redirect throws `TypeError("fetch failed")` with `cause.message === "unexpected redirect"`. Network errors throw the same `TypeError`, so distinguish them by `e.cause?.message`, falling back to "request failed".
     - **Timeouts.** `AbortSignal.timeout` gives a `TimeoutError`. Tell a per-request timeout, the 60 s deadline and a caller abort apart by checking each source signal's `.aborted`, not the error's name.
     - **A caller signal that is already aborted** rejects before anything is sent. Push to `contacted` only after that point, immediately before the `fetch` call.
     - **Reading the body.** A timeout during the body read rejects `reader.read()`, so keep the read loop inside the same `try`.
3. **`dependencies.ts`.**
   - Keep the network sequence in one `async` function with an explicit `contacted` array, appended **before** each request is sent.
   - Write the pure parse and findings functions first, and test them with hand-written JSON in `test/scan-dependencies.test.ts` (new). Never use golden files.
4. **`sarif.ts`.** Export the cleaning helper. Do not change its behavior.
5. **`installer.ts`.**
   - Add the constructor parameter.
   - In `checkClone`, create the `AbortController` and the wrapped promise before `this.docker.probe(...)`, await it after `analyzeBuildHooks`, and put it first in `checks`.
   - The existing `catch` aborts first.
6. **`server.ts`.** Make the `AppOptions` and constructor changes, plus `renderReport`, `securityParagraph`, and the startup log's message (it uses the same function).
7. **`index.ts`.** Wire the real lookup.
8. **`policy.ts`.** Update the function and its tests.
9. **README and its tests.** Then run the whole unit suite.
10. **The Docker test file.** Edit only the `check_project` gron case's `App` construction and its assertions. Do not run it.

## Edge Cases
- **Duplicate purls in the graph** (the same package from two manifests): query once; one finding.
- **A purl containing `#` or `?` (subpath or qualifiers)**: send it as given; for display, take the name and version from `name` and `versionInfo` when present, else from the purl.
- **Package names in findings** come from the graph, which reflects the repository's manifests, so they are hostile text. Clean them.
- **OSV returns an id more than once** for one query: deduplicate.
- **The caller's signal is already aborted** (the clone failed instantly): return `failed` ("cancelled") without sending anything, and leave `contacted` empty.
- **`globalThis.fetch` is missing** (Node 22.12 or later is required, so it exists): no fallback.
- **`check_project` against GitLab** gives `not-run` with nothing contacted and no sent-statement.

## Files Affected
- `src/scan/http.ts`: new.
- `src/scan/dependencies.ts`: new.
- `src/scan/types.ts`, `src/scan/sarif.ts` (export only), `src/scan/policy.ts`.
- `src/install/installer.ts`: constructor, `checkClone`, `check`, `installChecked`.
- `src/server.ts`: `AppOptions`, the installer construction, `renderReport`, `securityParagraph`, startup log.
- `src/index.ts`.
- `README.md`.
- Tests:
  - `test/scan-dependencies.test.ts` (new);
  - `test/scan-policy.test.ts`;
  - `test/server.test.ts` (the source-order test, instructions text, the `check_project` report);
  - `test/installer.test.ts` (wiring cases);
  - `test/readme.test.ts`;
  - `test/integration/docker.test.ts` (one case).

## Citation Audit
Checked 2026-11-23 against `4a0dd5e`:
- `checkClone` at `installer.ts:322`, `check` at 376, `installChecked` at 407, the constructor at 242–257;
- `server.ts` `securityParagraph` at 38, `renderReport` at 475, `AppOptions` at 495, `new Installer` at 534, the startup `unreachableBlock` at 613;
- `test/server.test.ts:70–77` (the source-order regex), 2354 and 2377;
- `test/scan-policy.test.ts:82–91`;
- README sections at 518, 608 and 871.

Leg 1 may shift the line numbers below `installer.ts:1056`, but not those cited here (all above 1056).

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
