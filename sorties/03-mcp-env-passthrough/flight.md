# Sortie: MCP Env Passthrough

**Status**: completed

## Charter

### Outcome
An operator gives a sandboxed MCP server its environment by setting `{slug}__{NAME}` in the environment of the mcp-everything server, and applies it with `refresh_mcp`.

### Why Now
MCP servers that need API keys can only get them through `connect_mcp_server(env: …)` today. That sends the secret through the model conversation and stores it in plain text in `registry.json`. Operators already configure mcp-everything through its environment in their MCP client configuration, which is where secrets for the servers it runs belong.

### Success Criteria
- [x] With `mcp_booking__API_KEY=x` in the environment of the mcp-everything process, an MCP server of the project with slug `mcp_booking` is started with `API_KEY=x` in its environment.
- [x] An MCP server that could not start when its project was installed, for lack of a variable, publishes its tools once the variable is present in the process environment and `refresh_mcp` is called for that project.
- [x] mcp-everything never writes a proxied value on its own account: not to `registry.json`, not in its own tool output, messages or errors, and not in its logs; `project_info` shows names only. Text that a proxied server itself prints or returns is outside this promise and is documented as a limit. *(Reworded by the operator on 2026-11-15 from "Proxied values never appear in `registry.json`, in the output of any tool, or in logs", after design review showed that a server which prints its own key puts it in all three. See DD7.)*
- [x] Variables prefixed for one slug never reach another project's sandbox, and a project with no matching variables behaves exactly as before.

### Constraints
- **Process environment only.** Variables are read from the environment of the running mcp-everything process. A variable added to the client configuration reaches that process when the client restarts or reconnects it; `refresh_mcp` does not read any other source. *(Agreed at the charter gate, 2026-11-15.)*
- **MCP server processes only.** The variables are handed to the proxied MCP server processes of the project. Generated command line tools (`<slug>__<command>`) are not given them. *(Agreed at the charter gate, 2026-11-15.)*
- Only explicitly prefixed variables cross into a sandbox; there is no blanket passthrough of the host environment.
- Values travel by the existing private env-file mechanism, never on a command line.
- `connect_mcp_server` keeps its current behavior, including its stored environment.

---

## Pre-Flight

### Objective
Every launch of a project's proxied MCP server receives, in addition to whatever environment is stored for that server, the variables named `{slug}__{NAME}` in the mcp-everything process environment, as `NAME`. The merge happens at launch and exists only in memory. A new meta tool, `refresh_mcp(project)`, stops the project's MCP servers and reruns discovery, so that a server which could not start without a variable is found and its tools published. `project_info` and the tool descriptions make the route visible, and the README documents both ways of giving a server its environment and which one is safe.

### Open Questions
- [x] How is a variable matched to a project, given that a slug can itself contain `__`? → DD1
- [x] Where does the merge happen, so that values cannot reach the registry? → DD2
- [x] Which launches get the variables? → DD3
- [x] When a name is both stored by `connect_mcp_server` and set in the process environment, which wins? → DD4 (operator: the process environment)
- [x] What does `refresh_mcp` do, and how does it differ from `discover_tools`? → DD5
- [x] What is shown, and where? → DD6
- [x] A slug can be reused by a different repository. → DD8 (operator: accept, make it visible)
- [x] What do the docs say about the two routes? → DD9 (operator's requirement)
- [x] Is the second Docker case feasible? → DD10 (measured)
- [x] A proxied server can print its own environment, and mcp-everything passes on, stores and logs text the server chooses. What does criterion 3 promise then? → DD7 (operator: what mcp-everything writes on its own account; the rest is a documented limit)

### Design Decisions

Statements of fact below are marked **measured** (observed by running something during planning; the flight log has what was run, on what, and how often), **read** (taken from the code at `main`, `5a3fedb`, with the location) or **inferred** (reasoned, not observed).

**DD1 — A variable belongs to the installed project with the longest slug that prefixes its name**
- For slug `mcp_booking`, `mcp_booking__API_KEY` gives `API_KEY`. The match starts from known slugs, is exact and is case-sensitive. Slugs are lower-case (**read**: `sanitizeIdent`, `src/toolgen/naming.ts`), so `MCP_BOOKING__API_KEY` does not match.
- **Measured**: a slug can contain `__` (three inputs to `makeSlug` produced one), so a variable name cannot be split at its first `__`.
- Ownership first, validity second. A variable is owned by the installed project with the longest slug `s` such that the name starts with `s__`. "Installed" means every record in the registry, whatever its status. Only then is the remainder checked against the pattern `validateEnv` enforces (`ENV_NAME`, `src/proxy/mcp-proxy.ts`). If it does not match, the variable goes to nobody. With slugs `a` and `a__b` installed, `a__b__KEY` goes to `a__b` as `KEY`, and `a__b__` goes to nobody; neither reaches `a`.
- **Inferred**: on Windows, where variable names are case-insensitive, Node still enumerates them with the case they were set in, so the exact match behaves the same. Not tested.
- Trade-off: ownership depends on what is installed. While `a__b` is not installed, `a__b__KEY` reaches `a` as `b__KEY`; installing `a__b` later moves it. This is the slug-reuse exposure of DD8 in another shape and is accepted with it.

**DD2 — The merge is done at launch, by one owner, and the stored spec is never touched**
- A pure function computes a project's variables from an environment object and the installed slugs. One method on `Installer` turns a stored `McpServerSpec` into the spec to launch by copying it with the merged environment. All four call sites that reach `McpProxy.listTools` or `McpProxy.callTool` use that method: `App.callGenerated` (`src/server.ts`), `Installer.connectMcp`, and both calls in `Installer.discoverMcp` (`src/install/installer.ts`). (**Read**, and confirmed by the Architect: those are the only four.) What is written to the registry is always the stored spec.
- The environment object is injected, defaulting to `process.env`, the same way `loadConfig` takes its environment. It is read at each launch, not copied at start. `Installer`'s fifth constructor parameter is already taken by a test seam (`choose`), so the environment is added after it or through an options object; existing call sites stay valid. New tests always inject an explicit object.
- A value that an env file cannot carry is rejected through `validateEnv` (**read**: it rejects carriage returns, line feeds and NUL, and names that are not identifiers). The message names the variable and never the value. A tool call fails with that message; discovery records it as the reason a server did not start; `refresh_mcp` checks before it stops anything.
- **Measured**, one run: values pass through `docker exec --env-file` exactly as written, including leading and trailing spaces, `=`, `#`, quotes, `$` and backslashes; an empty value arrives set and empty; a lower-case name containing `__` is accepted.
- **The session cache's contract.** `McpProxy` keeps one session per launch spec. Source of truth: the launch spec, merged values included, hashed into the key (**read**: `McpProxy.key`; the key is held in memory only). A session is replaced when the key changes, when it has been idle for `MCPE_MCP_IDLE_TIMEOUT`, or when `closeProject` or `closeAll` is called. Within one process a session can be arbitrarily old, and that is harmless: the environment of a live process does not change, and a process started after a reconnect has no sessions.
- Alternative considered: merge inside `McpProxy`, the single choke point for launches. Rejected: the proxy knows containers, not slugs, so it would need a lookup back into the registry, or a changed signature for `listTools` and `callTool`, which `test/proxy.test.ts` alone calls on 31 lines (**measured** by search).
- Trade-off: correctness depends on every launch going through the one method. A missed call site starts a server without its variables, which is visible; the dangerous direction, a merged spec being persisted, is pinned by a test that reads the registry file (see Verification).

**DD3 — Every launch of a project's MCP servers gets the variables, probes included**
- That covers tool calls, the validation launch of `connect_mcp_server`, and the probes of discovery at install, `discover_tools`, `disconnect_mcp_server` and `refresh_mcp`. All of a project's servers get the same variables; there is no per-server scoping.
- A probe runs a candidate command that may turn out not to be an MCP server, and it gets the variables too. **Read** (`Installer.discoverMcp`): the candidates are the launches the repository declares in `server.json`, `mcp.json` or `.mcp.json`, the launches a command's help text advertises, and, for commands whose package depends on an MCP SDK or, failing any declared launch, for every command of a repository that hints at MCP, the bare command; up to the probe limit. It is the named project's own code, in that project's sandbox.
- Probes run with the sandbox's current network setting. **Read**: at install that is the setting the caller asked for (`Installer.install` applies it before discovery), so probes are offline unless the install was called with `network: true`. Later discoveries, `refresh_mcp` included, are online whenever `set_project_network` has turned the network on.
- Not given the variables: generated command line tools, `sandbox_exec`, the install recipe (charter constraint).
- **Measured**, one run: a later `docker exec` without the env file does not see the values. **Measured**, one run: another process in the same sandbox can read a running server's environment through `/proc/<pid>/environ` (same user, with the capability set the sandbox uses). So "MCP server processes only" describes what the variables are handed to, not an isolation boundary inside the sandbox.
- **Read**: the Docker client that starts a server inherits the whole environment of the mcp-everything process (`dockerConnector`), so every project's prefixed variables are in that client process on the host for every launch. They do not reach a sandbox by that way; only the env file does. This is unchanged and is stated in the README.

**DD4 — The process environment wins over a stored value** *(operator's decision)*
- If `connect_mcp_server` once stored `API_KEY` for a server and `{slug}__API_KEY` is set, the server starts with the value from the process environment. Changing the client configuration is always enough to change a key.
- Trade-off: a stored value can be shadowed without the agent that stored it being told. `project_info` marks the name as overridden (DD6).

**DD5 — `refresh_mcp(project)` stops the project's MCP servers and reruns the whole of discovery**
- It runs only on a project whose status is `ready` and which has no install job in this process. An `installing` project is refused whether or not this process runs the install, because the registry is shared and the installing process would overwrite the result; the refusal gives the advice `project_info` already gives, to reinstall if the install does not finish. (**Read**: the existing guards test only this process's jobs, and a `ready` project can briefly have one, when `install_project` is called for it again.) A `failed` project is refused with a pointer to `discover_tools` and `install_project`: repairing a build is their job, and `discover_tools` keeps doing it.
- Steps: resolve the project's variables and fail on an unusable one; make sure the sandbox is running, as `rediscover` does; `McpProxy.closeProject`; the same discovery `discover_tools` runs, with no extra executables; store the result; send the tool-list-changed notification.
- The method on `Installer` returns a structured outcome beside the record, because today a failure exists only as a warning string: the registered servers that did not start, each with its reason; the candidate launches that did not answer; and the server names before and after.
- Result: one line with the number of MCP servers and proxied tools and the names (never values) of the variables applied; then the outcome; then the project description. It is flagged as an error when a registered server did not start, when a server that was recorded before is gone afterwards, or when the catalog holds no proxied tool afterwards. *(Clarified at leg 02 design, 2026-11-15: counted on the catalog, not on the published subset, because a large server's tools can be callable while none is published individually.)* Candidates that did not answer are reported and are not by themselves an error: a repository that only hints at MCP has all its commands tried, and most of them are not servers. (**Read**: a registered server that fails stays in `mcpServers` with no tools, so "no server" would be the wrong test.)
- Why the whole of discovery: **read**, a detected server that fails its handshake is not recorded in `mcpServers` (`Installer.discoverMcp`), so restarting only the recorded servers would miss the case the charter's second criterion describes. Detection needs the facts discovery gathers first (commands, packages, help text).
- Why stop the servers first: so that discovery talks to freshly started processes and not to ones already running. It has nothing to do with picking up new values; a process started after a reconnect has no sessions to stop.
- Alternative considered: re-probe MCP servers only and patch the stored catalog. Rejected: it needs a second path that edits the catalog in place and has to reproduce how a bare MCP command displaces its command line tools; two paths that can drift.
- Difference from `discover_tools`: `refresh_mcp` stops running servers first; it takes no `executables`; it refuses projects that are not `ready`; its result reports the variables and the servers that failed. `discover_tools` is unchanged.
- **The catalog's contract.** The tool catalog in the registry is derived state. Source of truth: what the project's servers list when discovery runs, in the process that runs it. Rebuilt by: install, `discover_tools`, `connect_mcp_server`, `disconnect_mcp_server`, `refresh_mcp`. A change to the variables does not rebuild it; that is what `refresh_mcp` is for. It is not detected automatically because that would mean storing a fingerprint of the values. Maximum staleness: until one of those tools is called.
- Servers already in the catalog need no refresh to pick up new values: the next launch after a reconnect reads the environment then (DD2).
- **Read**: the registry is shared by every mcp-everything process on the data directory (`App.start` watches it), and each process has its own environment. **Inferred**, both directions: a process without a variable lists tools that another process's refresh published, and calls to them fail with the server's own start-up error; and when a process without the variable rebuilds the catalog by any of the tools above, the tools of servers that need the variable drop out until a process that has it refreshes again. Accepted; the README says that processes sharing a data directory should be given the same variables.
- **Read**: discovery works on a copy of the record and writes it back whole (`Installer.rediscover`, `finish`). A reinstall started while a refresh runs, here or in another process, can be overwritten by it or overwrite it. `discover_tools` has the same race today; `refresh_mcp` inherits it and does not widen it. Accepted, not fixed here.
- **Measured**, one run: on the sandbox the Docker suite uses, with two commands (its own and an added script), a full discovery took 1275 ms while the script refused to start as a server and 1153 ms when it answered and was recorded as one. **Not measured**: a project with many commands. Discovery may fetch help up to 90 times at up to `MCPE_HELP_TIMEOUT` each, so a large project could outlast a client's request timeout; that is equally true of `discover_tools` today.

**DD6 — Names are shown, with their source; values never**
- `project_info`, `list_projects` and the results of `install_project`, `discover_tools` and `refresh_mcp` all use `App.describe` (**read**). It gains the names of the variables the project receives from the process environment, and marks a stored name that is overridden.
- Both warnings discovery writes when a server does not start, the one for detected candidates and the one for registered servers (`Installer.discoverMcp`), name the route: set `{slug}__NAME` in mcp-everything's environment, reconnect, call `refresh_mcp`. The server instructions and the descriptions of `connect_mcp_server` and its `env` argument say the same, and say what DD9 says about passing values in a tool call. These are wording changes to an existing tool, not behavior changes.

**DD7 — The promise covers what mcp-everything writes on its own account; what a server prints is a documented limit** *(operator's decision)*
- mcp-everything never writes a proxied value on its own account: the stored spec, its own messages and errors, and its diagnostics name variables and never contain values.
- **Read**: text chosen by the proxied server travels further than a tool result, by three channels.
  - What it returns from a tool call goes to the caller (`App.upstreamResult`).
  - What it prints on stderr: up to 1500 characters are appended, after a line break, to the error for a failed start or a stopped server (`McpProxy.attempt`, `McpProxy.callTool`). That error is returned to the caller and written to the diagnostics log (`App.callTool`). It does not reach the registry: discovery keeps only the first line of an error for its warning (`brief` in `Installer.discoverMcp`).
  - What it sends over the protocol: its tool names, descriptions and schemas are stored in the registry (`record.tools`), and the message of a protocol error during the handshake or the tool listing is the first line of the error, so it is stored in the registry as a warning as well as returned and logged.
- So a server that prints "invalid API key: …" on stderr puts the key in tool errors and the diagnostics log; one that puts it in a protocol error message or a tool description puts it in the registry too. All of this is true today for stored values.
- Chosen: the charter's third criterion is reworded to what mcp-everything writes on its own account. The boundary is stated in the README and pinned by a test with a server that echoes its variable, so that it is a documented limit and not a silent one.
- Alternative put to the operator and not taken: before server-chosen text is stored, logged or returned, replace exact occurrences of the server's environment values by the variable's name. It is partial by nature (any encoding or truncation of a value defeats it, and short values cannot be replaced without mangling ordinary text), it needs its own rules (minimum length, what is scanned), and it reads as a guarantee that does not exist. It could be a later sortie.
- Trade-off: a server that echoes a key, most plausibly a wrong one in an "invalid key" error, leaves it in the diagnostics log and in what the agent sees; if it echoes it through the protocol, also in the registry, until the next discovery replaces the warning or the tool list.

**DD8 — Variables bind to a slug, not a repository** *(accepted by the operator, with visibility)*
- If a project is uninstalled and a different repository is later installed under the same slug, it receives the variables set for that slug. With `install_project(network: true)` its probes run online with them.
- Mitigation is visibility only: the result of `install_project` and `project_info` list the names a project receives (DD6), and the README states the risk. Recorded as accepted debt in the flight log.

**DD9 — The README documents both routes and says which is safe** *(operator's requirement)*
- Route 1, the default: variables in mcp-everything's own configuration. The agent never sees the values and nothing is stored.
- Route 2: `connect_mcp_server(env: …)`. A value the agent passes in a tool call is in the conversation transcript and is stored in plain text in the registry. The README calls this generally unsafe, with one exception: an agentic system with proper secrets management, where the value is injected at run time outside the agent's session.
- The README's security section currently says no credential is passed into a sandbox (**read**). That sentence is corrected, and the section gains: the variables are readable by any code in that sandbox and are in the Docker client's environment on the host (DD3); discovery and refresh run a project's commands with them, online when the sandbox's network is on (DD3); they bind to a slug (DD8); a server can echo them (DD7); processes sharing a data directory should share the variables (DD5).
- Also stated: names are matched in lower case, exactly as the slug is shown by `list_projects`; an empty value counts as set. The tools table gains `refresh_mcp`; the configuration table gains `<slug>__<NAME>`.

**DD10 — Where the tests live, and their time budget**
- Unit suite (`npm test`, runs by default): the matching rules, the merge and its precedence, each launch site, `refresh_mcp`, and the registry file's contents, all through the existing in-memory upstream (`test/helpers.ts`, `fakeUpstream`). Budget: under half a second added to a suite that takes 1.65 s (**measured**, 270 passed, 14 skipped).
- Docker suite (`npm run test:docker`, opt-in): two cases placed in the existing first block, after its proxy case and before its uninstall case, reusing that block's installed sandbox and nothing else. Budget: 25 s added to a suite that takes 141.6 s (sortie 02 debrief). The pressure cases are not affected and are not run for this flight: neither the watchdog script, its tests, nor the sandbox images change.
- The second case needs a server that discovery finds by itself and that starts only when a variable is set. **Measured**, one run against the `dist` build (which predates the merge of pull request #3; that merge changed only comment lines in `src/`), with a flag file standing in for the variable: an executable shell script placed in `/opt/mcpe/bin`, declared by a `.mcp.json` in the checkout as `{"command":"gated"}`, was picked up as a command; while it refused to start, discovery took 1275 ms, recorded the "none of these completed an MCP handshake" warning and no server, and generated a command line tool for the script; once it answered, discovery took 1153 ms, recorded it as a detected server, published its tool and dropped the script's command line tool; the proxied tool answered and the sandbox's own command line tool still worked.
- That combination worked once; nothing in it was varied. The script exited with status 2 when given any argument and with status 1 without the flag. **Inferred** from the code, as the reasons it worked and so what the leg should keep: help is fetched by running the command with help arguments, each allowed `MCPE_HELP_TIMEOUT`, so a script that does not exit at once on an argument would cost that long each time (`src/toolgen/discover.ts`); a declared launch is used only when its command is a bare name that resolves to a known command and contains no placeholder text (`src/toolgen/mcp-launch.ts`). The script is to be its own constant, not an edit of the shell server other cases share.
- **Not measured**: the same with a real variable, which is what the leg adds; and whether the files the case leaves in the sandbox disturb the cases after it. The case removes what it placed.

### Prerequisites
- [x] `main` at `5a3fedb`, with pull request #3 merged, is the base. (Checked 2026-11-15.)
- [x] Unit suite and typecheck pass on `main`: 270 passed, 14 skipped, 1.65 s; `tsc --noEmit` clean. (Run 2026-11-15, and again by the Architect.)
- [x] Docker is available: client and server 29.8.2; `buildpack-deps:stable` is present locally. (Run 2026-11-15.)
- [x] For the optional HAT leg: the operator's MCP client runs the build from the sortie branch, and an installed project whose MCP server needs a variable is chosen. Settled when that leg is designed. *(Settled 2026-11-15: this checkout's build, and a stand-in server on the `gron` sandbox.)*

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [x] Prerequisites verified (except the HAT leg's, deferred to its design)
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
1. A small pure module computes a project's variables from an environment object and the installed slugs: ownership by longest slug, name validation, and rejection of unusable values through `validateEnv`, with messages that name variables only (DD1, DD2).
2. `Installer` takes the environment object and owns the one method that produces a launch spec from a stored one. Its three launch sites and `App.callGenerated` use it (DD2, DD3, DD4).
3. `App.describe` shows the names and their source (DD6).
4. `refresh_mcp` is added to the meta tools and handled in `App.callMeta`, backed by a method on `Installer` beside `rediscover` (DD5).
5. The two discovery warnings, the server instructions and the `connect_mcp_server` descriptions are updated (DD6).
6. README: the proxied-servers section, the security model, the tools table and the configuration table (DD9).
7. Tests as in DD10 and Verification.

Files expected to change: `src/server.ts`, `src/install/installer.ts`, a new module under `src/proxy/`, `README.md`, `test/server.test.ts`, `test/installer.test.ts`, a new unit test file for the module, `test/integration/docker.test.ts`. `src/types.ts` and `src/proxy/mcp-proxy.ts` are not expected to change: the registry's shape and the proxy stay as they are.

Out of scope: the version number (bumped by a servicing squawk at release, as for 0.2.0); the existing defect in `App.findGenerated` for slugs containing `__`, logged as [squawk 0008](../../squawks/0008-tools-of-slugs-containing-double-underscore.md). Because of that defect, tests of the two-slug case of DD1 drive the module or `Installer` directly and not a tool call by name.

### Checkpoints
- [x] The matching module and its unit tests exist and pass.
- [x] Every launch site uses the launch spec; a tool call against a fake upstream shows the variable in the launched environment.
- [x] The three controls of the Verification section have each been seen to fail for the stated reason, and the working tree restored.
- [x] First Docker case passes.
- [x] `refresh_mcp` publishes the tools of a server that did not answer without the variable, in the unit suite and in the second Docker case.
- [x] Docker cases pass inside the time budget.
- [x] README and tool descriptions updated.

### Adaptation Criteria

**Divert if**:
- Values cannot be kept out of the registry without changing the registry's shape.
- A second cluster of decisions turns out to be needed: per-server scoping, a change to `connect_mcp_server`'s behavior, or a pin of variables to a repository.
- A Docker case cannot be made reliable inside the budget of DD10, or disturbs the cases that follow it.

**Acceptable variations**:
- The name and location of the new module and of the launch-spec method.
- The exact wording of messages and descriptions, provided they name variables and never values.
- How the environment object is threaded from `AppOptions` to `Installer`.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `host-env-passthrough` - The matching module, the launch-time merge at all four sites, what `project_info` shows, the unit tests for criteria 1, 3 and 4 and both constraints with their controls, and the first Docker case. This is the part that handles secrets; it is complete and testable without the second leg.
- [x] `refresh-mcp-and-docs` - The `refresh_mcp` tool with its guards and result, the discovery warnings, the server instructions and `connect_mcp_server` descriptions, the README, the unit tests for criterion 2, the extension of the first leg's registry-file test to `refresh_mcp`, the test that documents the limit of DD7, and the second Docker case. Depends on the first leg.
- [x] `hat-and-alignment` *(optional, requested by the operator)* - Guided session in the operator's own client: set a real `{slug}__NAME` variable, reconnect, call `refresh_mcp` against a real installed MCP server, and walk the checks, with fixes along the way.

The split is by what can be finished and checked by itself, not by kind of task: each leg carries its own tests. Both are reviewed and committed together at the end of the flight.

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [x] Code merged
- [x] Tests passing
- [x] Documentation updated

### Verification
Each charter criterion and constraint, and what shows it. No behavior test is authored: the mechanism is observable through `App.callTool` and the registry file in a deterministic test, and the one thing only a real client shows, the reconnect, is what the HAT leg is for.

An assertion that a value is absent is only worth something next to one that it is present where it should be. Items 3, 5 and 6 are therefore each written in the same test as a positive check: the launch for that project does carry the value.

1. **A server starts with the variable.** Unit: a tool call through a fake upstream launches with the name present and the value from the injected environment; where the same name is stored for the server, the launch carries the value from the environment and not the stored one (DD4). Docker: a registered shell server reports the value it was started with, the registry file on disk does not contain that value, and the temporary env-file directory is empty afterwards.
2. **A server that could not start is published after `refresh_mcp`.** Unit: a detected candidate that answers only when the variable is present; discovery without it leaves a warning and no tools; a second `App` on the same data directory with the variable in its environment (standing in for a reconnect) calls `refresh_mcp` and the tools are published. Also: a server running before the refresh is launched again by it; `refresh_mcp` is refused for `installing` and `failed` projects; it is flagged as an error when a registered server does not start and when a server published before is gone afterwards, and is not flagged merely because a candidate did not answer. Docker: the recipe measured in DD10, with a real variable; the script's command line tool is gone after the refresh.
3. **mcp-everything never writes a value.** Unit, with a server that does not echo: after install with detection, `connect_mcp_server` and `discover_tools` (first leg) and `refresh_mcp` (second leg), the bytes of `registry.json` and every tool result and log line collected in the test do not contain the value; `project_info` contains the name, and marks a stored name that is overridden. An unusable value is rejected, on a tool call, in discovery and in `refresh_mcp`, with a message that contains the variable's name and not its value. One further test documents the limit of DD7 and is named as such, so that nobody reads it as a requirement: a server that echoes its variable on stderr, and one that echoes it in a protocol error message, with a record of where the value then shows up in each case.
4. **No crossing, no change without variables.** Unit: with variables for two slugs set, each project's launches carry only its own; the two-slug case of DD1, including the empty remainder; a project with no matching variables launches with exactly its stored environment, and the existing suites pass unmodified.
5. **MCP server processes only.** Unit: for a project that has variables, a generated command line tool and `sandbox_exec` produce Docker calls whose arguments and options do not contain the value, while a proxied tool call for the same project launches with it. Docker: `sandbox_exec` printing its environment does not show the variable, in the case where the server reports it.
6. **Never on a command line.** Unit, in the manner of the existing `dockerConnector` test in `test/proxy.test.ts`: the real connector is given the launch spec produced for a project with a proxied variable; its arguments do not contain the value and the env file it wrote does.

**Controls.** Criteria 3 and 4 are assertions that something is absent, and such assertions pass against code that does nothing. Before the first leg lands, the Developer breaks the build on purpose in three ways, one at a time, and records that the tests fail for the stated reason: store the launch spec instead of the stored spec (the registry assertion must fail); drop the slug prefix check so that every project receives every prefixed variable (the crossing assertion must fail); drop the longest-slug rule (the two-slug assertion must fail). Each change is reverted and the working tree shown to be identical afterwards.

**Not shown by this flight**: Windows; a real client's reconnect (HAT leg); values larger than a few kilobytes; how long a refresh takes on a project with many commands; two processes with different variables on one data directory.
