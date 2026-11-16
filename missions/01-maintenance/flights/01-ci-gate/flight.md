# Flight: CI Gate

**Status**: landed
**Mission**: [Maintenance](../../mission.md)

## Contributing to Criteria
- [ ] Every pull request and every push to `main` runs install, typecheck, unit tests and build on a hosted runner, and `engines`, the README and a Node version file state the same Node floor (finding 7).

---

## Pre-Flight

### Objective
Put one small required check in front of `main`. The README tells people to run the server with `npx` straight from the default branch, with no tag, and `prepare` builds at install time, so a type error merged to `main` breaks every new install at once. Nothing checks a pull request today: all five merged so far had zero status checks, and the only evidence they were tested is the agents' flight logs. This flight adds the check, makes the stated Node floor true, and turns on dependency update proposals. It does not add the Docker suite or a scheduled pressure run; those are carried in the report as finding 9.

### Open Questions
N/A — maintenance flight; the one decision was settled in the inspection's roundtable (below).

### Design Decisions

**Node floor**: `>=22.12`
- Rationale: the installed vitest 5.1.0 requires `^22.12 || ^24 || >=26` (read from its `package.json`), so `engines: ">=20"` is already untrue for anyone running the tests. Node 20 is past end of life, and the repository has no issue asking for it.
- Trade-off: people installing on Node 20 get an `engines` warning (not a failure, unless they set `engine-strict`; inferred, not checked). The runtime dependencies and `tsc` would still work there; it is no longer claimed or tested.

**One job, one Node version**
- Rationale: proportionate for a one-maintainer 0.x project; under 1.5 minutes (inferred from local timings: typecheck 0.4 s, unit tests 2 to 4 s; install dominates).
- Trade-off: no OS matrix and no second Node line; a break specific to another platform is not caught.

### Prerequisites
- [x] Squawk 0014 completed (grounding; not a dependency of this flight, but it should not wait behind the mission).
- [x] GitHub Actions is enabled on the repository (it was on 2026-11-15, per `gh api`).

### Pre-Flight Checklist
- N/A — maintenance flights skip Pre-Flight.

---

## In-Flight

### Technical Approach

**Finding 7 — `main` reaches every consumer with no gate; `engines` contradicts the toolchain.**

Evidence (maintenance report, Category 8): `README.md:27` documents `npx -y github:<owner>/mcp-everything` with no ref; `dist/` is gitignored and `"prepare": "npm run build"`. `gh` shows no branch protection, no rulesets, and zero status checks on all five merged pull requests. `package.json` says `"engines": {"node": ">=20"}`; there is no `.nvmrc`. README line 18 says "Node.js 20+".

Fix strategy, as recommended by the CI/CD Reviewer and accepted by the Architect:

1. A workflow triggered by `pull_request` (never `pull_request_target`) and by `push` to `main`. One job on `ubuntu-latest`, `permissions: contents: read`, checkout and setup-node pinned by commit SHA with the version in a comment, Node from `node-version-file: .nvmrc`.
2. Steps: `npm ci` (this runs `prepare`, so it is also the clean-clone build check), `npm run typecheck`, `npm test`, `npm run build`, then a check that `npm pack --dry-run --ignore-scripts` lists `dist/index.js`.
3. A guard against a green run that tested nothing: assert a minimum number of passed tests from vitest's JSON reporter (340 pass today; pick a floor well below, such as 300, and say why in a comment). Confirm from vitest's own documentation in `node_modules` how it exits when no test matches; the reviewer's recollection on this was not checked.
4. `.nvmrc` containing `22`; `"engines": {"node": ">=22.12"}`; README line 18 to "Node.js 22.12+".
5. A Dependabot configuration for the `npm` and `github-actions` ecosystems, weekly, grouped.
6. A sentence in the README's Development section saying what the check runs.

Operator-side, after the first green run so the check's name exists: a ruleset on `main` requiring a pull request and this check, with no force-push. The flight records that it is waiting on the operator; it cannot create the ruleset. The operator may also turn on secret scanning, push protection and Dependabot alerts at the same time (finding 8).

One finding, one leg.

### Checkpoints
- [x] The workflow runs green on this flight's own pull request.
- [x] A deliberately failing commit on a throwaway branch turns it red (a type error), then is discarded.
- [x] `engines`, `.nvmrc` and the README agree.
- [x] The operator has been asked for the ruleset, with the exact check name.

### Adaptation Criteria

**Divert if**:
- `npm ci` or the build fails on the hosted runner for a reason that is not a simple fix here (for example a dev dependency that will not install on the runner's Node 22).
- The check takes more than about 5 minutes, which would change whether it should gate every pull request.

**Acceptable variations**:
- A different minimum-count mechanism, if vitest offers a simpler one than the JSON reporter.
- Dependabot grouping and schedule details.
- Pinning `.nvmrc` to a fuller version than `22`.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `tier-a-check` - The workflow, `.nvmrc`, the `engines` and README edits, the Dependabot configuration (finding 7)

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [ ] Code merged
- [x] Tests passing
- [x] Documentation updated

### Verification
The pull request for this flight shows the check, green. A scratch branch with a type error shows it red. `node -p "require('./package.json').engines.node"` prints `>=22.12`, and `.nvmrc` and README line 18 agree. After the operator adds the ruleset, `gh api repos/{owner}/{repo}/rulesets` lists it and a pull request cannot be merged while the check is red.
