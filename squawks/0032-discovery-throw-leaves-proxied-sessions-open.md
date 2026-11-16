# Squawk 0032: A throw from discovery during an install leaves proxied sessions open

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
During an install, discovery starts the project's MCP servers through the proxy to list their tools. If something after that throws (discovery itself, or the registry write that follows), the `catch` marks the project `failed` and, since flight 02, takes the sandbox off the network, but it does not stop those servers. Their sessions stay open in the proxy for a project the caller was just told failed, until a reinstall, an uninstall or the idle reaper. Seen in leg 1 of flight 02 and left alone as existing behavior; sorted in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md).

In the `catch`, when a sandbox was created, close the project's sessions (`proxy.closeProject`, best effort, never masking the original error), as `install` already does at its start.

**Scope gate**: closing the sessions is the whole squawk. If the fix needs a decision about what `failed` means for a project that was usable before a reinstall, stop and escalate to the design sortie.

## Evidence
- `src/install/installer.ts:311 — "await this.discover(record, []);"` inside `install`'s `try`; `discoverMcp` calls `this.proxy.listTools(record.container, …)`, which opens a session per server.
- `src/install/installer.ts:318` — the `catch`'s kept-sandbox branch: `takeOffline`, `registry.put`, nothing for the proxy.
- Read, not run. Flight 02's case "a step fails after the policy was applied" already replaces `discover` with one that throws; a variant that opens a session first and asserts `proxy.size` is 0 afterwards would show it.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
