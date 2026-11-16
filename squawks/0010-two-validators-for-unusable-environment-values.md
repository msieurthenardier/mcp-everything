# Squawk 0010: Two separate patterns decide which environment values are unusable

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

## Report
A value containing a carriage return, a line feed or a NUL cannot be carried by the env file a proxied MCP server is started with. Two places enforce that, each with its own copy of the pattern: `validateEnv`, for values stored by `connect_mcp_server`, and `launchVariables`, for `{slug}__{NAME}` variables. [Sortie 03](../sorties/03-mcp-env-passthrough/flight.md)'s spec said the second would go "through `validateEnv`"; it shares only the name pattern. If one pattern changes, the other will not follow. Raised in the sortie 03 [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md) by the Architect.

Make both use one exported predicate or pattern. The two error messages stay as they are: they name different things (the unprefixed key, and the prefixed variable).

## Evidence
- `src/proxy/mcp-proxy.ts:validateEnv` — `if (/[\r\n\u0000]/.test(value)) throw new Error(...)`.
- `src/proxy/host-env.ts` — `const BAD_VALUE = /[\r\n\u0000]/;`, used in `launchVariables`.
- `src/proxy/host-env.ts` already imports `ENV_NAME` from `./mcp-proxy.js` for names.

## Corrective Action
*(written at completion)*

## Verification
Expected: one definition of the pattern in `src/`, used by both functions; the existing tests for both (`test/proxy.test.ts` "validateEnv", `test/host-env.test.ts`) pass unchanged.

## Sign-Off
*(written at completion)*
