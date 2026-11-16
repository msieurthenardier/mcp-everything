# Squawk 0014: The README says the agent never sees variable values, and it can

**Status**: completed
**Type**: servicing
**Severity**: grounding
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The README's how-to for `<slug>__<NAME>` variables says "The agent never sees the values". That is false. The agent has `sandbox_exec`, `sandbox_write_file` and `connect_mcp_server` on the same project, and each gives it the values: by reading a running server's environment, by replacing the code a server runs, or by registering a command of its own whose stderr comes back in the error. Operators set real API keys on the strength of this line. Finding 1a of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md), rated Critical.

Documentation only. Replace the claim with what is true today, and say in the same place that a variable should not be set for a project the agent is not trusted with. The operator's decision (2026-11-16) is that the agent is trusted with a project's variables and the README must say so; whether to build a real boundary is left to a later design sortie (finding 1b). The limitations section further down already says that any code in the sandbox can read the values; it does not name the agent. No code changes.

## Evidence
- `README.md:235` — "The agent never sees the values, and nothing is stored: the variables are read from mcp-everything's environment each time a server is started." ("nothing is stored" is true.)
- `README.md`, limitations, "Variables given to a project's MCP servers are exposed to more than those servers" — names code in the sandbox and the Docker client, not the agent's own tools.
- `src/server.ts:App.callMeta`, case `connect_mcp_server` — accepts any argv whose first element has no whitespace or NUL; `src/install/installer.ts:Installer.launchSpec` adds every `{slug}__*` value to every launch; `src/proxy/mcp-proxy.ts` puts `stderr.slice(-1500)` of a failed launch into the error returned to the caller. Read by two reviewers, not run end to end.
- Run on 2026-11-15, throwaway container with the product's flags (`--network none`, cap-drop ALL plus the six capabilities, `no-new-privileges`, `--init`; image `alpine/git:latest`): a process started with `docker exec -d --env-file`, as the connector does, had its `/proc/<pid>/environ` read by a second plain `docker exec`, as `sandbox_exec` does. Dummy value only.

## Corrective Action
README.md only. The `<slug>__<NAME>` bullet no longer says the agent never sees the values. It keeps "nothing is stored" and that mcp-everything writes no value into a result, error or log, then says plainly that this is not protection from the agent: every MCP server of the project and anything with `sandbox_exec`, `sandbox_write_file` or `connect_mcp_server` on it can read the values, the agent is trusted with a project's variables, and a variable should not be set for a project it is not trusted with. The limitations bullet on exposure now names the agent's three tools. Chosen over a code change because the operator decided the agent is trusted; a real boundary is left to a design sortie (finding 1b). `src/server.ts` tool descriptions and `INSTRUCTIONS` contain no statement that the agent cannot see values, so they are unchanged.

## Verification
Searched README.md and src/*.ts for "never see", "cannot see" and similar: no remaining statement that the agent cannot see values; the tool descriptions and INSTRUCTIONS only say values are never shown in output and that secrets should not be pasted into the conversation, both true. `npx vitest run --testTimeout 20000`: 340 passed, 16 skipped. `npm run typecheck`: clean. No test pins the changed text.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed; the Reviewer checked the new text against the code and found no remaining statement that the agent cannot see values
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
