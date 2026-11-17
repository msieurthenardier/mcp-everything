# Squawk 0046: No test pins each of the client library's error codes to an outcome in the proxy

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: 2026-11-17

## Report
`McpProxy.callTool` treats three of the client library's local error codes as "the server is gone", one as a timeout, and every other code as "rejected the call", with the session kept. The three are an allow-list. A later release of the library that adds a code meaning the transport broke would be classified as a rejected call, and the dead session kept until the next call fails. Nothing would notice at the upgrade.

Add a test that walks `Object.values(SdkErrorCode)` and asserts, for each value, the outcome chosen for it on purpose (gone, timed out, or rejected), failing on a value it does not name. Test only; the classification does not change.

## Evidence
- `src/proxy/mcp-proxy.ts` — `const GONE_CODES: ReadonlySet<string> = new Set([SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.NotConnected]);` and the branches of `callTool`.
- `node_modules/@modelcontextprotocol/client/dist/index-*.d.mts` — nineteen `SdkErrorCode` values at `2.4.0`; both of the debrief's interviewers walked them and found today's classification right for stdio.
- `test/proxy.test.ts` has a test for each outcome and none that enumerates the codes.
- Read, not run. Debrief, Technical 4. Four of the codes belong to the `2026-07-28` revision and become reachable if the proxy ever negotiates it with a sandboxed server.

## Corrective Action
Test only; `src/` is unchanged. In `test/proxy.test.ts`, inside `McpProxy error classification`, added an explicit table `OUTCOME` (code to `timeout` | `gone` | `rejected`) covering all nineteen `SdkErrorCode` values of `@modelcontextprotocol/client` 2.4.0: `RequestTimeout` is `timeout`; `ConnectionClosed`, `SendFailed`, `NotConnected` are `gone`; the other fifteen are `rejected`. Two tests use it:
- One compares the table to `Object.values(SdkErrorCode)`. A code in the package but not in the table fails with a message that a new code has appeared and must be classified deliberately; a key in the table that the package no longer has fails too.
- A table-driven `it.each` over `Object.values(SdkErrorCode)` (so a new code also gets its own failing case). For each code, a connector wraps the fake upstream's transport `send` so the first `tools/call` throws `new SdkError(code, "chosen failure")`. The client lets this through unchanged (as it did for a plain `Error`), so no other delivery was needed. The test asserts the error text matches exactly the chosen outcome (`timed out after 5s; the server was stopped`, `stopped while running "add"`, or `rejected the call to "add"`, and not the other two), `proxy.size` (1 for rejected, 0 otherwise), and that a following call succeeds and reaches the same launch (rejected, 1 launch) or a new one (timeout and gone, 2 launches). No timer is waited on.

## Verification
- Baseline before: 895 passed, 24 skipped. Mutations were run against `test/proxy.test.ts` alone (each undone by editing; `src/proxy/mcp-proxy.ts` md5 verified back to its original afterwards):
  1. Removed `SendFailed` from `GONE_CODES`: 1 failed (`sorts the client's error code SEND_FAILED into its chosen outcome`).
  2. Added `InvalidResult` (rejected today) to `GONE_CODES`: 2 failed (the `INVALID_RESULT` case, and the existing malformed-result test).
  3. Deleted the `ClientHttpForbidden` entry from the test's own table: 2 failed, with "A new SdkErrorCode has appeared (CLIENT_HTTP_FORBIDDEN); it must be classified deliberately ..." and the per-code case. Entry restored.
- With the mutations undone: `test/proxy.test.ts` 87 passed.
- Final `npm run typecheck`, `timeout 120 npm test` and `npm run build`: see the Developer report for counts.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it checked the table against `Object.values(SdkErrorCode)` (nineteen values), showed a deleted table entry failing with the "new code" message, and showed a code removed from the gone set failing its case, which also shows that an error thrown from the transport's `send` reaches the classification unchanged.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048.
