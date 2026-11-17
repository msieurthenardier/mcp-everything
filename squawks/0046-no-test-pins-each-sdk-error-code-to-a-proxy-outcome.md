# Squawk 0046: No test pins each of the client library's error codes to an outcome in the proxy

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: —

## Report
`McpProxy.callTool` treats three of the client library's local error codes as "the server is gone", one as a timeout, and every other code as "rejected the call", with the session kept. The three are an allow-list. A later release of the library that adds a code meaning the transport broke would be classified as a rejected call, and the dead session kept until the next call fails. Nothing would notice at the upgrade.

Add a test that walks `Object.values(SdkErrorCode)` and asserts, for each value, the outcome chosen for it on purpose (gone, timed out, or rejected), failing on a value it does not name. Test only; the classification does not change.

## Evidence
- `src/proxy/mcp-proxy.ts` — `const GONE_CODES: ReadonlySet<string> = new Set([SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.NotConnected]);` and the branches of `callTool`.
- `node_modules/@modelcontextprotocol/client/dist/index-*.d.mts` — nineteen `SdkErrorCode` values at `2.4.0`; both of the debrief's interviewers walked them and found today's classification right for stdio.
- `test/proxy.test.ts` has a test for each outcome and none that enumerates the codes.
- Read, not run. Debrief, Technical 4. Four of the codes belong to the `2026-07-28` revision and become reachable if the proxy ever negotiates it with a sandboxed server.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
