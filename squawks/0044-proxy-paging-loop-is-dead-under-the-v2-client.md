# Squawk 0044: The proxy's own paging of a tool list no longer runs; the client pages by itself, to a different limit

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: —

## Report
`McpProxy.listTools` follows `nextCursor` itself for at most 10 pages or 500 tools. Since the move to the v2 client that loop runs once: called with no cursor, the client fetches every page, returns them joined with no `nextCursor`, and fails with `ListPaginationExceeded` at 64 pages. So a server with 11 to 63 pages now returns everything where it was cut at 10 pages, the 500-tool stop is applied only after everything has been fetched, and a server with 64 or more pages fails to list ("failed to list its tools", session closed) where it used to return its first 10 pages. No realistic server is thought to be affected.

Make the code say what happens. Either remove the dead loop, keep the cut at 500 tools, and set the client's `listMaxPages` to the bound wanted; or page explicitly so that the proxy's bound is the one that applies. Whichever is chosen, a test with an upstream that pages: the bound is reached and the outcome at the bound is asserted. If choosing needs more than reading the two functions, that is the scope gate.

## Evidence
- `src/proxy/mcp-proxy.ts`, `McpProxy.listTools` — `for (let page = 0; page < 10; page++) {` … `if (!cursor || tools.length >= 500) break;`.
- `node_modules/@modelcontextprotocol/client/dist/public-*.mjs`, `async listTools` — a call without `params.cursor` goes to `_listAllPages`, which throws `SdkErrorCode.ListPaginationExceeded` when `pages >= this._listMaxPages`; `this._listMaxPages = options?.listMaxPages ?? DEFAULT_LIST_MAX_PAGES` (64).
- `grep -n cursor test/proxy.test.ts test/helpers.ts`: nothing. No test double pages.
- The flight spec marked this "not measured" (DD7) and no leg closed it. Read, not run. Debrief, Technical 2.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
