# Squawk 0010: Two separate patterns decide which environment values are unusable

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-16

## Report
A value containing a carriage return, a line feed or a NUL cannot be carried by the env file a proxied MCP server is started with. Two places enforce that, each with its own copy of the pattern: `validateEnv`, for values stored by `connect_mcp_server`, and `launchVariables`, for `{slug}__{NAME}` variables. [Sortie 03](../sorties/03-mcp-env-passthrough/flight.md)'s spec said the second would go "through `validateEnv`"; it shares only the name pattern. If one pattern changes, the other will not follow. Raised in the sortie 03 [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md) by the Architect.

Make both use one exported predicate or pattern. The two error messages stay as they are: they name different things (the unprefixed key, and the prefixed variable).

## Evidence
- `src/proxy/mcp-proxy.ts:validateEnv` — `if (/[\r\n\u0000]/.test(value)) throw new Error(...)`.
- `src/proxy/host-env.ts` — `const BAD_VALUE = /[\r\n\u0000]/;`, used in `launchVariables`.
- `src/proxy/host-env.ts` already imports `ENV_NAME` from `./mcp-proxy.js` for names.

## Corrective Action
Added one exported pattern, `UNUSABLE_ENV_VALUE`, beside `ENV_NAME` in `src/proxy/mcp-proxy.ts`. `validateEnv` and `launchVariables` (`src/proxy/host-env.ts`, which imports it next to `ENV_NAME`) both test against it; the local `BAD_VALUE` copy is gone. Error messages and the `WeakSet` are untouched.

## Verification
Ran `npx vitest run --testTimeout 20000`: 342 passed, 16 skipped, tests unedited. Ran `npm run typecheck`: clean. The pattern is defined once in `src/`, used by both functions.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
