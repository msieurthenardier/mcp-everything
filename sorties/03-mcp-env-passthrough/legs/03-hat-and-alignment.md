# Leg: hat-and-alignment

**Status**: completed
**Flight**: [MCP Env Passthrough](../flight.md)

## Objective
The operator sees the feature work in their own MCP client, with a real reconnect: a variable set in the client configuration reaches an installed project's MCP server, and `refresh_mcp` publishes that server's tools.

## Context
- Interactive leg. The operator performs each step and reports what they see; the Flight Director guides one step at a time and does not run the steps for them. No Developer or Reviewer is spawned unless a step fails and a fix is needed.
- Both implementation legs are completed and committed (`3d52778`); draft pull request #4 is open.
- This is the one thing the automated tests do not show: a real client restarting mcp-everything with new configuration (flight spec, Verification).
- A fix that changes look or wording is made inline through a Developer. A request that adds behavior is a feature and goes through a scoped design review first; the Flight Director says out loud which it is.

## Inputs
- The operator's client starts mcp-everything from this checkout's build (`node dist/index.js`, local-scope configuration). The build was made from the sortie branch on 2026-11-15 after the commit; the client picks it up when it reconnects.
- The operator's registry holds `gron` and `rea`. Neither has a server known to need a variable, so step 1 chooses the project.

## Outputs
- Each step's result recorded in the flight log, with the operator's observations.
- Any fix made along the way, reviewed and committed.

## Acceptance Criteria
- [x] After a reconnect, the client lists `refresh_mcp` among mcp-everything's tools.
- [x] A project and a variable are chosen, and the variable is in the client's configuration for mcp-everything as `{slug}__{NAME}`.
- [x] After a reconnect, `project_info` for the project shows the variable's name on the line about `{slug}__…` variables and does not show its value.
- [x] `refresh_mcp` for the project reports the variable's name, is not flagged as an error, and the server's tools are in the client's tool list.
- [x] A proxied tool of that server, called from the client, behaves as it does when it has the variable.
- [x] The value is not in the registry file: a search for it there finds nothing. The operator runs the search, so the value stays out of the conversation.
- [x] With the variable removed from the configuration and the client reconnected, `refresh_mcp` reports the server as gone or as not started and is flagged as an error. *(The state the operator would not otherwise look at.)*
- [x] The operator states whether the wording of the `refresh_mcp` result, the `project_info` line and the README section reads right to them, and anything they want changed is either fixed or recorded.

## Verification Steps
One step per criterion, in order, each performed by the operator and reported back. A step that fails is diagnosed and fixed, then repeated, before the next one starts.

## Implementation Guidance
1. Reconnect mcp-everything in the client and check the tool list.
2. Choose the project. Either a real MCP server project that needs a variable (installed for the session), or a stand-in on the existing `gron` sandbox built the way the Docker case builds one. A real project shows more; the stand-in is quicker and needs no account anywhere. Use a value that is not a real secret unless the chosen server needs one.
3. The operator edits the client configuration themselves and reconnects.
4. Walk the remaining criteria in order.

## Edge Cases
- **The chosen server also needs the network**: the refresh result says when the sandbox is offline; turn the network on with `set_project_network` and refresh again.
- **The slug is not what was expected**: the prefix is the slug exactly as `list_projects` shows it.
- **The client does not refresh its tool list**: the tools are still callable through `call_project_tool`.

## Files Affected
- `sorties/03-mcp-env-passthrough/flight-log.md` - HAT entry
- Source files only if a step leads to a fix.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
