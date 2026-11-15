# Squawk 0001: Proxy relaunch error is built by rewriting another method's message

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
In `McpProxy.open`, the error for a failed relaunch is produced by string replacement on a message assembled in `McpProxy.attempt`. If either wording changes, the replacement silently stops matching and the "after restarting the sandbox" note disappears. In the same method a local variable named `attempt` shadows the method of the same name, which makes the retry logic harder to read. Nothing is broken today; this is upkeep on code added by sortie 01. Raised in the sortie 01 debrief by both the Developer and the Architect.

The user-visible error texts must not change.

## Evidence
- `src/proxy/mcp-proxy.ts:McpProxy.open` — `throw new Error(second.message.replace("did not start:", "did not start (after restarting the sandbox):"))`
- `src/proxy/mcp-proxy.ts:McpProxy.attempt` — builds `` `MCP server "…" (…) did not start: ${reason}` `` and returns it as `message`
- `src/proxy/mcp-proxy.ts:McpProxy.open` — `let attempt = await this.attempt(container, server, startupSec);`
- `test/proxy.test.ts` pins the texts (`did not start: no MCP handshake within …`, `did not start (after restarting the sandbox)`), so the existing tests verify the change.

## Corrective Action
`McpProxy.attempt` now returns `message` as a function `(afterRestart = false) => string` that builds the text from the same parts (server, argv, reason, stderr tail), inserting ` (after restarting the sandbox)` before the colon when asked. `open` calls `second.message(true)` for the relaunch failure and `first.message()` plus the restart note otherwise; no string replacement remains. The local `attempt` is renamed `first`. Error texts are unchanged. One assertion added to "gives up after one relaunch" pinning the full relaunch text.

## Verification
`npm test`: all files pass, 268 passed, 12 skipped (existing assertions unchanged). `npm run typecheck`: clean. Batch re-run at review: 270 passed, 12 skipped (the two extra tests are squawk 0002's).

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-15` on branch `squawk/turnaround-2026-11-15`
