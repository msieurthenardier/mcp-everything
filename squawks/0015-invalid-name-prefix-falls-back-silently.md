# Squawk 0015: An invalid `MCPE_NAME_PREFIX` silently becomes `mcpe-`

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The name prefix decides which containers and volumes an instance treats as its own. A value that does not match the allowed pattern is dropped without a word and the default `mcpe-` is used. An operator who sets a prefix to keep two registries apart and mistypes it (an uppercase letter, a leading `-`) is back on the shared default, where two registries replace each other's sandboxes (the sortie 03 debrief's environment note). Finding 3a of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Make a set-but-invalid prefix a startup error that names the variable and the allowed form. An unset or empty variable keeps the default.

## Evidence
- `src/config.ts:loadConfig` — `namePrefix: /^[a-z0-9][a-z0-9_.-]{0,30}$/.test(env.MCPE_NAME_PREFIX ?? "") ? env.MCPE_NAME_PREFIX! : "mcpe-",`
- `README.md:409` — documents the variable and its default; says nothing about invalid values.
- Read, not run.

## Corrective Action
`loadConfig` now takes the prefix through a small `parseNamePrefix` in `src/config.ts`: unset or empty gives `mcpe-`; a value matching `^[a-z0-9][a-z0-9_.-]{0,30}$` is kept; any other value throws `MCPE_NAME_PREFIX="<value>" is not valid: use 1-31 characters from [a-z0-9_.-], starting with a letter or digit.` The pattern is unchanged. The README's `MCPE_NAME_PREFIX` row now says an invalid value is refused at startup. Three `it` blocks (7 cases: unset and empty, a valid prefix, five refused values) added to `test/config.test.ts`.

## Verification
Wrote the cases first: the five invalid-prefix cases failed against the old code (silent fallback), the unset, empty and valid cases passed. After the fix, `npx vitest run --testTimeout 20000`: 349 passed, 17 skipped (was 342/17; +7 new cases). `npm run typecheck` clean.

`src/index.ts` needed no change: `loadConfig()` runs inside `main()`, whose `.catch` writes `[mcp-everything] fatal: <stack>` to stderr and calls `process.exit(1)`. Ran `MCPE_NAME_PREFIX=Bad- npx tsx src/index.ts` with stdin closed: stderr showed `[mcp-everything] fatal: Error: MCPE_NAME_PREFIX="Bad-" is not valid: ...` followed by a stack; no hang. The message is readable, though it carries a stack trace (existing behaviour for all startup failures).

Read `test/integration/docker.test.ts` (not run): every prefix is `mcpe-it-<pid>-` or that plus `retry-`, which the pattern accepts. No other test sets `MCPE_NAME_PREFIX`.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed. The first review found the count of added test cases misstated in this record; corrected
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
