# Flight Log: CI Gate

**Flight**: [CI Gate](flight.md)

## Summary
In flight. One leg, `tier-a-check`.

### Flight Director Notes
- 2026-11-16: The operator said to start the mission after pull request #6 (the squawk turnaround, with squawk 0014) merged. Mission set to `active`, flight to `in-flight`, branch `flight/01-ci-gate` cut from `main` at that merge. The mission's artifacts were untracked until now and are committed with this flight. The maintenance report (`maintenance/2026-11-15.md`) is not: it describes the open design gaps of findings 1b, 2 and 3 in more detail than anything in the public repository, the operator was asked whether to publish it and has not answered, so it stays out of this commit until they do. Links to it from the mission, the flights and squawks 0014 to 0025 do not resolve until then.
- Crew file `.flightops/agent-crews/leg-execution.md` loaded and well formed. Developer and Reviewer on Sonnet.
- Leg `tier-a-check` designed. Before writing it I ran: the latest release tag and commit of `actions/checkout` (v7.0.1) and `actions/setup-node` (v7.1.0); vitest with a filter that matches nothing (exits 1, which settles the flight's open point about an empty run); vitest's JSON reporter (396 passed, 17 skipped); `npm pack --dry-run --ignore-scripts --json` (lists `dist/index.js`). The flight's "340 pass" predates the turnaround; the floor in the leg is 350 against 396.
- Risk tier: **low**. The leg adds three new files and changes one value in two manifests and two README lines; nothing in `src/` or `test/` changes and nothing consumes the new files. A workflow that runs pull requests from forks would normally count as a security-sensitive surface, but its shape (`pull_request` trigger, read-only token, no secret, actions pinned by commit) was set by the CI/CD Reviewer and accepted by the Architect in the inspection's roundtable, and the leg's criteria pin each of those. No design review; the flight-end Reviewer covers the result.
- Not in the leg: the hosted run. Green on this flight's pull request and red on a throwaway branch are flight checkpoints, checked after the commit.
- Local rule for the crew: no `npm ci`, `npm install` or `npm run build` in this checkout, because the operator's live instance runs from its `dist/`.
- Leg landed with no deviation. One independent Reviewer (Sonnet) reviewed the working tree against the leg: `[HANDOFF:confirmed]` on the first pass, no blocking issue. It re-ran the count and pack steps extracted from the YAML (pass and fail cases, including a missing and a malformed report), re-resolved both action tags to the pinned commits, and confirmed there is no `${{ }}` expression in the workflow at all. Non-blocking notes, accepted as they are: an empty-object report fails with "only undefined tests passed" (it fails, the wording is poor); `npm ci` under the runner's older npm and the absence of `actionlint` leave the first hosted run as the real check. The Docker suite was not run: nothing under `src/` or `test/` changed.

---

## Leg Progress

### tier-a-check
**Status**: completed
**Started**: 2026-11-16
**Completed**: 2026-11-16

#### Changes Made
- New `.github/workflows/ci.yml`: `pull_request` and `push` to `main`; `permissions: contents: read`; one job `check` (ubuntu-latest, 10-minute timeout); checkout and setup-node pinned by SHA (v7.0.1, v7.1.0); steps `npm ci`, typecheck, unit tests with default and JSON reporters, minimum-passed-tests floor (350), build, pack check for `dist/index.js`.
- New `.github/dependabot.yml`: npm (minor and patch grouped) and github-actions (all grouped), weekly.
- New `.nvmrc` (`22`). `engines.node` set to `>=22.12` in `package.json` and, by hand, the root entry of `package-lock.json` (one line).
- `README.md`: requirement line is `Node.js 22.12+`; one sentence in Development about the hosted check and the Docker suite.

#### Verification (ran locally, with the workflow's own shell extracted from the YAML and `RUNNER_TEMP` pointed at a scratch directory)
- Both YAML files parse with PyYAML (`on` reads as `True`, as noted). `grep -c pull_request_target` 0; `grep -c 'secrets\.'` 0; both `uses:` lines are 40-hex with a version comment.
- `gh api .../commits/v7.0.1` (checkout) and `.../commits/v7.1.0` (setup-node) return the pinned SHAs. `action.yml` of setup-node at the pinned commit defines `node-version-file` and `cache` (npm) inputs.
- Unit-test step: exit 0, 396 passed, 17 skipped, JSON written. Count step: passes on that JSON (396); exits 1 with "only 100 tests passed, floor is 350" on an edited copy; exits 1 with a readable message when the JSON is missing. Pack step: exits 0; exits 1 when the looked-for path is changed to `dist/nope.js`.
- Build: `npx tsc -p tsconfig.build.json --outDir <fresh temp dir>` exit 0; directory deleted; `dist/` untouched.
- `node -p` on both manifests prints `>=22.12`; `git diff package-lock.json` shows one changed line. `npm ci --dry-run` prints "up to date", no out-of-sync error; `git status` shows only the intended files.
- `npm run typecheck` clean; `npx vitest run --testTimeout 20000`: 396 passed, 17 skipped.

#### Notes
- Not run locally: `npm ci` and `npm run build` themselves (by rule), and the hosted run (a flight checkpoint). `actionlint` is not installed, so the workflow was not linted beyond YAML parsing.
- Caching uses `cache: npm`; the action's `package-manager-cache` default only auto-enables for a `packageManager` field, which this project does not set.

---


## Decisions

---

## Deviations

None from the leg.

---

## Anomalies

---

## Session Notes
