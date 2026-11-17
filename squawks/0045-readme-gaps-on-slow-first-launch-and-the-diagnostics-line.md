# Squawk 0045: The README does not say what a slow first launch does to the revision, or when no diagnostics line is written

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: 2026-11-17

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
README.md only. Under `## Setup`, "a few seconds" became "several seconds" and one sentence now points to `## Protocol revisions`. In `## Protocol revisions`, after the sentence on when the diagnostics line is written, two paragraphs were added: one naming the connections that write no line (a 2025 client that sends `initialize` and never `notifications/initialized` and makes no tool request; a `2026-07-28` client that only sends `server/discover` or only subscribes), and one on a slow first launch (after review, worded about clients that work this way, not clients in general: "Some clients probe for `2026-07-28` first and fall back to `initialize` when the probe gets no answer in time. How long they wait is the client's choice, not a rule of the protocol (one client's SDK allows 10 s)." and "Such a client, if it gives up before the server is up, falls back to the 2025 handshake and shows `2025-11-25`, although the server supports `2026-07-28`."; the server does nothing wrong; the `connection:` line shows the served revision; a second launch or a checkout avoids it). No heading added, removed or moved. No code changed.

## Verification
- `git diff -- README.md` read line by line. `grep -c "^## \|^### " README.md` is 16 before and after; same headings.
- Trace:
  - No line for `initialize` without `notifications/initialized` and no tool request: `src/server.ts` `createServer`, `noteConnection` is called only from `server.oninitialized`, the `tools/list` handler and the `tools/call` handler.
  - No line for a `2026-07-28` client that only sends `server/discover` or only subscribes: no `noteConnection` call in any other handler (code matches the report; no difference). A 2025 client that sends a tool request without `initialized` does get the line, which is why the text says "makes no tool request".
  - Late probe falls back to 2025 and shows `2025-11-25`; server answers the late probe then serves `initialize`: flight log, Flight Director Notes, acceptance session (client negotiation code against an 11 s delayed start ended in `2025-11-25`).
  - "several seconds" for a first launch: flight log `npx` first-launch measurement (7.5 s, one machine), stated without a figure. 10 s named as one client's SDK default, not a protocol rule: squawk report.
  - Second launch or checkout avoids it: flight log timings (1.7 s warm npx, 0.17 s `node dist/index.js`).
  - `connection:` line on stderr shows the served revision: `src/server.ts` `this.log(`connection: MCP protocol ${version}`)`, README's existing example.
- Review round: the first wording stated one client's behaviour as general client behaviour; the evidence is one client (the operator's client, 10 s in its SDK), so the text now claims it only for clients that probe first.
- `npm test`, when this squawk's text was first written: 21 files passed, 1 skipped; 915 tests passed, 24 skipped. (The README is not tested; the batch ended at 916.)
- `git diff --stat -- src test` identical before and after.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it checked each added sentence against the code and the flight log, and found two sentences stating one client's behavior as every client's; they were reworded. A second independent Reviewer (Sonnet) reviewed the fix round alone and confirmed it (916 passed, 24 skipped). It read the paragraph and the Setup sentence again and found every claim scoped to "some clients" or "one client's SDK", with no heading added, removed or moved.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048.
