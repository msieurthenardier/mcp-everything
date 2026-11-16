# Squawk 0033: A connector that throws after writing its env file leaves the file behind

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
When a proxied MCP server has an environment, `dockerConnector` writes the values to a private file and returns a `cleanup` that removes it. `McpProxy.attempt` calls the connector **outside** its `try`, so if the connector throws after the file is written (a partial write on a full disk; the transport's constructor throwing), `cleanup` is never reached and the file, which holds values, stays in `<dataDir>/tmp`. Found by the design review of flight 03's first leg (mission 01), which was not chartered to change the connector; that leg's startup sweep removes such a file once it is an hour old, so this is about not leaving it in the first place.

Remove the file when anything after the write throws, inside `dockerConnector`. The file's directory is mode 0700 and the file 0600, so exposure meanwhile is local to the operator's account; no path to this throw is known to have happened.

## Evidence
- `src/proxy/mcp-proxy.ts`, `dockerConnector` — `fs.writeFileSync(envFile, lines.join(""), { mode: 0o600 });`, then `args.push(…)` and `new StdioClientTransport(…)`, with no `try` around what follows the write.
- `src/proxy/mcp-proxy.ts`, `McpProxy.attempt` — `const conn = this.connector(launch);` precedes the `try { … } finally { conn.cleanup?.(); }`.
- Read, not run. `test/proxy.test.ts`, "propagates a connector that throws, without asking for the state", covers a connector that throws; none covers one that throws after writing.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
