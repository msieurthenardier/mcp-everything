# Flight Log: MCP Env Passthrough

**Flight**: [MCP Env Passthrough](flight.md)

## Summary
In flight since 2026-11-15 on `sortie/03-mcp-env-passthrough`. Charter agreed with the operator on 2026-11-15; flight spec reviewed in two Architect cycles and approved by the operator the same day. Both implementation legs, `host-env-passthrough` and `refresh-mcp-and-docs`, are completed: reviewed and confirmed in one cycle and committed. The optional HAT leg the operator asked for remains.

---

## Leg Progress

### Leg 01: host-env-passthrough
- **Status**: completed (reviewed and confirmed on 2026-11-15; committed with the flight's implementation commit)
- **Started**: 2026-11-15
- **Completed**: 2026-11-15

#### Changes Made
- `src/proxy/host-env.ts` (new): pure matching. `ownedVariables` decides ownership once (longest slug among the given slugs plus the project's own that prefixes `slug__`, then name validity against `ENV_NAME`); `hostVariableNames` (display, never throws, never looks at a value); `launchVariables` (throws a plain `Error` naming the prefixed variable, never the value, for CR, LF or NUL). Built with `Object.fromEntries` so a variable named `__proto__` stays data.
- `src/proxy/mcp-proxy.ts`: `ENV_NAME` exported (the only change).
- `src/install/installer.ts`: `Installer` takes the environment object as a sixth constructor parameter after `choose` (default `process.env`, read at each launch, not copied). New public `launchSpec(project, server)` (stored `env` overlaid with the project's variables; returns a copy; ownership against every registry record plus the project's own slug) and `hostVariableNames(project)`. Launch sites: `connectMcp` (spec computed before `closeProject`; the record keeps the stored `spec`) and both `listTools` calls in `discoverMcp` (inside the existing `try` blocks; `servers.push` still pushes the stored spec).
- `src/server.ts`: `AppOptions.env`, passed to `Installer`; `callGenerated` launches with `installer.launchSpec`; `describe` adds a project-level line `environment from {slug}__… variables of the mcp-everything process, passed to every MCP server of this project: NAMES` (only when there are names) and marks a stored name that is also set as `NAME (overridden by {slug}__NAME)` on the server line. Output for a project with no matching variable is unchanged.
- `test/host-env.test.ts` (new, 22 tests): the matching rules, both slug orders, invalid names, empty and undefined values, unusable values.
- `test/server.test.ts`: new `describe` block at the end (see Verification). `test/installer.test.ts`: new `describe` block at the end. `test/proxy.test.ts`: one new `describe` at the end (imports `Installer`, `Registry`, `record` dynamically inside the test, so no import line was edited). `test/integration/docker.test.ts`: one new case between "proxies an MCP server running inside the sandbox" and "uninstall removes the container and the volume".
- Existing test lines changed: **none**. `git diff -- test | grep '^-[^-]'` returns 0 lines; additions only. No imports or shared setup were edited.
- `grep -n -E "proxy\.(listTools|callTool)\(" -r src` returns exactly four lines: `installer.ts` (`listTools(project.container, launch)`, two in `discoverMcp` with `this.launchSpec(record, …)`) and `server.ts` (`callTool(…, this.installer.launchSpec(project, server), …)`). Measured.

#### Verification
All measured by running the tests unless marked inferred.
- Matching (DD1): `test/host-env.test.ts`, one `it`/`it.each` row per rule: exact and case-sensitive rows (upper-cased slug, one underscore, prefix before the slug, no separator, unrelated `__` keys); `gives a variable to the project with the longest matching slug, whatever the order` in both orders; `gives a__b__KEY to a as b__KEY when only a is known`; `returns a variable with an invalid name for nobody, and does not throw` (empty, digit, dash, over-long, with a line-break value, both orders, both slugs); `returns an empty value as an empty string and ignores undefined`; `a value with a line feed / carriage return / NUL … throws an Error that names the variable and not the value` (prototype checked to be `Error.prototype`).
- Merge (DD2, DD3, DD4), `test/server.test.ts` "host environment variables for proxied MCP servers": `callGenerated: a proxied tool call launches once, with the variable`; `connectMcp: the first launch has the variable, and what is stored does not`; `discoverMcp, registered servers: discover_tools launches the server with the variable`; `the environment wins over a stored value of the same name, and says so in project_info`; `the object is read at each launch, not copied at construction`; `each project's launches carry only its own variables`; `a project with no matching variable launches with exactly its stored environment`; `the session is still shared (nothing stored | the same name stored with the same value)` and `... for a project without a matching variable` (one launch, `proxy.size` 1). `test/installer.test.ts` "host environment variables": `candidates: every launch of an install with detection carries the variable, and the record stores none`; `launchSpec` tests: overlay and no mutation, unchanged when nothing matches, project not in the registry, ownership against every record whatever its status in either order, plain Error without the value. Stored `mcpServers[].env` is `{}` after `connect_mcp_server` with no `env` and after the install with detection (asserted in those tests).
- Unusable value: `fails a proxied call with the message, which is also logged, without the value; other projects are unaffected` (log is exactly `demo__whoami failed: <message>`); `fails connect_mcp_server before any running server of the project is stopped` (`proxy.size` stays 1, no new launch, registry unchanged); `leaves a registered server recorded with no tools and an MCP warning, in discovery` (status `ready`); `candidates: an unusable value fails the candidate with the message and the install still finishes ready`; `project_info still lists the name and prints no value`.
- Nothing written by mcp-everything: `nothing mcp-everything writes contains the value: registry, tool results and log lines` (install-with-detection part is covered by the installer test; this one runs `connect_mcp_server`, a proxied call, `discover_tools`, `project_info`, `list_projects`, asserts every launch carried the value, then that `registry.json` bytes, every result text and every log line do not contain it).
- Constraints: `only MCP server processes receive it: command line tools and sandbox_exec do not` (serialized `argv` and `opts` of `FakeDocker.calls` exclude the value; the proxied call launches with it); `test/proxy.test.ts` `hands a variable of the launch spec to docker through the env file only, never on a command line` (real `dockerConnector`, spec from `Installer.launchSpec`; args exclude the value, the env file is `API_KEY=<value>\n`, removed on cleanup).
- Visibility (DD6): `project_info lists the names a project receives, and no values, before any server exists`; `is byte for byte what it was for a project with no matching variable` (project_info and list_projects compared with an app whose environment has only unrelated variables; the existing "stores the environment but never prints its values" passes unedited); `still lists names for a project that is installing or failed` (a `failed` record; the `installing` state itself is inferred from the code path, which does not look at status).
- Docker: `gives a proxied MCP server the host environment's value, which is never stored or run elsewhere` (second `App` with `env: { gron__GREETING }`, registers `shenv` with a different stored `GREETING`; tool reports the host's value; `registry.json` lacks it and still holds the stored value; `tmp` empty; `sandbox_exec env` lacks it and does contain `PATH=`; disconnect and shutdown in `finally`).

#### Controls
Each: one edit, the named test run, edit re-applied by text (no git restore), checksums compared. Whole test files were run, so other tests failed too; the named test is the one meant to catch it.
1. Storing the launch spec: `Installer.connectMcp` record given `launch` instead of `spec`. Checksum of `src/install/installer.ts` before and after: `f744731143703b96f6faaccbc7b9323a5ec61a3a5cc689627e164c5187fb89fd` (equal). Named test: `nothing mcp-everything writes contains the value: registry, tool results and log lines`, failing with `AssertionError: expected '{\n  "version": 1,\n  "projects": {\n…' not to contain 'hv-7Qz3kLx9Vb2NmR8tYw4Pa6Ud1Fs0Jc5'` (the registry-bytes assertion). Also failed: `connectMcp: the first launch has the variable, and what is stored does not` (`expected { Object (API_KEY) } to deeply equal {}`) and `the session is still shared (nothing stored)`. 3 failed, 83 passed.
2. Dropping the prefix check (every project receives every `…__…` variable, name taken after the first `__`): `src/proxy/host-env.ts` before and after `f2a7ebb8a9d30b9b5fef78d54185b1b756f5b85c99e3e3ad0c575086788b2524` (equal). Named test: `each project's launches carry only its own variables`, failing with `AssertionError: expected [ { …(2) } ] to deeply equal [ Array(1) ]`; the diff shows `demo`'s launch receiving `other`'s values (expected `API_KEY: <demo value>`, received `API_KEY: <other value>` and `ONLY_OTHER: "1"`). 17 tests failed in the three files.
3. Dropping the longest-slug rule (first matching slug wins): same file, same checksum before and after (`f2a7ebb8…2524`). Named test: `gives a variable to the project with the longest matching slug, whatever the order: ["a","a__b"]`, failing with `AssertionError: expected {} to deeply equal { KEY: 'v' }`. The `["a__b","a"]` order passed under this particular break (as expected for the loop order `[a__b, a]`: the longer slug comes first), which is why both orders are tested. Also failed: `decides ownership against every record in the registry…` and three others. 5 failed.

#### Suites
- `npm test` before: 270 passed, 14 skipped, `Duration 1.46s` (measured; 1.65 s at planning). After: 319 passed, 15 skipped (the new Docker case is skipped without `MCPE_DOCKER_TESTS`), `Duration 1.52s`–`1.56s` over three runs. Added about 0.1 s against the 0.5 s budget.
- `npm run typecheck`: clean.
- `npm run test:docker` (run once, `--reporter=verbose`): 13 passed, 2 skipped (the pressure cases, not run), `Duration 143.08s` (141.6 s in sortie 02). New case: 1998 ms (budget 10 s). The 12 existing cases passed unchanged; "proxies an MCP server running inside the sandbox" 9632 ms. No leftover `mcpe-it` container (checked with `docker ps -a`).

#### Decisions, deviations, anomalies
- No deviation from the flight spec or the leg. No test hung.
- Message wording chosen by the module: `Environment variable {prefixed name} contains a line break or NUL character and cannot be passed to the MCP server.`
- `describe` wording chosen: project-level line `environment from {slug}__… variables of the mcp-everything process, passed to every MCP server of this project: …` and `NAME (overridden by {slug}__NAME)`. Leg 2 may reword the user-facing text; the tests assert fragments of it.
- New unit tests pass explicit environment objects and never touch `process.env`. The new Docker case builds its second `App` with `loadConfig({ ...process.env, … })` exactly as the block's `beforeAll` does (the real Docker client needs the host environment, and `App` has no way to hand out its config); the injected variable itself is explicit. Existing tests still use the real `process.env` and would notice a `demo__…` or `widget__…` variable set on the machine running them.
- Not fixed, noted: a variable named `{slug}__PATH` or similar is passed like any other (by design, per the leg's edge cases). The `installing` state of `describe` was not tested with a real installing record (inferred).
- Out of scope, already logged as squawk 0008: slugs containing `__` break `App.findGenerated`; left alone.

### Leg 02: refresh-mcp-and-docs
- **Status**: completed (reviewed and confirmed on 2026-11-15; committed with the flight's implementation commit)
- **Started**: 2026-11-15
- **Completed**: 2026-11-15

#### Changes Made
- `src/proxy/host-env.ts`: `isUnusableValueError(e)`, backed by a module-level `WeakSet` that `launchVariables` adds its error to. The error stays a plain `Error` (leg 01's `host-env.test.ts` checks `Object.getPrototypeOf(caught) === Error.prototype`, so the "small dedicated error class" the leg suggested would have broken a leg 01 test; a tag does the same job). Message text unchanged.
- `src/install/installer.ts`: `McpDiscovery` now also carries `failed` (registered servers whose listing threw, with the first line of the reason), `unanswered` (candidate launches) and `reason`; `discover` returns it (it returned nothing before; `rediscover`, `connectMcp`, `disconnectMcp` and install ignore it, so behavior is unchanged). New exported `RefreshOutcome` and `Installer.refreshMcp(project)`: `launchVariables` first (throws before anything is stopped), `requireSandbox`, `proxy.closeProject`, `discover(record, [])`, `finish`; returns the record, `failed`, `unanswered`, `reason`, and the server names before (incoming record) and after. Warnings: both get the route hint (`routeHint(slug)`: "If it needs environment variables, set {slug}__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp."), appended after `brief` has cut. Candidates warning: prefix and `(reason).` kept, then the hint, then "If it needs other arguments or network access, register it with connect_mcp_server." When the reason is the unusable-value error (registered: that error; candidates: the first reason, which is what the warning prints) no hint is added, and the candidates warning keeps leg 01's exact closing sentence.
- `src/server.ts`: `refresh_mcp` in `META_TOOLS` (one required property, `project`); `callMeta` case: refuses (`ToolInputError`) on a running job in this process first, then status `installing`, then `failed`; then `hostVariableNames`, `refreshMcp`, tool-list-changed notification, result text, `isError` by the three conditions (a registered server did not start; a name recorded before is not recorded after; zero `kind: "mcp"` tools in `updated.tools`). Reworded `INSTRUCTIONS` and the `connect_mcp_server` description and `env` description (texts in the report).
- `README.md`: tools table row; new subsection "Giving a server its environment" under "Projects that are MCP servers" (routes 1 and 2); security model bullets; configuration table row; the one "environment variables" mention in the by-hand registration paragraph removed (the `API_KEY` example moved to route 2).
- `test/server.test.ts`: new `describe("refresh_mcp")` inside leg 01's host-environment `describe` (21 tests with the other two files below); one added import line. `test/installer.test.ts`: new `describe("refresh_mcp on a scripted sandbox")` (4 tests); three added import lines. `test/integration/docker.test.ts`: one constant (`GATED_MCP_SERVER`) and one case between leg 01's case and "uninstall removes the container and the volume".

#### Verification
Measured by running the tests, unless marked inferred. Test names are in `test/server.test.ts` > "host environment variables for proxied MCP servers" > "refresh_mcp" unless a file is named.
- Tool listing: `is a built-in tool with one required argument, project, and no others`.
- Refusals: `refusals leave everything as it was` (4 rows: job running; job running and status installing, which shows the job check comes first; status installing without a job, message has the project_info advice; status failed, message names `discover_tools` and `install_project`). Each compares `docker.calls`, `docker.ensureCalls`, `up.launches` and `proxy.size` before and after and had a session open before the call.
- Unusable value: `fails before anything is stopped when a value is unusable, naming the variable and not the value` (`proxy.size` stays 1, counts unchanged, the message contains `demo__API_KEY` and not the value). Sandbox gone: `stops nothing when the sandbox no longer exists`.
- Behavior on a ready project: `stops the sessions, discovers again, launches a server that had one, and says what it did` (ensureRunning called, a kill with the first launch's PID file in `FakeDocker.calls`, the same launch spec a second time with a new PID file, one tool-list-changed call, first line, names line, offline line, result ends with the `project_info` text, no value).
- Result and flag: `says that no variable is set, and nothing about the network when it is on`; `what makes it an error: each condition alone` (3 tests: registered server fails while another publishes, `1 with no tool in the catalog`, route hint in the stored warning; detected server gone while another publishes; no proxied tool at all; each asserts the other two conditions' lines are absent). `test/installer.test.ts` > "refresh_mcp on a scripted sandbox": `a candidate that did not answer is listed and is not an error while another server publishes tools`.
- Charter criterion 2 and its reverse (`test/installer.test.ts`): `a candidate that answers only with a variable: found by a refresh once the variable is there` (install without: no server, no proxied tool, warning with the route; second `App` on the same data directory with the variable: not an error, server recorded as detected with `env: {}`, catalog and `listTools` have `widget__add`, result names `API_KEY` and not the value, registry bytes and log lines lack it, every launch of the refresh carried it); `the reverse: a server that needs the variable is gone after a refresh without it, and that is an error` (proxied tools remain; no "Did not start").
- Warnings: route hint on the candidates warning (installer test above, with `widget__NAME`, `refresh_mcp` and `connect_mcp_server`); on the registered-server warning (`a registered server did not start…`, asserts `set demo__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp`); no hint for an unusable value, both places (`the route hint is not added to the warning for an unusable value`; `the candidates' warning gets no route hint when the reason is an unusable value`; leg 01's registered-server test, which asserts the warning equals `MCP: <message>`, passes unedited). The existing "reports the launches it tried when none answers" passes unedited.
- Instructions and descriptions: `tells agents the route in the instructions and the descriptions of connect_mcp_server` (instructions read through a connected client; descriptions through `listTools()`).
- No value in anything written: `nothing mcp-everything writes contains the value after a refresh: registry, tool result and log lines` (sibling of leg 01's test, which is unchanged; presence: every launch carried the value; absence: registry bytes, results, log lines).
- DD7 limit, two tests: `documents a limit: a server that prints its variable on stderr leaves it in the tool error and the log, not in the registry` and `documents a limit: a server that puts its variable in a protocol error leaves it in the registry as well` (connectors written in the test; stderr: dead transport plus stderr text; protocol: server side answers `initialize` with a JSON-RPC error whose message contains the value; the value is asserted in the registry bytes and in a warning for the second, and absent for the first).
- Docker: see Suites.
- README criteria, by heading (all in `README.md`):
  - tools table row `refresh_mcp`: "Built-in tools". Configuration row `<slug>__<NAME>`: "Configuration".
  - part on giving a server its environment, two routes: "Projects that are MCP servers" > "Giving a server its environment".
  - route 1 as default, client configuration example (placeholder value), reconnect then `refresh_mcp`; agent never sees values and nothing stored; already-published server picks up a changed value at next start after reconnect and `refresh_mcp` is for servers that could not start or list different tools; prefix is the slug as `list_projects` shows it, lower case; empty value counts as set; to every MCP server of the project and not to its command line tools; configuration wins over `connect_mcp_server`'s stored value; line breaks rejected: all under "Giving a server its environment", "Route 1".
  - route 2 with the `API_KEY` example moved under it, transcript and plain-text registry stated, "generally unsafe", the one exception (agentic system with proper secrets management injecting at run time outside the agent's session): "Giving a server its environment", "Route 2".
  - security model no longer says no credential is passed in; says which variables are and that mcp-everything never stores them: "Security model" > "What the sandbox does", first bullet.
  - the six limits (code in the sandbox can read a running server's variables; Docker client's environment on the host; discovery and `refresh_mcp` run commands with them, online when the network is on; bound to a slug; a server can print them to tool errors, the log and, by protocol error or tool description, the registry; processes sharing a data directory should share the variables): "Security model" > "What it does not do", bullet "Variables given to a project's MCP servers are exposed to more than those servers" (one sub-bullet each).
  - the plain-text bullet now scoped to `connect_mcp_server`, and "never echoed back by any tool" replaced by "mcp-everything itself never writes a value into a tool result, an error message or its diagnostics log", pointing at the limit: "Security model" > "What it does not do", bullet "Values given to `connect_mcp_server(env: …)` are stored in plain text".
  - nothing else contradicts: searched the README for "credential", "plain text", "environment", "echoed", "API_KEY" (inferred complete from the search; read in full: "Projects that are MCP servers", "Security model", "Configuration", "Limitations").

#### Controls
Each: one edit to `src/server.ts`, the two test files run, the edit re-applied by text (no git restore). Checksum of `src/server.ts` before and after each, and after both: `7e746fe1fa4f2f2b2ff999b3e6d1c599ec002d2072470d6a6b83ca662bca5b69` (equal).
1. Error flag broken (`gone.length > 0 ||` dropped from the condition): 2 failed, 105 passed. Failing: `test/server.test.ts` > "what makes it an error: each condition alone" > `a detected server is gone while another publishes tools`, and `test/installer.test.ts` > "refresh_mcp on a scripted sandbox" > `the reverse: a server that needs the variable is gone after a refresh without it, and that is an error`. Assertion in both: `AssertionError: expected false to be true // Object.is equality` (on `res.isError`). The other two condition tests passed, so the break is caught only by the tests of that condition.
2. Refusal for `installing` broken (condition replaced by `false as boolean`): 1 failed, 106 passed. Failing: `refusals leave everything as it was > when the status is installing and no job is running here`, `AssertionError: expected false to be true` (on `res.isError`). The job-running rows still passed (the job check comes first and is separate).

#### Suites
- `npm test` before this leg: 319 passed, 15 skipped, `Duration 1.54s` (measured at the start of the leg). After: 340 passed, 16 skipped (the new Docker case is skipped without `MCPE_DOCKER_TESTS`), `Duration 1.55s`–`1.66s` over five runs. Added about 0.1 s against the 0.5 s budget. Slowest new unit test: 6 ms (`the reverse…` in `test/installer.test.ts`); the slowest in `test/server.test.ts` 4 ms. Limit 300 ms.
- `npm run typecheck`: clean.
- `npm run test:docker` (run once, `--reporter=verbose`): 14 passed, 2 skipped (the pressure cases, not run, `MCPE_PRESSURE_TESTS` not set), `Duration 149.06s` (143.08 s after leg 01; wall clock 2m39s). New case: 4148 ms (budget 15 s). It printed `refresh_mcp (gron, one detected shell server): 1223 ms`. Leg 01's case 2162 ms; "proxies an MCP server running inside the sandbox" 9741 ms; all other cases passed unedited. No `mcpe-it` container or volume left (checked with `docker ps -a` and `docker volume ls`). Added about 6 s to the suite total (the rest of the difference is the existing cases' variance; inferred).
- No test hung. No existing test line was edited: `git diff -- test | grep -c '^-[^-]'` is 0 (measured).

#### Changes to tests that existed before
- Leg 01 tests changed: **none**. Leg 01's wording-dependent tests (`leaves a registered server recorded with no tools and an MCP warning, in discovery`, `candidates: an unusable value fails the candidate…`, the `Error.prototype` check) pass unedited, because the unusable-value paths keep leg 01's text.
- Import lines added to existing test files (no existing import line was edited): `test/server.test.ts`: `import type { Connector } from "../src/proxy/mcp-proxy.js";`. `test/installer.test.ts`: `import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";`, `import type { Connector, Launch } from "../src/proxy/mcp-proxy.js";`, `import { App } from "../src/server.js";`.

#### Decisions, deviations, anomalies
- Deviation from the leg's suggestion, forced by a leg 01 test: no dedicated error class. A subclass of `Error` would fail the `Object.getPrototypeOf(caught) === Error.prototype` assertion in `test/host-env.test.ts`, which this leg may not edit. `isUnusableValueError` tags the plain `Error` through a `WeakSet` instead. Not a conflict between leg and spec.
- For the candidates warning the "reason" is the first failing candidate's reason, as before; the hint is decided on that reason. A project whose first candidate fails on an unusable value and later ones on something else gets no hint; inferred acceptable since an unusable value fails every launch of the project (all launches carry the same variables), so the reasons are the same.
- `refresh_mcp` refusal messages: job: `{slug} is still installing.`; status installing: `{slug} is installing. This install was started by another session or was interrupted; reinstall if it does not finish.`; failed: `{slug} failed to install. Repair the build and run discover_tools, or reinstall it with install_project(reinstall: true).`
- The reverse test relies on the stock fake upstream's tools being listed by two servers at once; the catalog handled that without a name clash in the assertions made (read from the test passing; the catalog's collision handling was not examined).
- The Docker case's script uses `printenv NAME >/dev/null || exit 1` as the set-test, because `${NAME+set}` is parsed as a template substitution inside `String.raw` in the test file. `printenv` exits 0 for an empty value and 1 when unset (inferred from coreutils behavior; the case passed with a non-empty value only, so the empty-value case is not exercised against the real script).
- Out of scope, not touched: squawk 0008 (slugs containing `__`). For the new tool, a project whose slug contains `__` cannot call its proxied tools by name, but `refresh_mcp` itself resolves the project by slug and is not affected (inferred).

---

### Flight Director Notes

- 2026-11-15: execution started with `/mission-control:agentic-workflow sortie 03`. Crew file `.flightops/agent-crews/leg-execution.md` loaded and well-formed (Crew, Interaction Protocol, Prompts present). Developer and Reviewer run on Sonnet, as it assigns.
- Branch `sortie/03-mcp-env-passthrough` created from `main` at `5a3fedb`, carrying the uncommitted planning artifacts and squawk 0008. Flight set to `in-flight`.
- Three legs counted: `host-env-passthrough`, `refresh-mcp-and-docs`, and the optional interactive `hat-and-alignment`. Starting at the first; nothing was in progress.
- Leg 01 `host-env-passthrough` designed. **Risk tier: high**, because it is the security-sensitive surface of the flight (it hands secrets to sandboxed third-party code and must keep them out of the registry) and it changes a constructor other code calls. It gets a Developer design review before implementation.
- Leg 01 design review (Developer, Sonnet): approve with changes; all citations verified; no contradiction with the flight's decisions. Taken into the leg: a test per launch site that fails if that site passes the stored spec (the registered-server loop of `discoverMcp` had none, and the tool-call criterion could pass on an earlier launch's session); a direct test that sessions are still shared; the method always counts the given project's own slug; the two-slug test runs in both slug orders so the third control fails whatever the loop order; the first control names its edit; `connect_mcp_server` computes the launch spec before stopping anything; the Docker case cleans up in a `finally`. The unusable-value error stays a plain `Error`, so it is logged (it names the variable, never the value). The unit-suite time budget is recorded and reported, not a pass/fail line, since it depends on the machine.
- No second design review: every change is one the reviewer recommended, and none alters the approach. Leg 01 set to `ready`; Developer spawned to implement.
- Carried into the leg from the sortie 01 and 02 debriefs: time budgets for new tests are stated in the leg (0.5 s for the unit suite, 10 s for the Docker case); absence assertions are paired with presence assertions and each has a control seen to fail; the Developer is told not to kill processes by pattern and not to commit.
- Leg 01 landed (`[LAND:leg]`). The Flight Director re-ran the unit suite (319 passed, 15 skipped, 1.52 s) and the typecheck (clean), read the source diff, and confirmed no test container was left. The Docker suite was not re-run by the Flight Director; its result is the Developer's. One of two autonomous legs done; nothing committed.
- Leg 02 `refresh-mcp-and-docs` designed from what leg 01 produced. **Risk tier: high**: it adds a tool to the server's interface, depends on project status (`installing`, `failed`, `ready`), rebuilds the stored catalog, and writes the security guidance operators and agents will act on. Developer design review before implementation.
- Leg 02 design review (Developer, Sonnet): approve with changes; all citations verified; no contradiction with the flight's decisions. Two findings would have cost the implementation dearly and are fixed in the leg. The fake upstream the leg recommended leaves an unanswered launch waiting 15 s per candidate, which would have hung the unit suite; the leg now says how to make such a launch fail at once and sets a 300 ms ceiling per new test. And the control for the error flag would not have failed, because the "gone" test also tripped the "no proxied tool" condition; each flag condition now has a test in which it alone holds. Also taken: the first line of the result defines its counts; one rule for the route hint (never on the unusable-value warning, in either place); which refusal message wins; the DD7 tests' connector and seeding; the Docker case's cleanup order; the README's "never echoed back by any tool" sentence is named for correction.
- No second design review: every change is one the reviewer recommended, and none alters the approach. Leg 02 set to `ready`; Developer spawned to implement. DD5 in the flight spec was annotated with the catalog clarification.
- Two calls made at leg 02 design, within DD5 and DD6. "No proxied tool is published afterwards" is counted on the catalog, not the published subset, because a large server's tools can be callable while none is published individually. The route hint is not appended to the unusable-value warning, whose message already says what to fix.
- Leg 02 landed (`[LAND:leg]`). The Flight Director re-ran the unit suite (340 passed, 16 skipped, 1.56 s) and the typecheck (clean) and confirmed no test container was left; the Docker result (14 passed, 2 skipped, 149 s) is the Developer's. One deviation from the leg's guidance, accepted: the unusable-value error is told apart by a tag kept in `src/proxy/host-env.ts`, not by a dedicated error class, because a leg 01 test pins that the error is a plain `Error`. Both autonomous legs are done; nothing is committed.
- Flight review started: one Reviewer (Sonnet) over all uncommitted changes of both legs, given the changes and the legs' criteria and none of either Developer's reasoning.
- Flight review, cycle 1: `[HANDOFF:confirmed]`, no blocking issue, no fix cycle. The Reviewer went through both legs' criteria, found all met, and ran the suites itself: `npm test` 340 passed and 16 skipped in 1.56 s; typecheck clean; `npm run test:docker` once, 14 passed and 2 skipped in 152.55 s (leg 01's case 2169 ms, leg 02's case 4104 ms with a printed refresh of 1234 ms); no test container left; pressure cases not run, as the watchdog, its tests and the images are unchanged. It found no path by which mcp-everything writes a value itself, exactly four launch sites all going through `Installer.launchSpec`, and no existing test line removed or changed. Its one remark was bookkeeping: the flight's checkpoints were still unticked.
- After the review: both legs set to `completed` with their criteria ticked, the two implementation legs and the checkpoints ticked in the flight spec, the log's leg entries set to `completed`. The flight stays `in-flight`: the optional HAT leg the operator asked for is still to come, and it is interactive. Squawk 0008 is committed separately from the flight, as earlier squawk logs were.

---

## Decisions

### Charter gate, 2026-11-15
**Context**: The request was `{slug}__{NAME}` variables on the mcp-everything server, set on the installed MCP server, with a refresh function because the variables are usually set after the install.
**Decision**: The operator agreed the charter as drafted, with two scope choices: the variables come from the process environment only (no env file that is re-read), and they are handed to MCP server processes only (generated command line tools are unchanged).
**Impact**: Both choices are written into the charter's Constraints, so the criteria carry their scope.

### Design interview, 2026-11-15
**Context**: Three questions put to the operator before the spec was written, and one point the operator raised.
**Decision**:
- Precedence: when a name is both stored by `connect_mcp_server` and set as `{slug}__NAME`, the process environment wins. `connect_mcp_server` and its `env` argument stay as they are.
- Slug reuse: accepted, with visibility (the names a project receives are listed at install and in `project_info`; the README states the risk). No repository pin.
- HAT: an optional guided leg is included.
- Documentation (raised by the operator): there are now two ways to give a server its environment. The docs must say that an agent passing values in a tool call is generally unsafe, because they end up in the transcript, unless the agentic system has proper secrets management that injects the value at run time outside the agent's session.
**Impact**: DD4, DD8, DD9 and the leg list of the flight spec.

### Design review, cycle 1, 2026-11-15
**Context**: The Architect reviewed the first draft of the spec against the code: approve with changes. It confirmed the four launch sites and the other statements marked read, and ran the unit suite (270 passed, 14 skipped).
**Decision**: Taken into the spec:
- DD7 was too narrow. Text chosen by a proxied server is also stored in the registry (tool descriptions and schemas, the first line of a start-up error as a warning) and logged (stderr tails in error messages), not only returned. DD7 now says so and puts two options to the operator.
- `refresh_mcp` runs only on `ready` projects; an `installing` project is refused even when another process runs the install; the error flag is "no proxied tool published, or a server failed", because a registered server that fails stays recorded.
- The catalog and session caches each have a stated contract; the shared-registry effect is described in both directions.
- The matching rule states its tie-break (ownership by longest slug first, validity second).
- Verification gained checks for the two constraints that had none (MCP server processes only; never on a command line) and a third control, for the longest-slug rule.
- Probe exposure is stated as it is: probes run with the sandbox's current network setting, and a hinted repository's commands are run bare.
- The single implementation leg was split in two, the secrets-handling core first.
- The second Docker case was spiked before the second review (see Planning Notes) and is now measured.
**Impact**: One open question remains for the operator (DD7). Not taken: stripping prefixed variables from the Docker client's environment (existing behavior, now documented), and a progress callback for `refresh_mcp`.

### Design review, cycle 2, 2026-11-15
**Context**: Second and last Architect pass, on the revised spec: approve with changes, nothing blocking. It confirmed the first cycle's findings as resolved and the timing figures as matching the spike.
**Decision**: Taken into the spec:
- Three statements by the Flight Director were worded beyond their evidence and are corrected. DD7 said a server's start-up error reaches the registry; stderr does not (discovery keeps only an error's first line, and stderr comes after a line break), only a protocol error message or a tool description does. DD10 gave reasons the spike "worked" as if measured; they are now marked inferred. DD5 described the spike's sandbox as one command plus a server; it had two commands.
- `refresh_mcp` gets a structured outcome from `Installer`, since a failure exists today only as a warning string. The error flag is: a registered server did not start, a server published before is gone, or no proxied tool is published. A candidate that did not answer is reported and is not an error.
- The guard is "status `ready` and no install job in this process".
- The write race between a discovery and a reinstall, which `discover_tools` has today, is named and accepted.
- Verification: absence checks are paired with presence checks in the same test; DD4's precedence and DD6's overridden marker have a check; the test that documents DD7's limit covers both the stderr and the protocol channel; the registry-file test is split across the two legs.
**Impact**: The review cap of two cycles is reached. These revisions are corrections and added specification, not a changed decision; they go to the operator without a third pass.

### Charter criterion 3 reworded, 2026-11-15
**Context**: Design review showed the criterion as agreed ("proxied values never appear in `registry.json`, in the output of any tool, or in logs") is false for a server that prints its own key: that text is returned, logged, and its first line stored in the registry as a warning.
**Decision**: The operator chose to narrow the promise to what mcp-everything writes on its own account, with the rest documented as a limit and pinned by a test. Best-effort replacement of values in server text was offered and not taken.
**Impact**: Criterion 3 and DD7 of the flight spec. `src/proxy/mcp-proxy.ts` is not expected to change. Replacement of echoed values remains a candidate for a later sortie.

### Accepted debt: a server can echo its variables
**Context**: DD7.
**Decision**: Accepted by the operator on 2026-11-15. A value a server prints can end up in the registry's warnings and the diagnostics log.
**Impact**: Must be stated in the README's security section.

### Accepted debt: variables bind to a slug
**Context**: A different repository installed later under the same slug receives the variables set for that slug (DD8).
**Decision**: Accepted by the operator on 2026-11-15, mitigated by visibility only.
**Impact**: Must be stated in the README. A pin of variables to a repository would be a new sortie.

---

## Deviations

*(none yet)*

---

## Anomalies

*(none yet)*

---

## Planning Notes

Facts gathered before design, each with where it comes from. **Measured** means observed by running something; **read** means taken from the code at `main` (`5a3fedb`), with the location.

- **Measured**: a slug can contain `__`. Calling `makeSlug("abc-defghij-klmnop", "owner2", taken)` when `abc_defghij_klmnop` is already taken returns `abc_defghij__owner` (run against `dist/toolgen/naming.js`, built after the last change to `src/toolgen/naming.ts`). The cause is `base.slice(0, 12)` ending in `_` before `_` and the owner are appended. So a variable name cannot be split into slug and name by its first `__`; matching has to start from a known slug.
- **Read**: `App.findGenerated` in `src/server.ts` does split a tool name on its first `__` to find the project. For a slug like the one above, that lookup fails. This is an existing defect, outside this sortie's charter.
- **Measured**: Node v22.22.0 on Linux exposes a variable named `mcp_booking__API_KEY` in `process.env` under exactly that name.
- **Read**: the environment of a running process cannot be changed from outside it, so "set after the install" means the client restarts or reconnects mcp-everything with new configuration. Proxied servers do not outlive that: `src/index.ts` closes every session on shutdown.
- **Read**: the tool catalog is persisted in the registry at discovery time (`Installer.discover`, `src/install/installer.ts`). A detected server that fails its handshake at install is not recorded in `mcpServers` at all, only as a warning. A new process therefore does not find it again by itself.
- **Read**: every launch of a proxied server goes through `McpProxy.listTools` or `McpProxy.callTool` (`src/proxy/mcp-proxy.ts`), called from four places: `App.callGenerated` in `src/server.ts`, and `Installer.connectMcp` and two calls in `Installer.discoverMcp`.
- **Read**: a session is keyed by a hash of the launch spec, environment values included (`McpProxy.key`), so a launch with a different environment never reuses an older process.
- **Read**: a server's environment reaches Docker through a private file passed as `--env-file` and removed after the handshake (`dockerConnector`). `validateEnv` rejects names that are not identifiers and values containing line breaks.
- **Read**: at install, discovery (and with it every MCP probe) runs after the network policy the caller asked for has been applied (`Installer.install`: `setNetwork` precedes `discover`). Probes are offline unless the install was called with `network: true`.
- **Read**: `project_info` prints the names of a server's stored environment and never the values (`App.describe`).
- **Read**: `discover_tools` (`Installer.rediscover`) re-runs the whole of discovery, MCP probing included, but does not stop sessions that are already open.

### Env-file probe, 2026-11-15
One throwaway container, removed afterwards. Image `buildpack-deps:stable` (`sha256:188a9dfa5e81…`), Docker 29.8.2, started with `--cap-drop ALL`, the six capabilities the sandbox adds back, and `no-new-privileges`. One run of each observation; nothing here was repeated.

- **Measured**: `docker exec --env-file` passes values exactly as written. A file line `TRICKY= lead a=b#c "q" 's' $HOME \n tail ` (leading and trailing space, a literal backslash-n) arrived in the process as that same string, unquoted and unexpanded.
- **Measured**: a line `EMPTY=` arrives as a variable that is set and empty.
- **Measured**: a lower-case name containing `__` (`mcp_x__Y`) is accepted and arrives under that name.
- **Measured**: a second `docker exec` into the same container, as the same user (uid 0), read the first process's variables from `/proc/<pid>/environ`.
- **Measured**: a later `docker exec` without the env file does not have the variables.

### Slug probe, 2026-11-15
Run against `dist/toolgen/naming.js`, Node v22.22.0, one call each. All three places where `makeSlug` appends `_` to a sliced string can produce `__`:
- **Measured**: `makeSlug("abc-defghij-klmnop", "owner2", taken)` with `abc_defghij_klmnop` taken returns `abc_defghij__owner`.
- **Measured**: `makeSlug("cli", "abcdefghijk-lm", () => false)` returns `abcdefghijk__cli`.
- **Measured**: `makeSlug("abcdefghijklm-nop", "owner", taken)` with `abcdefghijklm_nop` and `abcdefghijkl_owner` taken returns `abcdefghijklm__2`.

Logged as squawk 0008 (open, routine), together with the lookup in `App.findGenerated` that such a slug breaks.

### Discovery spike for the second Docker case, 2026-11-15
One run, against the `dist` build, which predates the merge of pull request #3; that merge changed only comment lines in `src/` (checked with `git diff`). Throwaway data directory and name prefix; `tomnomnom/gron` installed as the Docker suite does; the project was uninstalled afterwards and no container or volume was left. A flag file stood in for the variable, since `main` has no passthrough yet.

- **Measured**: install took 16.6 s.
- **Measured**: after placing an executable shell script at `/opt/mcpe/bin/gated` and `{"mcpServers":{"gated":{"command":"gated"}}}` at `/workspace/repo/.mcp.json`, `discover_tools` with the script refusing to start took 1275 ms. Result: commands `gron` and `gated`; no MCP server; tools `gron__gron` and `gron__gated`; the warning "none of these completed an MCP handshake: `gated` (… did not start: MCP error -32000: Connection closed)".
- **Measured**: after creating the flag file, `discover_tools` took 1153 ms. Result: server `gated` recorded as detected; tools `gron__whoami` and `gron__gron`; `gron__gated` gone.
- **Measured**: the proxied tool answered in 38 ms and `gron__gron` still worked.
- The script exits with status 2 when given any argument and with status 1 without the flag. Neither was varied.
- **Not measured**: the recipe with a real variable; its effect on the Docker cases that follow it; repeat runs.

### Baseline, 2026-11-15
- **Measured** on `main` (`5a3fedb`), Node v22.22.0: `npm test` 15 files passed and 1 skipped, 270 tests passed and 14 skipped, 1.65 s; `npm run typecheck` clean. The Docker suite was not run at planning; its 141.6 s figure is from sortie 02's debrief.

---

## Session Notes

- 2026-11-15: sortie qualified and chartered. Planning started from `main` after pull request #3 merged.
- 2026-11-15: spec approved by the operator and set to `ready`. Planning artifacts and squawk 0008 are uncommitted in the working tree on `main` at this point.
