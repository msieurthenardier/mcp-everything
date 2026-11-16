# Squawk 0011: No test shows an empty-valued variable reaching a server

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-16

## Report
The README says that an empty value of a `{slug}__{NAME}` variable counts as set. That is tested where variables are matched, and it was measured once at planning that an env file line `NAME=` arrives in a process as set and empty. No test follows an empty value all the way to a launched server: the Docker case added by [sortie 03](../sorties/03-mcp-env-passthrough/flight.md) uses a non-empty value, and its script's check was reasoned, not run, for the empty case. Found in the sortie 03 [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md).

Add one test in which a variable set to the empty string reaches a server as set and empty.

## Evidence
- `test/host-env.test.ts` — `it("returns an empty value as an empty string and ignores undefined", …)`: the matching level only.
- `test/integration/docker.test.ts` — `GATED_MCP_SERVER` tests the variable with `printenv MCPE_IT_GATE_Q7X2 >/dev/null || exit 1`; the case sets it to `"gate-value-Wk2Tn6Bx1Lr4Gd8"`.
- `src/proxy/mcp-proxy.ts:dockerConnector` writes ``${k}=${v}\n`` per variable, so an empty value is written as `NAME=`.
- Sortie 03 flight log, "Env-file probe": a line `EMPTY=` arrived as a variable that is set and empty (one run, on a throwaway container).

## Corrective Action
Added one Docker case, `gives a proxied MCP server a variable whose value is empty as set and empty`, to `test/integration/docker.test.ts`. An App is given `gron__MCPE_IT_GATE_Q7X2` set to the empty string; the existing gated shell server (which exits unless the variable is set) is refreshed in, and its `reveal` tool must answer `gate=`. Route (b) was chosen because route (a) would need a new seam in `dockerConnector` to observe the env file, and the connector's unit tests and any seam they need belong to a later maintenance flight. No change to `src/`.

## Verification
Ran `MCPE_DOCKER_TESTS=1 npx vitest run test/integration -t 'installs a Go CLI|variable whose value is empty'` (the install case is needed to create the project): both passed; the new case took 2.7 s. With the variable left unset the case failed (`refresh_mcp` returned an error), then was restored and passed. `npx vitest run --testTimeout 20000`: 342 passed, 17 skipped (one more skipped than before, the new Docker-gated case); `npm run typecheck` clean.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
