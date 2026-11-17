# Squawk 0044: The proxy's own paging of a tool list no longer runs; the client pages by itself, to a different limit

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: 2026-11-17

## Report
`McpProxy.listTools` follows `nextCursor` itself for at most 10 pages or 500 tools. Since the move to the v2 client that loop runs once: called with no cursor, the client fetches every page, returns them joined with no `nextCursor`, and fails with `ListPaginationExceeded` at 64 pages. So a server with 11 to 63 pages now returns everything where it was cut at 10 pages, the 500-tool stop is applied only after everything has been fetched, and a server with 64 or more pages fails to list ("failed to list its tools", session closed) where it used to return its first 10 pages. No realistic server is thought to be affected.

Make the code say what happens. Either remove the dead loop, keep the cut at 500 tools, and set the client's `listMaxPages` to the bound wanted; or page explicitly so that the proxy's bound is the one that applies. Whichever is chosen, a test with an upstream that pages: the bound is reached and the outcome at the bound is asserted. If choosing needs more than reading the two functions, that is the scope gate.

## Evidence
- `src/proxy/mcp-proxy.ts`, `McpProxy.listTools` — `for (let page = 0; page < 10; page++) {` … `if (!cursor || tools.length >= 500) break;`.
- `node_modules/@modelcontextprotocol/client/dist/public-*.mjs`, `async listTools` — a call without `params.cursor` goes to `_listAllPages`, which throws `SdkErrorCode.ListPaginationExceeded` when `pages >= this._listMaxPages`; `this._listMaxPages = options?.listMaxPages ?? DEFAULT_LIST_MAX_PAGES` (64).
- `grep -n cursor test/proxy.test.ts test/helpers.ts`: nothing. No test double pages.
- The flight spec marked this "not measured" (DD7) and no leg closed it. Read, not run. Debrief, Technical 2.

## Corrective Action
Squawk 0043's fix already took the second option. To avoid the library's empty-list answer for a server without the `tools` capability, `McpProxy.listTools` now calls `session.client.request({ method: "tools/list", ... })`, which returns one page per call and has no paging of its own. The proxy's loop (10 pages, stop once 500 or more tools are in hand, checked per page so the result can pass 500 by up to one page, as with v1) is live again and is the only bound; the library's 64-page `ListPaginationExceeded` cannot be reached from here.

What was done here: read the loop and confirmed the above; added three tests (see Verification); in `src/proxy/mcp-proxy.ts` named the bounds (`MAX_LIST_PAGES = 10`, `MAX_LIST_TOOLS = 500`, same values) and extended the comment at the `request` call to say that it pages one at a time so the loop bounds the listing. In `test/proxy.test.ts` the raw upstream double now passes the request's `params` to its answer function.

Not done, for a decision: a list cut at the bound is returned silently, as it was with v1. Whether the caller should be told is a behaviour question, left open.

The `_excludeInvalidXMcpHeaderTools` filter (run by the library's `listTools`, not by `request`) returns at once unless the protocol era is "modern" (2026-07-28) and the transport is not stdio. The proxy opens only stdio servers with the 2025 handshake, so the filter never applied to it and skipping it changes nothing.

## Verification
Added in `test/proxy.test.ts` (describe "paging a tool list"), each with the mutation tried in `src/proxy/mcp-proxy.ts`, then undone by editing:
- three pages return all six tools in order, asked with cursors `[undefined, "p1", "p2"]`. Ignoring `nextCursor`: fails (also fails the other two).
- a server that always gives a cursor is asked exactly 10 times, 10 pages' tools returned, no error, session kept. Page bound raised to 64: fails.
- pages of 200 tools: asked 3 times (cursors `[undefined, "p1", "p2"]`), 600 tools returned, not asked again, session kept. 500 check removed: fails.
Baseline run of the three: pass. `npm run typecheck`: clean. `timeout 120 npm test`: 895 passed, 24 skipped (892 before). `npm run build`: clean.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it confirmed the bounds are unchanged (10 pages, 500 tools), that a server repeating one cursor is stopped at ten pages, and that the reading of the library's header filter matches the library's source; four trial changes (ignore `nextCursor`; raise the page bound; remove the tool bound; loosen the tool bound) each failed a paging test.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048.
