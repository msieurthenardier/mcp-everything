# Squawk 0026: `@types/node` is a major version ahead of the Node floor

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
The project now states a Node floor of 22.12, and the type definitions it compiles against describe Node 26. An API added after Node 22 typechecks cleanly and fails at run time on the floor. The hosted check would not notice either: it runs the newest 22.x, and `tsc` trusts the types. From the [flight 01 debrief](../missions/01-maintenance/flights/01-ci-gate/flight-debrief.md), where both crew members flagged it.

Bring `@types/node` to the floor's major (`^22`) and run the typecheck. If the typecheck then fails because the source already uses a newer API, that is a finding about the floor, not this squawk: stop and report it.

The lockfile changes with this one. The operator's live instance runs from this checkout's `node_modules/`, so regenerate it somewhere that does not disturb that (a separate worktree, for example).

## Evidence
- `package.json` — `"@types/node": "^26.6.6"` under `devDependencies`; `"engines": { "node": ">=22.12" }`.
- Run on 2026-11-16: `node -p "require('./node_modules/@types/node/package.json').version"` prints `26.6.6`; `npm view @types/node@22 version` ends at `22.20.5`, so a 22 line is published.
- `.nvmrc` is `22`; both green hosted runs used v22.23.4 (flight 01 log).
- Not checked: whether `src/` or `test/` uses anything newer than Node 22.12 today.

## Corrective Action
Moved `@types/node` from `^26.6.6` to `^22.20.5` (the newest 22.x; npm wrote the caret range) in `package.json` and regenerated `package-lock.json`. The lockfile change is confined to `@types/node` (26.6.6 to 22.20.5) and its own dependency `undici-types` (8.9.0 to 6.21.0), plus the matching specifier line. Done in a detached worktree so the live `node_modules/` and `dist/` were not touched; only the two files were copied back. No source change was needed.

## Verification
In the worktree with `@types/node` 22.20.5 installed (`node -p "require('./node_modules/@types/node/package.json').version"` printed `22.20.5`):
- `npm run typecheck` passed: nothing in `src/` or `test/` uses a post-22 API (resolves the "Not checked" item in Evidence).
- `npm test` passed: 21 files passed, 1 skipped; 921 tests passed, 24 skipped.
- `npm run build` passed.
- Negative check: a temporary `src/` file importing `mkdtempDisposableSync` from `node:fs` (present in @types/node 26, absent in 22) failed typecheck with TS2305 "has no exported member". Removed afterwards. (Several other probes, such as `process.execve` and `URLPattern`, still typechecked because 22.x backported them, so they were not usable as proof.)
- Worktree removed; `git worktree list` shows only the main checkout. Main checkout diff: `package.json`, `package-lock.json`, and this artifact.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: the lockfile change is confined to `@types/node` (26.6.6 to 22.20.5) and `undici-types` (8.9.0 to 6.21.0), and the typecheck passes against the 22 line. The test count in the Verification above (921) predates later squawks in the batch; the final count is 950.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
