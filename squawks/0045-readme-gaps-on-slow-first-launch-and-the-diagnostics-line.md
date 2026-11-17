# Squawk 0045: The README does not say what a slow first launch does to the revision, or when no diagnostics line is written

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: —

## Report
Two gaps in what the README says about protocol revisions, both met in sortie 05's acceptance session or its debrief.

Setup recommends `npx -y github:…`. A first launch of a new commit downloads and builds; it took 7.5 s on one machine. A client that probes for `2026-07-28` and gives up before the server is up falls back to the 2025 handshake, and then shows `2025-11-25` for a server that supports the newer revision. Say so under Setup or in "Protocol revisions": that it can happen, that the probe's limit is the client's (10 s in one client's SDK, not a rule of the protocol), that the line `connection: MCP protocol <revision>` on stderr shows what was served, and that a second launch or a local build avoids it.

"Protocol revisions" says when the diagnostics line is written. It does not say which connections write none: a 2025 client that sends `initialize` and never `notifications/initialized`, and a `2026-07-28` client that only sends `server/discover` or only subscribes. Name them.

Text only.

## Evidence
- `README.md`, `## Setup` — "The first launch downloads and builds the server, which takes a few seconds"; nothing about a client's timeout.
- `README.md`, `## Protocol revisions` — states the two moments the line is written.
- `sorties/05-serve-the-2026-07-28-protocol/flight-log.md`, Flight Director Notes: the 11 s delayed start negotiated `2025-11-25` with the operator's client's own code; `npx` timings 7.5 s, 1.7 s, 1.7 s.
- `src/server.ts`, `createServer` — the line's closure is called from `oninitialized` and from the two tool handlers only.
- Debrief, Documentation and Technical 5.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
