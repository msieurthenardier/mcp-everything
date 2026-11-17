# Squawk 0043: A proxied server that does not advertise tools puts a library line on stdout, and is not asked for its tools

**Status**: open
**Type**: defect
**Severity**: grounding
**Reported**: 2026-11-17
**Completed**: —

## Report
Since the move to the v2 SDK packages (sortie 05, released as `v0.5.0`), listing the tools of a sandboxed MCP server whose `initialize` answer has no `tools` capability does two things it did not do before. The client library writes a plain text line to stdout, which in this process carries the MCP protocol, so mcp-everything's own client receives a line that is not JSON. And the server is not asked for its tools at all: the library returns an empty list. With the v1 SDK the request was always sent and nothing was written.

It is reached through `McpProxy.listTools`, so at install, `discover_tools`, `connect_mcp_server` and `refresh_mcp` of a project whose server omits the capability. How a given client reacts to the stray line is not known.

Two things to restore. Nothing but protocol messages reaches stdout, whichever dependency wants to print: send `console.debug`, `console.log` and `console.info` to stderr at the entry, before anything else runs. And a server that does not advertise the capability is asked for its tools anyway, as before (the library's `listTools` returns early, so the request has to be made another way). One test with an upstream that answers `initialize` with empty capabilities: it is asked, its tools are listed, and nothing was written to stdout.

Grounding: found at the sortie's debrief, after the tag.

## Evidence
- `src/proxy/mcp-proxy.ts`, `McpProxy.listTools` — `await session.client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 })`.
- `node_modules/@modelcontextprotocol/client/dist/public-*.mjs`, `async listTools` — `if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) { console.debug("Client.listTools() called but server does not advertise tools capability - returning empty list"); return { tools: [] }; }`.
- Run on 2026-11-17 with the installed packages (`2.4.0`): a raw in-memory upstream answering `initialize` with `capabilities: {}`; `client.listTools()` returned `{"tools":[]}` and that sentence was on stdout, not stderr.
- v1 `1.32.2` (the published tarball, read): `listTools` is `this.request({ method: 'tools/list', params }, ListToolsResultSchema, options)` and writes nothing.
- `grep -rn "console\." src` finds no guard on stdout. No test uses an upstream without the capability.
- Found by the Architect at the debrief: `sorties/05-serve-the-2026-07-28-protocol/flight-debrief.md`, Technical 1.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
