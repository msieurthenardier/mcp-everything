# Squawk 0011: No test shows an empty-valued variable reaching a server

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

## Report
The README says that an empty value of a `{slug}__{NAME}` variable counts as set. That is tested where variables are matched, and it was measured once at planning that an env file line `NAME=` arrives in a process as set and empty. No test follows an empty value all the way to a launched server: the Docker case added by [sortie 03](../sorties/03-mcp-env-passthrough/flight.md) uses a non-empty value, and its script's check was reasoned, not run, for the empty case. Found in the sortie 03 [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md).

Add one test in which a variable set to the empty string reaches a server as set and empty.

## Evidence
- `test/host-env.test.ts` — `it("returns an empty value as an empty string and ignores undefined", …)`: the matching level only.
- `test/integration/docker.test.ts` — `GATED_MCP_SERVER` tests the variable with `printenv MCPE_IT_GATE_Q7X2 >/dev/null || exit 1`; the case sets it to `"gate-value-Wk2Tn6Bx1Lr4Gd8"`.
- `src/proxy/mcp-proxy.ts:dockerConnector` writes ``${k}=${v}\n`` per variable, so an empty value is written as `NAME=`.
- Sortie 03 flight log, "Env-file probe": a line `EMPTY=` arrived as a variable that is set and empty (one run, on a throwaway container).

## Corrective Action
*(written at completion)*

## Verification
Expected: one new test. Either a unit test that the env file the real connector writes for an empty value holds `NAME=`, or a Docker assertion that a server started with an empty-valued variable sees it as set. If it goes in the Docker suite it must stay within a few seconds; the fork-pressure cases are not involved.

## Sign-Off
*(written at completion)*
