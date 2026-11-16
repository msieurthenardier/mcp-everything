# Leg: refresh-mcp-and-docs

**Status**: completed
**Flight**: [MCP Env Passthrough](../flight.md)

## Objective
A new meta tool `refresh_mcp(project)` stops a project's MCP servers and reruns discovery, reporting what started and what did not, and the warnings, tool descriptions and README tell operators and agents how to give a server its environment and which way is safe.

## Context
- The flight spec's design decisions are the source of truth; this leg implements DD5 (`refresh_mcp`), the wording part of DD6, the test that documents DD7's limit, DD9 (README) and the second Docker case of DD10. Read those in [flight.md](../flight.md) before starting. Where this leg and the spec seem to differ, stop and report; do not pick one.
- Leg 01 landed (flight log, Leg Progress). What it left for this leg to build on:
  - `src/proxy/host-env.ts`: `ownedVariables`, `hostVariableNames` (never throws), `launchVariables` (throws a plain `Error` naming the prefixed variable when a value has a line break or NUL).
  - `Installer.launchSpec(project, server)` and `Installer.hostVariableNames(project)`; `Installer` takes the environment as its sixth constructor parameter; `AppOptions.env`.
  - `App.describe` prints a project-level line with the names a project receives and marks an overridden stored name.
  - Tests: `test/host-env.test.ts`, and new blocks in `test/server.test.ts` ("host environment variables for proxied MCP servers"), `test/installer.test.ts`, `test/proxy.test.ts`; one Docker case, "gives a proxied MCP server the host environment's value, which is never stored or run elsewhere".
  - Leg 01 chose the error and `describe` wording itself; this leg may reword them if the docs read better for it, updating leg 01's tests to match.
- One clarification of DD5, made at leg design and recorded in the flight log: "no proxied tool is published afterwards" is counted on the project's catalog (`tools` with `kind: "mcp"`), not on the published subset. A large server's tools can be in the catalog and callable while none is published individually, and that is not a failed refresh.
- A slug can contain `__` and tools of such a project cannot be called by name ([squawk 0008](../../../squawks/0008-tools-of-slugs-containing-double-underscore.md)); not this leg's to fix.

## Inputs
- Branch `sortie/03-mcp-env-passthrough` with leg 01's changes uncommitted in the working tree. Nothing is committed until the whole flight is reviewed.
- `npm test`: 319 passed, 15 skipped, about 1.5 s. `npm run typecheck`: clean. `npm run test:docker`: 13 passed, 2 skipped, 143 s.

## Outputs
- `refresh_mcp` in `META_TOOLS`, handled in `App.callMeta`, backed by a new method on `Installer` that returns the record and a structured outcome.
- Reworded discovery warnings, server instructions and `connect_mcp_server` descriptions.
- README: tools table, the section on projects that are MCP servers, the security model, the configuration table.
- Unit tests, one test that documents DD7's limit, and a second Docker case.
- A flight log entry.

## Acceptance Criteria

The tool (DD5):
- [x] `refresh_mcp` is listed among the built-in tools with one required argument, `project` (slug or id, like the other meta tools), and no others.
- [x] It is refused when an install job for the project is running in this process (the message says it is still installing; this check comes first), when the project's status is `installing` with no such job (the message gives the advice `project_info` gives: reinstall if the install does not finish), and when its status is `failed` (the message points to `discover_tools` and `install_project`). A refused call leaves `FakeDocker.calls`, `FakeUpstream.launches` and `proxy.size` exactly as they were.
- [x] An unusable value in one of the project's variables fails the call before anything is stopped: the project's open sessions are still open afterwards, and the message names the prefixed variable and not the value.
- [x] On a `ready` project it makes sure the sandbox is running, stops every MCP server session of the project, reruns the discovery `discover_tools` runs (with no extra executables), stores the result and sends the tool-list-changed notification. A server that had an open session before the call is launched again by it.
- [x] The method on `Installer` returns, beside the record: the registered servers that did not start, each with a reason; the candidate launches that did not answer; and the server names before and after. `discover_tools`, `connect_mcp_server`, `disconnect_mcp_server` and install behave as before.
- [x] The result's first line gives the number of MCP servers recorded for the project, how many of them have no tool in the catalog, and the number of proxied tools in the catalog. The result also names the variables applied (names only), or says that none is set for the project; lists each registered server that did not start with its reason; lists each server that was recorded before and is gone (compared by name); lists candidates that did not answer; says when the sandbox is offline, as `connect_mcp_server` does; and ends with the project description.
- [x] It is flagged as an error (`isError: true`) in exactly these cases: a registered server did not start; a server recorded before the call is not recorded after it; the catalog holds no proxied tool afterwards. A candidate that did not answer is reported and does not by itself make it an error.
- [x] Each condition has a test in which it is the only one that holds: a registered server fails while another server of the project publishes tools; a detected server is gone while another server publishes tools; no proxied tool at all, with nothing failed and nothing gone. And one test where a candidate did not answer while another server publishes tools: not an error, the candidate is listed.
- [x] The charter's second criterion, in the unit suite: a detected candidate that answers only when a variable is present. Installed without it: no MCP server, no proxied tool, and a warning. Then a second `App` on the same data directory, constructed with the variable in its environment, calls `refresh_mcp`: not an error, the server is recorded as detected with a stored `env` of `{}`, its tools are in the catalog and listed, the result contains the variable's name and not its value.
- [x] The reverse, on a project that also has a server which answers without the variable: an `App` without the variable calls `refresh_mcp` afterwards; the server that needs the variable is listed as gone and the call is flagged as an error, although proxied tools remain.

Warnings and descriptions (DD6, DD9):
- [x] The warning for candidates that did not answer (`Installer.discoverMcp`) names the route for environment variables: set `{slug}__NAME`, with the project's actual slug, in the environment of mcp-everything, reconnect it, and call `refresh_mcp`. It still names `connect_mcp_server` for other arguments, and still starts with the text the existing test "reports the launches it tried when none answers" matches.
- [x] The warning for a registered server that did not start carries the same route hint.
- [x] One rule for both warnings: when the reason is the unusable-value error, no route hint is added. That message already says what to fix, and the warnings for it stay as leg 01 left them.
- [x] The server instructions tell an agent that a server needing environment variables such as API keys gets them from `<slug>__<NAME>` variables in mcp-everything's own environment, followed by a reconnect and `refresh_mcp`, and not to ask the user to paste secrets into the conversation.
- [x] The description of `connect_mcp_server` and of its `env` argument say that values passed there are in the conversation and stored unencrypted, that `<slug>__<NAME>` variables are the preferred way, and that secrets belong in `env` only where the agent system injects them outside the conversation. `connect_mcp_server` behaves as before.
- [x] No message, warning or description written in this leg contains a variable's value; tests that exercise them use a value that could not occur by accident and assert its absence next to an assertion that the launch carried it.

Nothing written by mcp-everything, second-leg part:
- [x] Leg 01's test "nothing mcp-everything writes contains the value: registry, tool results and log lines" (or a sibling beside it) also covers `refresh_mcp`: after a refresh that launched with the value, the bytes of `registry.json`, the tool result and every log line do not contain it.

The documented limit (DD7):
- [x] Two tests, each named so that it reads as a documented limit and not a requirement. A server that prints its variable's value on stderr and fails to start: the value is in the tool error returned for a proxied call and in the line passed to `log`, and is **not** in `registry.json` after a discovery. A server that puts its variable's value in a protocol error message during the handshake: after a discovery the value **is** in `registry.json` (in a warning), as well as in the tool error and the log line.

README (DD9):
- [x] The built-in tools table has a row for `refresh_mcp`. The configuration table has a row for `<slug>__<NAME>`.
- [x] The section on projects that are MCP servers has a part on giving a server its environment, presenting two routes.
- [x] Route 1 is presented as the default: `<slug>__<NAME>` in mcp-everything's own configuration, with a client configuration example, then reconnect, then `refresh_mcp`. It says: the agent never sees the values and nothing is stored; a server already published picks up a changed value at its next start after a reconnect, and `refresh_mcp` is needed when a server could not start or lists different tools; the prefix is the slug exactly as `list_projects` shows it, in lower case; an empty value counts as set; the variables go to every MCP server of the project and not to its command line tools; a value from the configuration wins over one stored by `connect_mcp_server`; values with line breaks are rejected.
- [x] Route 2 is `connect_mcp_server(env: …)`. The README says that a value an agent passes in a tool call is in the conversation transcript and stored in plain text in the registry, calls that generally unsafe, and gives the one exception: an agentic system with proper secrets management that injects the value at run time outside the agent's session. The existing example that passes `API_KEY` through `connect_mcp_server` sits under this route, not above it as the normal way.
- [x] The security model no longer says that no credential is passed into a sandbox; it says which variables are, and that mcp-everything itself never stores them.
- [x] The security model states each of these limits: any code in the project's sandbox can read a running server's variables; the variables are in the environment of the Docker client on the host; discovery and `refresh_mcp` run the project's commands with them, online whenever the sandbox's network is on; the variables bind to a slug, so a different repository later installed under the same slug receives them; a server can print its own variables, which then reach tool errors and the diagnostics log, and the registry if it puts them in a protocol error or a tool description; mcp-everything processes that share a data directory should be given the same variables, because one without them drops the tools of servers that need them when it rediscovers.
- [x] Nothing else in the README contradicts the above. In particular the existing security bullet that server environment values are stored in plain text reads as being about `connect_mcp_server`, and its claim that values "are never echoed back by any tool" is corrected to what DD7 says: never by mcp-everything itself.

Docker (one new case in the first `describe` block of `test/integration/docker.test.ts`, after leg 01's case and before "uninstall removes the container and the volume"):
- [x] An executable shell script that speaks MCP only when a variable is set, placed where discovery finds built commands and declared by a `.mcp.json` in the checkout. Through an `App` without the variable, `discover_tools` leaves no MCP server, a warning that names the route, and a command line tool for the script.
- [x] Through a second `App` on the same data directory with the variable injected, `refresh_mcp` is not an error; the server's tool is in the catalog and reports the variable's value when called; the script's command line tool is gone; `registry.json` does not contain the value.
- [x] The case prints how long the refresh took. It removes what it placed and restores the catalog, also when an assertion fails; after it the project's tools are what they were before it. The existing cases, leg 01's included, are not edited. It adds at most 15 s to `npm run test:docker`.

Suites:
- [x] `npm test` passes. No test that existed before this flight is edited or removed (an added import line in an existing test file is allowed and is listed); a test added by leg 01 is changed only where this leg reworded a message or extended it, and each such change is listed in the flight log.
- [x] No new unit test waits out a handshake or probe timeout: each new test takes under 300 ms, and the unit suite's duration before and after is recorded against a budget of 0.5 s added.
- [x] `npm run typecheck` is clean.
- [x] `npm run test:docker` passes: 14 cases, the 2 pressure cases still skipped.

## Verification Steps
- Tool criteria: named tests through `App.callTool("refresh_mcp", …)`; `npm test`.
- "Nothing stopped and nothing launched" on a refusal: the number of launches in `FakeUpstream.launches`, `app.proxy.size`, and the kill commands in `FakeDocker.calls` are unchanged by the refused call.
- "Launched again": the same launch spec appears once more in `FakeUpstream.launches` after the refresh, and a kill for the earlier session's PID file was issued.
- Warnings and descriptions: assertions on the stored warnings, on `app.listTools()` and on the instructions the server gives a client (the existing test "serves the tool list, executes calls and announces list changes" shows how to read them).
- README criteria: read the changed sections against the criteria one by one, and list in the flight log, per criterion, the heading under which it is met.
- Docker criteria: `npm run test:docker` once, verbose reporter. Record the new case's duration, the refresh duration it printed, and the suite total. Do **not** run `npm run test:docker:pressure`.
- Controls: break the error flag (make a gone server not count) and confirm the "gone only" test and the "reverse" test fail; break the refusal for `installing` and confirm its test fails. Restore by re-applying the text; record checksums before and after.
- Per-test durations: the verbose reporter's timings for the new tests.

## Implementation Guidance

1. **Give discovery a structured outcome**
   - `Installer.discoverMcp` already knows everything the outcome needs: registered servers whose `listTools` threw (today only a warning string), candidates that did not answer (`unanswered`) and their `reason`. Return them alongside `servers`, `lists` and `bare`, and let `discover` hand them back to its caller. The warnings stay as the stored record of the same facts.
   - Do not parse warning strings to rebuild this.

2. **`Installer`: the refresh method, beside `rediscover`**
   - In order: resolve the project's variables (`launchVariables` throws on an unusable value; nothing has been stopped yet), `requireSandbox`, `proxy.closeProject`, `discover(record, [])`, `finish`. Capture the server names before discovery from the incoming record and after from the result.
   - `rediscover` (behind `discover_tools`) is not changed.

3. **`App`: the meta tool**
   - Add the `META_TOOLS` entry and the `callMeta` case. Refuse before calling `Installer`: status `installing`, status `failed`, or `this.jobs.has(project.repo.id.toLowerCase())`. These are `ToolInputError`s.
   - Build the result from the outcome and `this.describe(updated, true)`; set `isError` by the three conditions. Count proxied tools on `updated.tools`, not on the published subset.
   - The variable names come from `Installer.hostVariableNames`.
   - Send the tool-list-changed notification as the neighbouring cases do.

4. **Warnings**
   - Candidates: extend the existing sentence in `discoverMcp`; the slug is `record.slug`. Keep the prefix "this project looks like an MCP server, but none of these completed an MCP handshake:" and the mention of `connect_mcp_server`.
   - Registered servers: append the route hint to `brief(e)`, except for the unusable-value error. A small dedicated error class thrown by `launchVariables` is the cleanest way to tell it apart; leg 01's tests for that error should keep passing unchanged.
   - `brief` cuts to one line and 240 characters; append the hint after the cut, not before.

5. **Instructions and descriptions**
   - `INSTRUCTIONS` and the `connect_mcp_server` entry in `src/server.ts`. Keep them short; an agent reads them on every session.
   - Check `test/` for anything that pins the old wording before changing it.

6. **Tests**
   - The detection tests need a sandbox scripted for discovery. `test/installer.test.ts` has one (`ScriptedDocker`) with an `install()` helper and the "MCP server detection" setup; build an `App` there with `docker: <that sandbox>`, a `McpProxy` on the fake upstream, and `env`, or drive `Installer` directly for the outcome and `App` for the result. Do not move or change `ScriptedDocker`.
   - "A second `App` on the same data directory" stands in for a reconnect: same `MCPE_DATA_DIR`, new `App`, different `env`.
   - **Do not let a launch hang.** The stock `fakeUpstream` starts no server for a launch it does not answer, so the client waits: 15 s for a candidate probe (`MCP_PROBE_SEC`), at least 1 s elsewhere (`MCPE_MCP_STARTUP_TIMEOUT` is a whole number of seconds). `up.answerIf` alone therefore stalls any test in which a launch goes unanswered. Wrap the connector instead, so that a launch which should not answer fails at once: delegate to `up.connector` when the launch should answer, and otherwise return a connection whose transport is already dead (for example an `InMemoryTransport` pair whose other side has been closed, so that `send` throws). Do not throw from the connector itself where stderr matters: `McpProxy.attempt` calls the connector outside its `try`, and nothing would be collected. The existing test "reports the launches it tried when none answers" shows the throwing form, which is fine where only the failure is needed.
   - An `App` built in `test/installer.test.ts` needs an `import { App }` line there; add it and list it in the flight log. Every extra `App` is shut down at the end of its test.
   - "Gone" can be produced without a scripted sandbox: in `test/server.test.ts`, seed a record whose `mcpServers` holds a `detected` server; the stock `FakeDocker` finds no candidates, so a refresh drops it. Leg 01's `seeded` and `appWith` helpers are local to its `describe`; put the new tests inside it or beside it with their own helpers.
   - For the DD7 tests the stock fake upstream is not enough: its stderr is a fixed string and it never fails the handshake with a message. Write a small connector in the test.
     - stderr: a connection whose transport fails at once and whose `stderr()` returns text containing the value from `launch.server.env`.
     - protocol error: a server side that answers `initialize` with `{ jsonrpc, id, error: { code, message } }`, the message containing the value near its start; call `start()` on that side so queued messages are delivered. The stored warning keeps only the first line of the error, cut at 240 characters.
     - Both need a proxied tool to call: seed the record with a stored server and a `kind: "mcp"` tool, as leg 01's tests do, since a server that never starts publishes none.
   - New tests pass an explicit environment object; never set or read `process.env`.

7. **Docker case**
   - The recipe was measured once at planning (flight log, "Discovery spike") with a flag file where the variable now goes. Keep its shape: the script exits at once when given any argument and exits with an error at once without the variable; `.mcp.json` declares it as a bare command name; the script is its own constant.
   - The block's `app` reads the real process environment. Give the variable a name nobody has set by accident.
   - Place the files with `sandbox_exec` through the block's `app`. Clean up in a `finally`, in this order: shut the second `App` down (its server session ends before its files go), remove the two files through `app`, run `discover_tools` through `app`, then assert the project's tools are `["gron__gron"]`, the state the cases before it end in.
   - Print the refresh duration in the way the pressure cases print theirs (`console.log` of one line).

8. **README, last**
   - Write it against the behavior as implemented, then check each README criterion.
   - The client configuration example near the top of the README shows where `env` goes; the new example follows its shape, with a project slug and a placeholder value.

9. **Flight log**: changes made, verification per criterion group, the two controls, suite counts and durations, deviations.

Rules for this leg: do not commit; do not kill processes by pattern (`pkill`, `killall`), and remove test containers only by exact name; do not write machine usernames or absolute home paths into code, tests, the README or artifacts; restore deliberate breaks by re-applying text, never with `git checkout`, `git stash`, `git restore` or `git clean`.

## Edge Cases
- **A project with no MCP server and none found**: the refresh runs, the result says no proxied tool is in the catalog and is flagged as an error. It is the caller's signal that this project has nothing to refresh.
- **A registered server that fails**: it stays recorded with no tools (existing behavior); the refresh reports it and is flagged.
- **A sandbox that idle-stopped**: `requireSandbox` starts it; the refresh proceeds.
- **A sandbox that no longer exists**: `requireSandbox` throws its existing message; nothing is stopped.
- **A proxied call in flight when the refresh starts**: its session is closed under it and the call fails, as it does today when `connect_mcp_server` runs. Not handled further.
- **A reinstall started while a refresh runs**: not handled; the race `discover_tools` has today (flight spec DD5). Do not add locking.
- **Detected server names**: a detected server keeps its name across discoveries as long as the same candidate answers, so "gone" compares names. A server renamed by a changed manifest shows as one gone and one new; acceptable.
- **The oversized-server case**: tools in the catalog but none published individually; counted as proxied tools, not an error.

## Files Affected
- `src/install/installer.ts` - structured outcome from discovery, the refresh method, warning wording
- `src/server.ts` - `META_TOOLS`, `callMeta`, `INSTRUCTIONS`, `connect_mcp_server` descriptions
- `src/proxy/host-env.ts` - possibly a dedicated error class
- `README.md` - tools table, MCP servers section, security model, configuration table
- `test/server.test.ts`, `test/installer.test.ts` - added tests; leg 01 tests adjusted only for reworded messages
- `test/integration/docker.test.ts` - one added case
- `sorties/03-mcp-env-passthrough/flight-log.md` - leg entry

## Citation Audit
Checked against the working tree on 2026-11-15 (leg 01 landed, uncommitted):
- `src/install/installer.ts` — `rediscover`: `await this.requireSandbox(project); … await this.discover(record, extraCommands); return this.finish(record);`. `discoverMcp`: registered loop `record.warnings.push(`${MCP_WARNING}${brief(e)}`)`; candidates `failed.push(candidate.argv.join(" ")); reason ||= brief(e);` and the warning beginning "this project looks like an MCP server, but none of these completed an MCP handshake:" and ending "register it with connect_mcp_server."; `brief` takes `split("\n")[0]!.slice(0, 240)`. `launchSpec` and `hostVariableNames` are public methods. `private async discover(record, extraCommands): Promise<void>`.
- `src/server.ts` — `META_TOOLS` entries `discover_tools`, `connect_mcp_server` (description ends "Environment values are stored unencrypted in the local registry file."; `env` described as "Environment variables for the server, e.g. API keys."), `disconnect_mcp_server`. `INSTRUCTIONS` line: "if one needs arguments or environment variables to start, register it with connect_mcp_server." `callMeta` case `discover_tools` guards with `this.jobs.has(project.repo.id.toLowerCase())`. `project_info` appends "This install was started by another session or was interrupted; reinstall if it does not finish."
- `src/proxy/host-env.ts` — `launchVariables` throws `new Error(`Environment variable ${v.full} contains a line break or NUL character and cannot be passed to the MCP server.`)`.
- `test/installer.test.ts` — `class ScriptedDocker extends FakeDocker`; `describe("MCP server detection", …)`; `it("reports the launches it tried when none answers", …)` asserts the warning contains "none of these completed an MCP handshake: `tool mcp`, `tool`" and "connect_mcp_server".
- `test/server.test.ts` — leg 01's `it("leaves a registered server recorded with no tools and an MCP warning, in discovery", …)` asserts the warning equals `MCP: ` plus the unusable-value message exactly; `it("nothing mcp-everything writes contains the value: registry, tool results and log lines", …)`; `it("serves the tool list, executes calls and announces list changes", …)` reads `client.getInstructions()`.
- `test/integration/docker.test.ts` — leg 01's case `it("gives a proxied MCP server the host environment's value, which is never stored or run elsewhere", …)` precedes `it("uninstall removes the container and the volume", …)`.
- `README.md` — headings "Built-in tools", "Projects that are MCP servers", "Security model", "Configuration"; the security bullet "No host directory, Docker socket, or credential is mounted or passed in."; the example `connect_mcp_server(project: "some-api-server", … env: { "API_KEY": "..." })`.
- No test in `test/` pins the full list of built-in tool names or the old `connect_mcp_server` description text (searched).

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
