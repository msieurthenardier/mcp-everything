# Squawk 0065: Dependabot proposes @types/node majors that squawk 0026 rules out

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
Squawk 0026 pinned `@types/node` to the Node 22 major (`^22.20.5`), to match the Node floor (`engines` `>=22.12`, `.nvmrc` 22): types from a later major let code typecheck that fails on the floor. Dependabot still opens a pull request for every new major. #29 proposes 26.6.6, and its CI passes because the typecheck uses the new types.

## Evidence
- `.github/dependabot.yml`: the npm entry groups only `minor` and `patch` updates, and has no `ignore`.
- PR #29: `dependabot/npm_and_yarn/types/node-26.6.6`, open since 2026-11-23.
- `package.json`: `"@types/node": "^22.20.5"`; squawk 0026.

## Corrective Action
`.github/dependabot.yml`, npm entry: added `ignore` for `@types/node` with `update-types: ["version-update:semver-major"]`, under a comment pointing to squawk 0026. PR #29 is not closed (left to the Flight Director and the operator).

## Verification
The YAML parses (PyYAML); the npm entry keeps its `minor-and-patch` group. Dependabot's next run opening no `@types/node` major pull request is still to be observed.

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at the routine maintenance of 2026-11-25 (CI/CD finding C1, Action Required).
