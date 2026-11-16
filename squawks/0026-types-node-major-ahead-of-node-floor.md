# Squawk 0026: `@types/node` is a major version ahead of the Node floor

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

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
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
