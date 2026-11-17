# Squawk 0043: A proxied server that does not advertise tools puts a library line on stdout, and is not asked for its tools

**Status**: completed
**Type**: defect
**Severity**: grounding
**Reported**: 2026-11-17
**Completed**: 2026-11-17

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
- `src/entry.ts`: new `guardStdout()` sends `console.debug`, `console.log` and `console.info` to `console.error` (stderr). `runEntry` calls it as its first statement, before `w.serve()` and before any `await`; `EntryWiring` gained one optional field, `console` (default: the real console), which `runEntry` passes to `guardStdout` so a test can observe it. First pass: `src/index.ts` called it at the top of the module body. The review found that call covered by no test (deleting the line left the suite green; `src/index.ts` runs on import), so the call was moved into the tested function and removed from `src/index.ts` (with its import): there is exactly one call. Reading of `main()`: between the top of the module and `runEntry`, `main()` runs `loadConfig()`, `prepareDataDir()`, `new App(...)` and `app.start()`; none of them calls a console method or writes to stdout (`grep -rn "console\.\|process.stdout" src` finds nothing in them; the only hit outside `entry.ts` is a `console.log` inside a script string run in the sandbox, in `src/install/recipes.ts`; the app's `log` is `process.stderr.write`). So nothing is lost by guarding at the start of `runEntry` instead of at module load.
- `src/proxy/mcp-proxy.ts`: `McpProxy.listTools` now calls `session.client.request({ method: "tools/list", params: cursor ? { cursor } : undefined }, { timeout: 30_000 })` instead of `client.listTools(...)`. In v2 `request` resolves the result schema from the method name, validates the answer, and does not consult the `tools` capability (unless strict enforcement is on, which the proxy does not set), so the server is asked as it was with v1. The loop, its bounds (10 pages, 500 tools), the error handling and the shape of the returned tools are unchanged.
- Why this and not another: the library's `listTools` is the only place that returns early, so stepping below it is the smallest change; guarding stdout at the entry covers any other dependency that prints, not just this line. No shared interface or schema was touched.
- Tests: `test/proxy.test.ts` (`rawUpstream` gained an optional `capabilities` argument, default unchanged; new test for an upstream with empty capabilities), `test/entry.test.ts` (`guardStdout`; and `runEntry guards stdout before serving`, where the serving double calls `console.debug`, `console.log` and `console.info` at the moment `serve` is called). The existing entry tests pass a copy of the console through the new field so the guard does not replace methods on the real console.

## Verification
- `npm run typecheck`: clean. `timeout 120 npm test`, at the end of this squawk's first pass: 892 passed, 24 skipped (was 890 / 24; +2 new). The batch's final count is in the last bullet. `npm run build`: clean. The existing test "closes the session when a tools/list answer is malformed" passes unchanged (`request` validates the result).
- Mutation 1: put `client.listTools(...)` back in `McpProxy.listTools`: the new proxy test failed (`expected [] to deeply equal [ { name: 't1', ... } ]`). Undone.
- Mutation 2: removed the `console.info` redirection from `guardStdout`: the guard test failed (`['via debug','via log']` instead of all three). Undone.
- Note on the tests: vitest replaces `console`, so the guard test asserts the redirect target (`console.error` receives the three messages) and that `process.stdout.write` is untouched; the proxy test spies on `process.stdout.write` and `console.debug`.
- Review round: new test asserts that, at the moment `serve` is called, the three console methods reach `console.error` and `process.stdout.write` is not called. Mutation 3: removed the `guardStdout(...)` call from `runEntry`: the new test failed (stderr calls did not equal the three messages); put back by editing, 22 entry tests pass. `timeout 120 npm test`: 916 passed, 24 skipped.
- Real pipe: with `MCPE_DATA_DIR` a fresh `mktemp -d` directory, one `initialize` request piped into `node dist/index.js` (stderr discarded) gave one stdout line, and it parsed as JSON.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it searched the built files of the three `@modelcontextprotocol` packages for every use of `console` and `process.stdout` (five calls bound for stdout, all covered by the guard; none captured at load; nothing written at import), drove the built `McpProxy.listTools` against an upstream with no `tools` capability with stdout and stderr captured apart (stdout empty, tools returned), and showed the new proxy test failing with the library call put back. It found the guard's call in `src/index.ts` covered by no test; the call was moved into `runEntry` with a test. A second independent Reviewer (Sonnet) reviewed the fix round alone and confirmed it (916 passed, 24 skipped). It showed that test failing with the call removed and with the call moved after `serve`, read `main()` for anything that could print before the guard (found nothing), and showed the guard live in the built entry (stdout 0 bytes, three probes on stderr).
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048.
