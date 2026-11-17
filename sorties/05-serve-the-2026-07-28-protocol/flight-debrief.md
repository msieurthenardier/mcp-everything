# Flight Debrief: Serve the 2026-07-28 Protocol

**Date**: 2026-11-17
**Flight**: [Serve the 2026-07-28 Protocol](flight.md)
**Status**: completed (marked at this debrief, with the operator's approval)
**Duration**: 2026-11-16 - 2026-11-17 (charter and design on the first day; second design review, execution, acceptance session, merge, tag and debrief on the second)
**Legs Completed**: 3 of 3
**Plugin version**: mission-control 1.2.3 (1.2.4 was available throughout and not installed)

This debrief was written after the flight's pull request (#20) had merged and after `v0.5.0` was tagged on the merge commit. It is on its own branch, `sortie/05-debrief`. **It found a defect in the tagged release** (Technical, item 1).

Statements of fact are marked **measured** (run for this debrief or during the flight, by whom is said), **read** (from code or an artifact) or **inferred**.

## Outcome Assessment

### Objectives Achieved
mcp-everything depends on the v2 SDK packages and serves each stdio connection in the revision its client opens with: `2026-07-28` for a client that opens with `server/discover` or an enveloped request, and the 2025 handshake, up to `2025-11-25`, for a client that sends `initialize`. `App` builds a server instance per connection and announces tool-list changes to every live one. One line per connection on stderr names the revision. The entry point's wiring is a tested function. The proxy speaks to sandboxed servers through the v2 client and still uses the 2025 handshake. The README has a section on the revisions.

### Charter Criteria

| # | Criterion | Result | Note |
|---|-----------|--------|------|
| 1 | A client that opens in `2026-07-28` connects, lists tools and calls a tool, and the connection is in that revision | **Met** | Unit tests in memory through the function the process uses, with the TypeScript client pinned and in `auto` mode. The built entry over a real pipe (six checks). **Measured** by the Flight Director with the operator's client's own SDK (Python `mcp` 2.3.0) and its own `negotiate` function: `2026-07-28`. |
| 2 | A client that opens with the 2025 handshake negotiates `2025-11-25`, and the existing test suite passes | **Met** | Every test that existed at `d0b5324` passes; edits to them were imports, v2 names, and re-pointing three tests from `app.server`. Docker suite passed three times on the flight's tree and once on `main` for this debrief. |
| 3 | After an install or an uninstall, a connected 2025 client, and a `2026-07-28` client that has subscribed, is told that the tool list changed | **Met, by tests only** | Covered for an install that waits, an install that finishes later, and an uninstall, in both revisions, with the unsubscribed case as a control. **Not observed in the operator's client**: the operator reported the install and the removal, and did not say whether the list changed without a reconnect. |
| 4 | Connected from the operator's GleepGlorp client, mcp-everything is served in `2026-07-28` | **Met, on the operator's report, for a new entry** | Version `0.5.0`, protocol `2026-07-28`, tool list and `list_projects` working. The operator's existing entry for the same build showed `2025-11-25` twice. Why is **not established** (see Not Shown). |

### Checkpoints
All three met. The HAT checkpoint's second half (the diagnostics line agreeing with the client's display) was not compared: the operator skipped that step.

### Not Shown
- **Why the operator's existing entry showed `2025-11-25`.** Two mechanisms were **read** in the client's source: its discover probe times out after 10 s and falls back to `initialize`; and it remembers, per entry, a 2025 revision and then skips the probe. The first was **measured** with the client's own code against this build (start delayed 11 s: `2025-11-25`). A first `npx` launch of a new commit took 7.5 s on the planning machine, and each of the operator's two failed attempts was a first launch of a new commit. Neither mechanism was shown to be the cause. The code that fills the panel the operator read was not traced.
- **Whether GleepGlorp subscribes to tool-list changes.**
- **How any client reacts to the stray stdout line** of Technical item 1.
- **The diagnostics line in a real client's log.**
- **Windows.** Nothing in this flight ran there.
- **The leg-1 "before" pipe run on the untouched tree.** It was taken after the entry extraction; planning's run 1 on the untouched tree gave the same answer to the same message.

## What Went Well
- **The package move and the opt-in were kept apart.** Leg 1's proof was that nothing a client can observe changed, checked by byte-identical pipe output; leg 2 then changed one thing. When the acceptance session went wrong, there was never a doubt about which leg to suspect.
- **The shutdown test was written on v1 and carried across two changes.** It passed on v1, after the package move, and after the switch to `serveStdio`. The second Architect review moved it from leg 2 to leg 1 after a measurement showed the v2 transport closes the server at stdin end even when connected by hand. The debrief's Architect judged that the order paid off.
- **Reviewers re-ran the planning measurements once they could.** The leg-2 design review had the v2 packages installed and confirmed all six observations the leg leaned on, by its own scripts.
- **Mutation at review found what reading had not.** The first Reviewer broke the source about thirty ways. Three source lines survived; following that up, a Developer removed each of the eight announcement calls in turn and found five covered by no test. All five now have one.
- **Reading the client's source ended the acceptance session's guessing in one step.** Once the operator pointed at it, the Flight Director ran the client's own negotiation against the build and had both a pass and a reproduced failure inside a few minutes. (That it was not read at design time is under Process.)
- **The pipe script was tested before it was trusted.** It was run against leg 1's build, where two checks had to pass and four had to fail, before leg 2 relied on it.
- **The operator's sandboxes were untouched**: the four container ids were the same before and after each of four Docker runs.

## What Could Be Improved

### Process
- **A defect reached a tagged release, and the debrief is what found it.** The flight's two code review passes looked at error classification, the live set, shutdown order and the README. Neither asked what the new client library writes, or what its defaults do. The debrief's Architect, asked whether there was "a third behavior change nobody has found", read the client's `listTools` and found two. The merge and the tag came between the review and the debrief. The workflow recommends debriefing before merging; the Flight Director said so at landing and again after the merge.
- **"One behavior changes" was written three ways wrong.** DD7 said one proxy behavior changes. The accounted total is three (a server's own `-32000`/`-32001`; a malformed `tools/call` result; the prefix on the client's own messages), and the debrief adds two unaccounted ones (Technical 1 and 2). The row of DD7's table that says "any other `SdkError`: rejected the call" is exactly where the second one lands; the spec had the signal and the sentence above it claimed the opposite. A pass over the nineteen `SdkErrorCode` values with "what did v1 raise here?" would have found it at design, from a file the planner had open.
- **DD7 marked `listTools` paging "not measured", and nothing closed it.** The spec said the unit suite and the Docker suite would show any difference. No test double pages, so neither could. A "not measured" in a spec needs an owner (a leg criterion, or a named acceptance of the risk), or it is a hole with a label.
- **The prerequisite on the operator's client was inferred when it could have been read.** "GleepGlorp opens with `server/discover` or an enveloped request" was marked inferred and left to the acceptance session. The client's source and a runnable copy of its SDK were on the same machine. Cost: two failed attempts, a version bump made to tell builds apart, a tap written and not used. Reading it first would also have surfaced the 10 s probe timeout before the README told people to launch with `npx`.
- **Flight Director wording beyond the evidence, again.** This is the recurring lesson of this project's debriefs. This flight: DD5 "maximum staleness: none" (wrong; caught by the Architect); the HAT paragraph "which shows whether it subscribes" (an inference; caught); DD10 "cannot end the process" (observed, not proved; caught); DD7 "one behavior changes" (not caught until code review); the flight log's Summary saying the legs were "committed" a few minutes before they were; and leg 3's criterion 6 ticked as "asked; no change requested" when **the operator did not answer the question**. The last one stands in the committed leg file and is corrected here: the README wording has not been reviewed by the operator.
- **Two criteria written by the Flight Director could not be met as written.** Leg 2's AC13 asked for exactly one live connection and a second connection at the same change. Leg 2's AC22 quoted a test name from memory, wrong; caught before the review. Leg 1's AC13 asked for a test with no way to write it; the design review supplied one.
- **The hosted check's comment is wrong again, by the same two.** The leg said to add the flight's tests to the comment's old number, 831, which was already two under the real count. It now says 888 where 890 pass. Squawk 0039, open since the last mission, is about this same comment.
- **Planning order.** The spec was drafted and sent to the Architect before the operator's open-ended input. The operator's three answers then arrived between review cycles, and the second and last cycle was spent on a spec that had changed substantially since the first.
- **The acceptance session's last two steps were put in one message**, against the workflow's one-at-a-time rule, and one of them went unanswered.

### Technical
1. **Defect, in `v0.5.0`: a sandboxed server that does not advertise the `tools` capability makes the client library write a line to stdout, which is the protocol stream.** **Read**: the v2 client's `listTools` returns an empty list and calls `console.debug` when the server's capabilities have no `tools` and strict mode is off (`node_modules/@modelcontextprotocol/client/dist/public-*.mjs`, `async listTools`). **Measured** by the Flight Director, one run, in the repository's installed packages: with a raw upstream answering `initialize` with `capabilities: {}`, `listTools` returned `{"tools":[]}` and the text `Client.listTools() called but server does not advertise tools capability - returning empty list` appeared on stdout, not stderr. **Read** in the v1 tarball (`1.32.2`): v1's `listTools` wrote nothing and always sent the request. So two things changed for such a server: a non-JSON line goes to mcp-everything's own client, and the server is no longer asked for its tools. It is reached from `McpProxy.listTools`, so at install, `discover_tools`, `connect_mcp_server` and `refresh_mcp` of a project whose server omits the capability. No test uses such an upstream. Nothing in `src/` guards stdout against library output. The same library call exists for prompts and resources, which the proxy does not use.
2. **The proxy's paging loop is dead, and the limit moved.** **Read**: `McpProxy.listTools` loops on `nextCursor` for up to 10 pages or 500 tools, calling the client with no cursor on the first pass. The v2 client, called with no cursor, fetches every page itself, clears `nextCursor`, and throws `SdkErrorCode.ListPaginationExceeded` at 64 pages (`listMaxPages`, default 64). So the proxy's loop runs once and its 500-tool bound no longer applies to the client's result until after all pages are fetched; a server with 11 to 63 pages now returns everything; a server with 64 or more fails to list. **Inferred**: no realistic server is affected. No test pages.
3. **`this.listTools() as unknown as Tool[]`** in the `tools/list` handler (`src/server.ts`). `listTools()` returns loose records built from the registry, whose schemas come from third-party projects. The double cast removes the one check the `Tool` type gives. `2026-07-28` is stricter about `tools/list` results, and nothing validates a generated tool's `inputSchema` before it goes out.
4. **The proxy's "gone" codes are an allow-list.** Complete for stdio today (**read**: all nineteen `SdkErrorCode` values were walked by both interviewers, who agree). A later SDK that adds a local "transport broke" code would be classified "rejected the call" and its dead session kept until the next call fails. No test enumerates the codes. Four of them are `2026-07-28`-era codes that become reachable the day the proxy negotiates that revision with a sandboxed server.
5. **The diagnostics line is written at first use, so it misses connections that end early.** A 2025 client that sends `initialize` and never `notifications/initialized`, and a `2026-07-28` client that only sends `server/discover` or subscribes, write no line. Nothing is mis-described; connections are only missed. The README states when the line is written and does not name these two silent cases.
6. **Test hygiene in `test/serving.test.ts`**: one `setImmediate` that orders nothing; the last test builds an instance it never closes; one assertion (`count()` is 1 straight after a waited install returns) leans on the in-memory transport's microtask order and is the test most likely to break on an SDK change.
7. **Structure that exists for tests**: the `connections` getter on `App`, and `announceToolListChanged` being public. Both were asked for by the leg. Acceptable; recorded so that nobody mistakes them for an API.
8. **Install size**: `node_modules/@modelcontextprotocol` went from 6.3 MB to 16 MB (planning's measurement; accepted in DD1).

### Documentation
- **The Setup section recommends `npx` from GitHub and does not say what a slow first launch can do.** A first launch builds; it took 7.5 s here. A client whose `2026-07-28` probe times out before the server is up falls back to the 2025 handshake and shows `2025-11-25`, though the server supports the newer revision. The probe's 10 s is one client's SDK default, not a rule of the protocol, and the note should say so. The server cannot change a client's timeout; no server code is wanted for this.
- **The "Protocol revisions" section has not been read by the operator** (Process, above).
- **DD5's 5 s lag** (a listing can be 5 s behind an install made by another process) is in the spec and not in the README. It is not new.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Spec drafted and reviewed before the operator's open-ended input | The design rested on measurements; the operator's open questions did not change its structure | No. It cost the second review cycle its independence from the first |
| Entry extraction and shutdown test moved from leg 2 to leg 1 at the second design review | A measurement showed leg 1 already changed stdin-end behavior | Yes: pin a lifecycle before the first change beneath it, not before the last |
| No second design review on either leg | Changes after each review were test recipes, names and a script, all as the reviewer recommended | As before: by judgment, with the reason logged |
| A second proxy behavior changed (malformed result: rejected, session kept) | Follows DD7's own table; found at code review | The outcome stands. The lesson is the enum walk (Key Learnings) |
| AC13 of leg 2 met in two steps | The criterion contradicted itself | No |
| Ten tests added in a fix round after a confirmed review | The reviewer's non-blocking notes named untested lines the flight had rewritten | Yes: a line the flight rewrites is the flight's to cover, whoever left it uncovered |
| Version raised to `0.5.0` during the acceptance session | The operator asked, to tell the branch's build from `main`'s | Yes, as a habit: a branch under acceptance should be distinguishable from the default branch in whatever the client displays |
| Acceptance session's artifact commit made by the Flight Director, not a Developer | Artifacts only | Yes for artifact-only commits |
| Steps 5 and 6 of the acceptance session asked together; step 4 skipped | The operator had skipped a step; neither remaining step could fail the leg | No. One went unanswered |
| Merged and tagged before the debrief | The operator's call | See Process |

## Key Learnings
- **When a library splits or renames an error class, walk the whole enum.** For each value: what raised it before, where does it land now. A table with an "anything else" row is a claim about every value, and the claim has to be checked value by value.
- **A dependency swap changes defaults as well as names.** The v2 client pages for you, caches for you, short-circuits on capabilities, and logs. None of that is in a migration's diff. The question to put to a new client or server class is: what does it do when called the way the old one was called, that the old one did not?
- **Stdout is the protocol stream, and nothing in this project defends it.** Any dependency that prints is a protocol fault. A test that asserts nothing unexpected reaches stdout, or a guard at the entry, would have caught Technical 1 whichever library call caused it.
- **If the thing a criterion depends on is on the machine, read it and run it at design time.** That goes for an external client as much as for our own code. "Inferred, to be confirmed at the acceptance session" is for what cannot be reached.
- **A server that starts slower than a client's probe is served in the older revision.** That is a property of probe-and-fall-back negotiation, and of launching through a build step. It will look like a server fault to whoever sees it.
- **Design the acceptance session's failure paths for the client's state**, not only the server's: what the client remembers about an entry, what a new entry does differently, how to tell which build ran.
- **"Not measured" needs an owner.**
- **The debrief's interviews do review work the code review does not**, because they are asked different questions. Until that is reconciled, the debrief belongs before the merge.

## Test Metrics
All **measured** by the debrief's Developer on `main` at `82faddc`, one run each, unless said otherwise.
- **Unit suite** (`npm test`): 22 files, 21 passed and 1 skipped (the gated Docker file); 890 passed, 24 skipped, 0 failed; 1.82 s. No flake in one run. The 24 skipped are the same 24 as before the flight.
- Against mission 02's flight 01 (833 passed, 24 skipped, 1.78 s): +57 passed, +0.04 s. Earlier: sortie 03, 340 in 1.55 s; mission 01's three flights, 396, 447 and 500 in 1.63 to 1.65 s.
- Per file, wall clock (files run in parallel): `server.test.ts` 1.32 s (153 tests), `proxy.test.ts` 0.99 s (63), `installer.test.ts` 0.28 s (124), `serving.test.ts` 0.13 s (24, new), `entry.test.ts` 0.03 s (20, new).
- **The flight's budget** was 0.5 s for its new unit tests. Runs during the flight ranged from 1.74 s to 2.11 s before it and 1.74 s to 1.93 s after. One run cannot resolve a difference of a few hundredths; nothing suggests the budget was approached.
- **Typecheck**: clean.
- **Default Docker suite** (`npm run test:docker`): 22 passed, 2 skipped (the pressure cases), 0 failed; 208.6 s. The flight's own runs: 207 s (leg 1) and 280 s (first review). Mission 02's flight 01: 206.3 s. No case was added. The 280 s run was not explained; it ran while a Reviewer's other work was on the machine (**inferred**).
- **Operator's sandboxes**: four, same container ids before and after.
- **Hosted check**: green on all three commits of the pull request; floor 867, 890 passing.

## Methodology Observations
All under mission-control 1.2.3. Recorded, not judged. Where an observation repeats one from an earlier debrief in this project, it says so.

- **agentic-workflow Phase 3 step 7, against flight-debrief Phase 2: the debrief's Architect interview found a release defect that two code review passes had not, and the merge and the tag came between them.** The workflow recommends the debrief "on the flight branch before merging" and leaves merging first to the operator. The code review (Phase 2d) checks criteria, quality, correctness and tests against the legs; the debrief interview was asked an open question about undiscovered behavior changes and read a library function nobody had been pointed at. Expected: either the review asks that question, or the recommendation to debrief first is stronger than a recommendation. Cost: a tag on a build with a known defect; a debrief on a separate branch and pull request.
- **flight, Phase 5b (max two design review cycles): the second cycle reviewed a spec that had changed substantially after the first, and its own substantial changes (leg order, DD9's mechanism, three new measurements) went to the operator unreviewed.** Same observation as mission 02's flight 01. Cost here: none traced to it.
- **flight (as run by sortie step 4), ordering of user input, crew interview, spec and Architect: not followed.** The Flight Director drafted and reviewed first. The skill's order would have put the operator's three answers before the first review. Cost: the first cycle reviewed a criterion the operator then reworded and a decision the operator had not confirmed.
- **flight, prerequisites: no prompt to ask whether an external system a criterion depends on can be read or run locally.** The skill has a premise audit for the test apparatus. The client was treated as the acceptance session's business. Cost: two failed acceptance attempts, one commit made to diagnose, and a risk (the probe timeout against an `npx` launch) that the README's setup advice walks into.
- **agentic-workflow, Phase 2b and 2d: every leg uncommitted until the flight's end (fourth flight in this project to record it).** This time: two legs, a fix round, 1,860 added lines in one commit; every spawn carried a list of forbidden git commands; two Reviewers and three Developers undid trial edits by hand and compared checksums. No file was damaged. The "before" measurement of leg 1 could not be taken on the untouched tree after the fact, because there was no commit to return to.
- **agentic-workflow, Phase 2d (the flight-end review tries tests): worked, for the third time.** About thirty mutations at the first pass, about a dozen at the second, and a Developer's eight in between. Survivors were found each time and closed.
- **agentic-workflow, Phase 2b, interactive legs ("present a single step, wait"): broken once by the Flight Director, and a step went unanswered.** The skill does not say what to do when the operator skips a step or answers part of a message. The Flight Director recorded the unanswered step as "no change requested", which the record does not support.
- **agentic-workflow, Phase 2d step 3 against the project's crew file: the crew file has a Developer commit the flight; the skill says only "commit".** A Developer was spawned for a commit whose message the Flight Director had written in full. Cost: one spawn of about forty thousand tokens for one command. The later artifact-only commit was made by the Flight Director.
- **agentic-workflow, Phase 2d to Phase 3: no place for verification that needs a pushed branch (fifth flight in a row).** The hosted check ran after the push and was read at landing.
- **flight-debrief, Phase 2 (the Developer runs the full suite): the Docker suite had run on the same code under three hours earlier (fifth flight in a row).** Cost: 3.5 minutes on a daemon that holds the operator's sandboxes. Value this time: a fourth duration, on `main`.
- **flight-debrief, Phase 1 step 3 (where the debrief lands): worked as written.** The pull request had merged; the operator was told and chose a new branch.
- **sortie, Qualify (four criteria) and step 5 (re-check the gate): the gate was re-checked and passed on "one cluster", which the debrief's Architect disputes.** The Flight Director read the cluster as "how the two eras are served from one entry". The Architect counts three: serving the two eras; moving the proxy's client and its error taxonomy; the entry's lifecycle. The charter excluded the proxy side and the design still needed a table of the proxy's behavior. The skill gives no test for "one cluster". Cost: review load of a small mission (ten decisions, two Architect cycles, two leg reviews, two code review passes) carried by a sortie, and the proxy work, where four of the five behavior differences are, got no review of its own.
- **sortie, numbering after an escalation (carried from mission 02's flight 01): the next number after the escalated 04 was taken from a note in a flight log, as that debrief said it would have to be.**
- **SessionStart notice for a newer plugin version**: shown at every start, relayed to the operator three times in this flight, not acted on. No cost observed.

## Was a Sortie the Right Vehicle?
Defensible, and strained. One outcome a user would notice, strictly sequential work, two autonomous legs and an acceptance leg: those held. "One cluster of decisions" is where it strained (above). Had the proxy's move to the v2 client been its own sortie, after this one or before, its error table and its client defaults would have been the whole of a review instead of one decision in ten, and four of the five behavior differences live there. For the next qualification: **when the charter rules a side out and the design still needs a table of that side's behavior, count the table as a cluster.**

## Recommendations
1. **Fix the stdout line and the skipped listing** (Technical 1) before `v0.5.0` is recommended to anyone. It needs one choice (check the capability in the proxy and say what was found, or keep all library output off stdout at the entry, or both) and a test with an upstream that advertises no tools. The entry guard is the one that covers the next library too.
2. **Add the README note on slow first launches**, with the diagnostics line as the way to see what was served.
3. **Decide the proxy's paging** (Technical 2): delete the dead loop and state the client's limit, or pass a cursor and keep the proxy's own bound; add a paged test double either way.
4. **Add the enum walk and the "what are the new defaults" question to this project's flight-design checklist** for any flight that swaps a dependency, and have the Reviewer's prompt ask what new or changed dependencies write to stdout.
5. **Debrief before merge**, or have the code review ask the debrief's open question.

## Action Items
Logged as squawks on 2026-11-17, with the operator's approval. All open.
- [ ] **Defect, grounding**: a sandboxed server without the `tools` capability puts a library line on stdout and is not asked for its tools (Technical 1). → [squawk 0043](../../squawks/0043-library-line-on-stdout-for-a-server-without-tools-capability.md)
- [ ] **Defect**: the proxy's paging loop is dead under the v2 client and the page limit moved to 64 (Technical 2). → [squawk 0044](../../squawks/0044-proxy-paging-loop-is-dead-under-the-v2-client.md)
- [ ] **Servicing**: README Setup note on a slow first `npx` launch and a client's probe timeout; name the two connections that write no diagnostics line. → [squawk 0045](../../squawks/0045-readme-gaps-on-slow-first-launch-and-the-diagnostics-line.md)
- [ ] **Servicing**: the hosted check's comment says 888 where 890 pass; squawk 0039 covers the same comment and its own number is now stale. → [squawk 0039](../../squawks/0039-ci-floor-comment-states-an-old-count.md), updated in place.
- [ ] **Servicing**: a test that enumerates `SdkErrorCode` and pins each value's branch in `callTool` (Technical 4). → [squawk 0046](../../squawks/0046-no-test-pins-each-sdk-error-code-to-a-proxy-outcome.md)
- [ ] **Servicing**: `test/serving.test.ts` hygiene (Technical 6). → [squawk 0047](../../squawks/0047-serving-tests-have-three-loose-ends.md)

Not logged: it failed the squawk gate.
- [ ] Type `App.listTools()` as `Tool[]` and drop the double cast (Technical 3). It fails "no design decisions" (what happens to a generated tool whose `inputSchema` is not an object: dropped, repaired or refused is a choice) and "bounded blast radius" (the honest fix changes `ToolDef.inputSchema` in `src/types.ts`, which the registry, the tool generator and the proxy share). It belongs to the next flight that touches tool listing, or to a small sortie of its own.

Not squawks; for a later flight or the operator:
- [ ] Operator: read the README's "Protocol revisions" section; it was not reviewed in the acceptance session.
- [ ] Operator: the `2025-11-25` on the old GleepGlorp entry belongs to that project (its remembered revision per entry; its 10 s probe against a slow launch). The flight log has the files.
- [ ] Operator: update the plugin to 1.2.4 through `/plugin`.
- [ ] A later flight that lets the proxy negotiate `2026-07-28` with sandboxed servers must revisit the "gone" codes; four era-specific codes become reachable.
- [ ] A later flight that serves over HTTP: the live set and the announcing method are a seam, not a design (sessions that vanish without closing, routing across processes, identity on shared state, slow subscribers).
- [ ] If "which revision" must be answerable for a connection that dies early, the diagnostics line needs a hook where the SDK pins the era; not measured here.
