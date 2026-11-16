# Leg: tier-a-check

**Status**: completed
**Flight**: [CI Gate](../flight.md)

## Objective
Add a hosted check that runs install, typecheck, unit tests and build on every pull request and every push to `main`, make the stated Node floor true in every place it is stated, and turn on dependency update proposals.

## Context
- Finding 7 of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md): the README tells people to run the server with `npx` from the default branch, `prepare` builds at install time, and nothing checks a pull request.
- Flight decisions that bind this leg: Node floor `>=22.12`; one job, one Node version; trigger `pull_request` (never `pull_request_target`) and `push` to `main`; `permissions: contents: read`; actions pinned by commit SHA; no secret.
- No prior legs. The squawk turnaround merged before this flight, so the unit suite is now 396 passed and 17 skipped (the flight spec's "340" predates it).
- The operator's live mcp-everything instance runs from this checkout's `dist/`. That is why the local verification below never runs `npm ci`, `npm install` or `npm run build` here; the hosted runner does those.

Ground truth gathered on 2026-11-16 (ran, unless marked):
- `.github/` does not exist. There is no `.nvmrc` and no vitest config file.
- `package.json` — `"engines": { "node": ">=20" }`; `package-lock.json` repeats it in the root package entry (`packages[""]`, the first `"engines"` in the file). A second `"node": ">=20"` further down belongs to a dependency and is not ours.
- `README.md:18 — "- Node.js 20+"`. The Development section (`## Development`) lists the test commands and says nothing about a hosted check.
- `test/installer.test.ts` has `engines: { node: ">=20" }` in four fixtures. Those describe a repository being installed, not this project. They do not change.
- `node_modules/vitest/package.json` — version 5.1.0, `"engines": {"node": "^22.12.0 || ^24.0.0 || >=26.0.0"}`.
- `npx vitest run zz-no-such-file` exits 1: vitest already fails when no test file matches. The minimum-count step is therefore a guard against a mass skip or a narrowed include, not against an empty run.
- `npx vitest run --reporter=default --reporter=json --outputFile.json=<path>` exits 0 and writes `numPassedTests=396 numPendingTests=17 numFailedTests=0 numTotalTests=413 success=true`.
- `npm pack --dry-run --ignore-scripts --json` prints an array whose first element has `files[].path`; `dist/index.js` is among 45 paths.
- `gh api repos/actions/checkout/releases/latest` gives `v7.0.1`, commit `3d3c42e5aac5ba805825da76410c181273ba90b1`. `gh api repos/actions/setup-node/releases/latest` gives `v7.1.0`, commit `949feb2413d6458794dcd2491c4babbbce0c15c1`.
- `package-lock.json` is `lockfileVersion` 3. The local npm is 11.14.1; the npm that ships with the runner's Node 22 is older (not checked which). Lockfile version 3 is read by both (inferred).
- Python with PyYAML 6.0.1 is available locally for parsing YAML. `actionlint` is not installed.

## Inputs
- Branch `flight/01-ci-gate`, cut from `main` at the merge of pull request #6.
- `npm run typecheck` clean and `npm test` at 396 passed, 17 skipped.
- GitHub Actions enabled on the repository, all actions allowed (`gh api …/actions/permissions`).

## Outputs
- `.github/workflows/ci.yml` (new)
- `.github/dependabot.yml` (new)
- `.nvmrc` (new)
- `package.json`, `package-lock.json` — the `engines` floor
- `README.md` — the requirement line and one sentence in Development

## Acceptance Criteria
- [ ] `.github/workflows/ci.yml` parses as YAML and triggers on `pull_request` and on `push` to `main` only. The string `pull_request_target` does not appear in it.
- [ ] The workflow has top-level `permissions` of exactly `contents: read`, one job with the id and name `check` on `ubuntu-latest`, and a `timeout-minutes` on the job.
- [ ] Every `uses:` names a 40-character commit SHA followed by a comment giving the version, and no step reads `secrets.*`.
- [ ] Node comes from `node-version-file: .nvmrc`. The input names used with `actions/setup-node` exist in that action's `action.yml` at the pinned commit.
- [ ] The job's steps run, in this order: `npm ci`, `npm run typecheck`, the unit tests, `npm run build`, the pack check.
- [ ] The unit-test step fails when vitest fails, and a following step fails when the number of passed tests is below the floor. The floor and the reason for it are stated in a comment.
- [ ] The pack check fails when `dist/index.js` is not in the list `npm pack --dry-run --ignore-scripts` reports.
- [ ] `.nvmrc` contains `22`. `package.json` and the root entry of `package-lock.json` both say `"node": ">=22.12"`. README line 18 says `Node.js 22.12+`. No other `engines` entry in the lockfile changed.
- [ ] `.github/dependabot.yml` parses as YAML and configures the `npm` and `github-actions` ecosystems, weekly, each grouped.
- [ ] The README's Development section says in one sentence what the hosted check runs and that it does not run the Docker suite.
- [ ] `npm run typecheck` is clean and `npm test` still reports 396 passed, 17 skipped.

## Verification Steps
- Parse both YAML files with `python3 -c "import yaml,sys; print(yaml.safe_load(open(sys.argv[1])))" <file>`. Note that PyYAML reads the key `on` as the boolean `True`; that is the parser, not a fault in the file.
- `grep -c pull_request_target .github/workflows/ci.yml` prints 0. `grep -n "uses:" .github/workflows/ci.yml` shows only 40-hex refs with a version comment. `grep -c "secrets\." .github/workflows/ci.yml` prints 0.
- Confirm each pinned SHA is the commit its version tag points to: `gh api repos/actions/checkout/commits/<tag> --jq .sha`, and the same for `actions/setup-node`. Read the inputs from `gh api repos/actions/setup-node/contents/action.yml?ref=<sha> --jq .content | base64 -d`.
- Run the workflow's own shell for each step locally, except `npm ci` and `npm run build`:
  - the unit-test command exactly as written in the workflow, with the JSON written to a scratch directory outside the repository;
  - the count step against that JSON (passes), then against a copy with `numPassedTests` edited below the floor (fails with a non-zero exit and a readable message);
  - the pack step as written (passes, since `dist/` exists locally), then with the path it looks for changed to one that is not packed (fails). Restore it.
  - For the build, run `npx tsc -p tsconfig.build.json --outDir <a fresh temp directory>` and delete the directory. Do not build into `dist/`.
- `node -p "require('./package.json').engines.node"` and `node -p "require('./package-lock.json').packages[''].engines.node"` both print `>=22.12`. `git diff package-lock.json` shows one changed line. `npm ci --dry-run` reports no out-of-sync error and changes nothing (`git status` unchanged afterwards, `node_modules` untouched).
- `npm run typecheck`; `npx vitest run --testTimeout 20000`.

The hosted run itself (green on this flight's pull request, red on a throwaway branch with a type error) is a flight checkpoint, run by the Flight Director after the commit. It is not part of this leg.

## Implementation Guidance

1. **`.nvmrc`** containing `22` and a newline.

2. **`engines`**: change `">=20"` to `">=22.12"` in `package.json` and, by hand, in the root package entry of `package-lock.json`. Do not run `npm install` to regenerate the lockfile.

3. **`.github/workflows/ci.yml`**
   - `name: CI`. `on:` `pull_request` (all branches) and `push` with `branches: [main]`.
   - Top-level `permissions: contents: read`.
   - One job, `check`, `name: check`, `runs-on: ubuntu-latest`, `timeout-minutes: 10`.
   - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` with `persist-credentials: false`.
   - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` with `node-version-file: .nvmrc` and npm caching, if the action at that commit has those inputs under those names. Check; do not rely on memory of an earlier major version.
   - `npm ci`. A short comment: this runs `prepare`, so it is also the clean-clone build that an `npx` install performs.
   - `npm run typecheck`.
   - Unit tests with the default reporter and the JSON reporter, the JSON written under `$RUNNER_TEMP`. Pass the reporter flags through `npm test --`.
   - A step that reads that JSON with `node -e` (or `node --input-type=module -e`) and exits non-zero with a one-line message when `numPassedTests` is below the floor. Floor: 350. Comment: 396 pass as of 2026-11-16; vitest already fails when nothing matches, so this catches a suite that was mostly skipped or excluded; raise it as the suite grows.
   - `npm run build`.
   - A step that runs `npm pack --dry-run --ignore-scripts --json` and exits non-zero when no entry of `files` has the path `dist/index.js`.
   - Keep the inline scripts short and plain. No new file under `src/` or `scripts/` for them.

4. **`.github/dependabot.yml`**: `version: 2`; `npm` at `/`, weekly, one group for minor and patch updates (major updates stay one pull request each); `github-actions` at `/`, weekly, one group for all.

5. **`README.md`**: line 18 to `- Node.js 22.12+`. In Development, one sentence after the command block's explanatory paragraph: every pull request and every push to `main` runs install, typecheck, the unit tests and the build on GitHub Actions; the Docker suite is not part of it and is run locally.

6. **Flight log**: record what was done, each verification with its result, and anything that differed from this leg.

## Edge Cases
- **A setup-node input has a different name or does not exist at the pinned commit**: use what `action.yml` at that commit defines; if caching is not available as a simple input, leave caching out. Record it in the flight log.
- **`npm test -- <flags>` does not pass the flags through as expected**: call `npx vitest run <flags>` in the workflow instead, and record it.
- **`npm ci --dry-run` reports the lockfile out of sync after the hand edit**: stop and report; do not regenerate the lockfile.
- **`$RUNNER_TEMP` in an inline `node -e`**: read it from `process.env.RUNNER_TEMP`, not by shell interpolation inside the script text.
- **The JSON file is missing** (vitest crashed before writing it): the count step must fail, not pass. The test step failing first already stops the job; the count step should still not treat a missing file as success.

## Files Affected
- `.github/workflows/ci.yml` - new
- `.github/dependabot.yml` - new
- `.nvmrc` - new
- `package.json` - `engines.node`
- `package-lock.json` - `engines.node` in the root package entry, one line
- `README.md` - line 18; one sentence in Development

## Citation Audit
Checked on 2026-11-16 against the branch head: `README.md:18` reads "- Node.js 20+"; `package.json` `engines` and the root `engines` of `package-lock.json` read `>=20`; `## Development` exists in the README; neither `.github/` nor `.nvmrc` exists. Action SHAs and the vitest and pack behaviors above were run today. No drift.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
