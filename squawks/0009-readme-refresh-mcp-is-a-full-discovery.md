# Squawk 0009: The README does not say that `refresh_mcp` is a full discovery

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-16

## Report
`refresh_mcp` reruns the whole of discovery, the same one `discover_tools` runs, so its duration grows with the number of commands a project has and the help output they print. [Sortie 03](../sorties/03-mcp-env-passthrough/flight.md)'s spec names this as a risk (DD5: a large project "could outlast a client's request timeout") and marks it not measured. It ended up neither tested nor documented; the [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md) found it had fallen through.

Add one sentence to the README where `refresh_mcp` is described: it is a full discovery, quick on a small project and longer on one with many commands. Documentation only.

## Evidence
- `src/install/installer.ts:Installer.refreshMcp` calls `this.discover(record, [])`, as `rediscover` does.
- `src/install/installer.ts:Installer.discover` — help fetching budget `budget: { remaining: 90 }`, each call allowed `helpTimeoutSec` (`MCPE_HELP_TIMEOUT`, default 10).
- Measured in sortie 03, one small project (two commands): 1.2 to 1.3 s per refresh. Nothing larger was measured.
- `README.md`, section "Giving a server its environment": describes what `refresh_mcp` does and reports; no word on how long it takes. A search of the README for refresh or discovery together with "longer", "duration" or "takes" finds nothing.

## Corrective Action
Added one sentence to the README's description of `refresh_mcp` (section "Giving a server its environment"): "Because it is a full discovery, it is quick on a small project and takes longer on one with many commands." It follows the sentence saying `refresh_mcp` runs the same discovery as `discover_tools`. No figure is claimed, since only one small project was measured. Documentation only.

## Verification
Read the README after the edit: the sentence is present in the `refresh_mcp` description and states no figure. Ran `npx vitest run --testTimeout 20000`: 342 passed, 16 skipped. Ran `npm run typecheck`: clean.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
