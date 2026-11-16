# Squawk 0009: The README does not say that `refresh_mcp` is a full discovery

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

## Report
`refresh_mcp` reruns the whole of discovery, the same one `discover_tools` runs, so its duration grows with the number of commands a project has and the help output they print. [Sortie 03](../sorties/03-mcp-env-passthrough/flight.md)'s spec names this as a risk (DD5: a large project "could outlast a client's request timeout") and marks it not measured. It ended up neither tested nor documented; the [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md) found it had fallen through.

Add one sentence to the README where `refresh_mcp` is described: it is a full discovery, quick on a small project and longer on one with many commands. Documentation only.

## Evidence
- `src/install/installer.ts:Installer.refreshMcp` calls `this.discover(record, [])`, as `rediscover` does.
- `src/install/installer.ts:Installer.discover` — help fetching budget `budget: { remaining: 90 }`, each call allowed `helpTimeoutSec` (`MCPE_HELP_TIMEOUT`, default 10).
- Measured in sortie 03, one small project (two commands): 1.2 to 1.3 s per refresh. Nothing larger was measured.
- `README.md`, section "Giving a server its environment": describes what `refresh_mcp` does and reports; no word on how long it takes. A search of the README for refresh or discovery together with "longer", "duration" or "takes" finds nothing.

## Corrective Action
*(written at completion)*

## Verification
Expected: the sentence is present in the README's description of `refresh_mcp`, and claims no figure beyond what was measured. `npm test` and `npm run typecheck` unaffected.

## Sign-Off
*(written at completion)*
