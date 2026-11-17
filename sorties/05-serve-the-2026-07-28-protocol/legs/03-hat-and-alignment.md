# Leg: hat-and-alignment

**Status**: in-flight
**Flight**: [Serve the 2026-07-28 Protocol](../flight.md)

## Objective
The operator sees, in their own GleepGlorp client, mcp-everything served in the `2026-07-28` revision from a build of the sortie's branch.

## Context
- Interactive leg. The operator performs each step and reports what they see; the Flight Director guides one step at a time and does not run the steps for them. No Developer or Reviewer is spawned unless a step fails and a fix is needed.
- Both implementation legs are completed and committed (`eed2610`); draft pull request #20 is open.
- This is charter criterion 4, and the one thing the automated tests and the pipe check do not show: a real `2026-07-28` client opening a connection its own way.
- **What settles criterion 4 is the revision GleepGlorp's UI shows.** The diagnostics line is compared only if GleepGlorp shows the server's stderr. Whether GleepGlorp's tool list follows an install is recorded as seen; it does not show whether GleepGlorp subscribes, since a client may simply ask again (flight spec, HAT paragraph).
- The risk the spec named: if GleepGlorp asks for `2026-07-28` through `initialize`, it is answered `2025-11-25`, and no server on this SDK can do otherwise. That is the flight's third divert condition: the sortie then lands with criteria 1 to 3, and criterion 4 is reworded with the operator. It is not fixed inline.
- A fix that changes wording is made inline through a Developer. A request that adds behavior is a feature and goes through a scoped design review first; the Flight Director says out loud which it is.

## Inputs
- This checkout's `dist/` built from `eed2610` on 2026-11-17 (the Flight Director rebuilt it after the commit and re-ran the pipe check: `RESULT: PASS`).
- The operator's GleepGlorp client, configured to start mcp-everything from this checkout's `dist/index.js`, or pointed at it for this session.
- The operator's registry holds four projects (`ha_googlehome`, `rea`, `cowsay`, `gron`). None of them is to be uninstalled for this test.

## Outputs
- Each step's result recorded in the flight log, with the operator's observations.
- Any fix made along the way, reviewed and committed.

## Acceptance Criteria
- [ ] 1. GleepGlorp starts mcp-everything from the branch build and connects.
- [ ] 2. GleepGlorp's UI shows the connection's revision as `2026-07-28`. *(Charter criterion 4.)*
- [ ] 3. GleepGlorp lists mcp-everything's tools, the built-in ones and the installed projects', and a call made from it (`list_projects`) returns its result.
- [ ] 4. If GleepGlorp shows the server's stderr: it holds `[mcp-everything] connection: MCP protocol 2026-07-28`, once for the connection. If it does not show stderr, this is recorded as not compared.
- [ ] 5. The operator installs a small project they do not already have, and then uninstalls it, and reports each time whether GleepGlorp's tool list showed the change without a reconnect. Recorded as seen; neither answer fails the leg.
- [ ] 6. The operator says whether the README's "Protocol revisions" section and the diagnostics line read right to them; anything they want changed is fixed or recorded.

## Verification Steps
One step per criterion, in order, each performed by the operator and reported back. A step that fails is diagnosed, and fixed or diverted, before the next one starts.

## Implementation Guidance
1. The operator restarts or reconnects mcp-everything in GleepGlorp so that it loads the branch build.
2. The operator reads the revision in GleepGlorp's UI.
3. Walk the remaining criteria in order.

## Edge Cases
- **GleepGlorp shows `2025-11-25`**: first check which build it started (the diagnostics line exists only in the branch build; an older build writes none). If it is the branch build, GleepGlorp opened with `initialize`: divert as above.
- **GleepGlorp does not connect at all**: read its error. A `-32022` answer means it sent a revision this SDK does not support; a missing envelope key is answered `-32602` naming the key.
- **The tool list does not follow an install**: by the revision's rule a client that has not subscribed is not told. The tools are still there on the next listing, and callable through `call_project_tool`.

## Files Affected
- `sorties/05-serve-the-2026-07-28-protocol/flight-log.md` - HAT entry
- Source files only if a step leads to a fix.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
