# Squawk 0033: A connector that throws after writing its env file leaves the file behind

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
When a proxied MCP server has an environment, `dockerConnector` writes the values to a private file and returns a `cleanup` that removes it. `McpProxy.attempt` calls the connector **outside** its `try`, so if the connector throws after the file is written (a partial write on a full disk; the transport's constructor throwing), `cleanup` is never reached and the file, which holds values, stays in `<dataDir>/tmp`. Found by the design review of flight 03's first leg (mission 01), which was not chartered to change the connector; that leg's startup sweep removes such a file once it is an hour old, so this is about not leaving it in the first place.

Remove the file when anything after the write throws, inside `dockerConnector`. The file's directory is mode 0700 and the file 0600, so exposure meanwhile is local to the operator's account; no path to this throw is known to have happened.

## Evidence
- `src/proxy/mcp-proxy.ts`, `dockerConnector` — `fs.writeFileSync(envFile, lines.join(""), { mode: 0o600 });`, then `args.push(…)` and `new StdioClientTransport(…)`, with no `try` around what follows the write.
- `src/proxy/mcp-proxy.ts`, `McpProxy.attempt` — `const conn = this.connector(launch);` precedes the `try { … } finally { conn.cleanup?.(); }`.
- Read, not run. `test/proxy.test.ts`, "propagates a connector that throws, without asking for the state", covers a connector that throws; none covers one that throws after writing.

## Corrective Action
`dockerConnector` (`src/proxy/mcp-proxy.ts`) now wraps everything from the env-file write to building the transport in a `try`. On a throw it removes the env file (`fs.rmSync(..., { force: true })`, itself in a `try` so a removal failure never masks the original error) and rethrows. The file name is assigned before `writeFileSync`, so a write that fails part-way (file created, then ENOSPC) is removed too. The connector interface and `McpProxy.attempt` are unchanged.

## Verification
Two cases added to `describe("dockerConnector")` in `test/proxy.test.ts`: (1) `argv` made non-iterable, so the `...server.argv` spread after the write throws a TypeError; asserts it propagates and `<dataDir>/tmp` is empty; (2) `fs.writeFileSync` spied to write a partial file then throw ENOSPC; asserts the error propagates and the tmp dir is empty. Neither depends on running as root. With the cleanup call disabled, both fail; restored, both pass. `npm run typecheck` clean; `npm test`: 933 passed, 24 skipped.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: both triggers judged realistic; removing the removal failed both cases, and assigning the file's path after the write failed the partial-write case only.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
