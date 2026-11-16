# Leg: host-env-passthrough

**Status**: completed
**Flight**: [MCP Env Passthrough](../flight.md)

## Objective
Every launch of a project's proxied MCP server carries the variables named `{slug}__{NAME}` in the mcp-everything environment as `NAME`, merged in memory at launch and never stored, and `project_info` shows their names.

## Context
- The flight spec's design decisions are the source of truth; this leg implements DD1 (matching), DD2 (where the merge happens), DD3 (which launches), DD4 (the environment wins over a stored value) and the `describe` part of DD6. Read those five in [flight.md](../flight.md) before starting. Where this leg and the spec seem to differ, stop and report; do not pick one.
- This is the part of the flight that handles secrets. `refresh_mcp`, the warning and description wording, and the README belong to the second leg and are **not** part of this one.
- Nothing has been implemented yet; there is no prior leg.
- A slug can contain `__` (flight log, Slug probe). Tools of such a project cannot be called by name today ([squawk 0008](../../../squawks/0008-tools-of-slugs-containing-double-underscore.md)), which is not this leg's to fix. Tests of the two-slug case therefore call the matching function or the `Installer` method directly, never a tool by name.

## Inputs
- Branch `sortie/03-mcp-env-passthrough`, based on `main` at `5a3fedb`. The only uncommitted files are this sortie's artifacts and squawk 0008.
- `npm test`: 270 passed, 14 skipped. `npm run typecheck`: clean.
- Docker 29.8.2 is available for the one Docker case.

## Outputs
- A new pure module under `src/proxy/` with the matching function and its unit tests in a new test file.
- `Installer` takes an environment object and has the one method that turns a stored `McpServerSpec` into the spec to launch. `App` takes the environment object through `AppOptions` and passes it on.
- All four launch sites use that method.
- `App.describe` shows the names a project receives.
- New unit tests in `test/server.test.ts`, `test/installer.test.ts` and `test/proxy.test.ts`; one new case in `test/integration/docker.test.ts`.
- A flight log entry with the three controls' results.

## Acceptance Criteria

Matching (DD1):
- [x] A pure function takes a slug, the slugs of all projects in the registry, and an environment object, and returns the project's variables as unprefixed name to value. It reads nothing but its arguments.
- [x] For slug `mcp_booking` and environment `{ mcp_booking__API_KEY: "x" }` it returns `{ API_KEY: "x" }`.
- [x] The match is exact and case-sensitive: `MCP_BOOKING__API_KEY`, `mcp_booking_API_KEY` (one underscore) and `xmcp_booking__API_KEY` return nothing for `mcp_booking`.
- [x] A variable is owned by the project with the longest slug `s` among the given slugs such that its name starts with `s__`; only the owner can receive it. With slugs `a` and `a__b`: `a__b__KEY` is returned for `a__b` as `KEY` and not for `a`; with only `a` given, it is returned for `a` as `b__KEY`. The test gives the two slugs in both orders (`[a, a__b]` and `[a__b, a]`) and the result is the same.
- [x] A variable whose remainder after the owner's prefix is not a valid name (empty, or not matching the existing `ENV_NAME` pattern of `src/proxy/mcp-proxy.ts`) is returned for nobody: with slugs `a` and `a__b`, `a__b__` is returned for neither, and it does not make either project's computation throw even when its value contains a line break.
- [x] An empty value is returned as an empty string, not dropped. A variable whose value is `undefined` in the environment object is ignored.
- [x] A value containing a carriage return, a line feed or a NUL, in a variable the project owns with a valid name, makes the function that computes launch variables throw a plain `Error`. The module builds the message itself: it contains the full prefixed variable name and does not contain the value.

Merge at launch (DD2, DD3, DD4):
- [x] `AppOptions` accepts an environment object, defaulting to `process.env`; `Installer` accepts it after its existing constructor parameters (or through an options object) so that every existing `new Installer(…)` and `new App(…)` call in `src/` and `test/` compiles and behaves as before without being edited.
- [x] The object is read at each launch, not copied at construction: a variable added to the injected object after the `App` was constructed is carried by the next launch.
- [x] `Installer` has one method that returns a copy of a stored spec whose `env` is the stored `env` overlaid with the project's variables. It never mutates its argument. Ownership is decided against the slugs of every record in the registry plus the given project's own slug, so a project that is not (yet) in the registry still receives its variables.
- [x] The four launch sites pass the result of that method to the proxy and nothing else: `App.callGenerated` (`src/server.ts`), `Installer.connectMcp`, and both `listTools` calls in `Installer.discoverMcp` (`src/install/installer.ts`). No other call to `McpProxy.listTools` or `McpProxy.callTool` exists in `src/`. Each site has its own test, below, that fails if that site passes the stored spec.
- [x] Site `callGenerated`: for a project seeded directly with an MCP server and its tool (no `connect_mcp_server` first, so the call is the only launch), a proxied tool call launches exactly once, and that launch has the name and the value.
- [x] Site `connectMcp`: after `connect_mcp_server`, the first launch has the name and the value.
- [x] Site `discoverMcp`, registered servers: `discover_tools` on a project with a registered server launches it with the name and the value.
- [x] Site `discoverMcp`, candidates: after an install with detection (`test/installer.test.ts`, "MCP server detection" setup) with a matching variable injected, every launch in `FakeUpstream.launches` has it.
- [x] When the same name is stored for the server and set in the environment, the launch carries the environment's value.
- [x] What is stored is unchanged by the merge: after `connect_mcp_server` with no `env` argument, and after an install with detection, the project's `mcpServers[].env` in the registry is exactly what it would be without any variable set (`{}` in both cases).
- [x] With variables set for two projects, each project's launches carry only its own.
- [x] A project with no matching variable launches with exactly its stored environment, and existing tests in `test/proxy.test.ts`, `test/server.test.ts` and `test/installer.test.ts` pass with no edit to any existing test case.
- [x] The session is still shared: for a project with no matching variable, `connect_mcp_server` followed by a proxied tool call leaves exactly one launch and one open session; the same holds when a name is stored and set in the environment with the same value.
- [x] An unusable value (line break) for a project: a proxied tool call for it fails with the message above, which is also what reaches the `log` option, without the value; `connect_mcp_server` fails with it before any running server of the project is stopped; in discovery, a registered server stays recorded with no tools and an `MCP:` warning carrying the message, and a candidate is counted as failed with the message as the reason, the install or discovery finishing `ready` in both cases; other projects are unaffected.

Nothing written by mcp-everything (charter criterion 3, first-leg part):
- [x] In one test that also asserts the launch did carry the value: after an install with detection, `connect_mcp_server`, a proxied tool call, `discover_tools`, `project_info` and `list_projects`, the value appears neither in the bytes of `registry.json`, nor in any tool result, nor in any line passed to the `log` option of `App`. The fake upstream used does not echo values.

Constraints:
- [x] MCP server processes only: in one test, for a project that has a variable, a generated command line tool call and `sandbox_exec` produce `FakeDocker.calls` whose `argv` and `opts` (serialized) do not contain the value, while a proxied tool call for the same project launches with it.
- [x] Never on a command line: in the manner of the existing test "passes the environment through a private env file, never through argv" (`test/proxy.test.ts`), the real `dockerConnector` is given the launch spec the `Installer` method produced for a project with a variable; its arguments do not contain the value, and the env file it wrote contains `NAME=value`.

Visibility (DD6, `describe` only):
- [x] `project_info` for a project with matching variables contains each unprefixed name and makes clear they come from `{slug}__…` variables; it contains no value. This holds when the project has no MCP server yet.
- [x] A name that is both stored for a server and set in the environment is marked as overridden on that server's line.
- [x] For a project with no matching variable, the output of `project_info` and `list_projects` is byte-for-byte what it is today (the existing test "stores the environment but never prints its values" passes unedited).
- [x] `project_info` does not throw when a variable's value is unusable; it still lists the name.

Docker (one new case, in the first `describe` block of `test/integration/docker.test.ts`, after "proxies an MCP server running inside the sandbox" and before "uninstall removes the container and the volume"):
- [x] A second `App` on the same data directory and name prefix, constructed with an injected environment containing a `gron__…` variable, registers the shell MCP server with a *different* stored value for the same name; the server's tool reports the environment's value. Neither value is a substring of the other.
- [x] In that case: `registry.json` on disk does not contain the environment's value; the `tmp` directory under the data directory is empty after the call; `sandbox_exec` printing its environment through the same `App` does not show the value.
- [x] The case leaves the sandbox as it found it, also when one of its assertions fails: the disconnect and the second `App`'s shutdown run in a `finally`. The existing cases in the file are not edited. It adds at most 10 s to `npm run test:docker`.

Controls (each is a deliberate break, one at a time, then restored; for each, the one test that is meant to catch it is named in the flight log with its assertion message, whatever else fails):
- [x] Storing the launch spec: in `Installer.connectMcp`, the record is given the launch spec in place of the stored one. The registry-bytes assertion fails.
- [x] Dropping the prefix check, so that every project receives every `…__…` variable. The two-project assertion fails.
- [x] Dropping the longest-slug rule. The `a` / `a__b` assertion fails, in at least one of its two slug orders.
- [x] After each control, a checksum of every file that was edited for it equals the checksum taken before.

Suites:
- [x] `npm test` passes with no existing test case edited or removed. Its duration before and after is recorded; the flight's budget is 0.5 s added, and a larger increase is reported, not hidden.
- [x] `npm run typecheck` is clean.
- [x] `npm run test:docker` passes: the 12 existing cases, the new one, and the 2 pressure cases still skipped.

## Verification Steps
- Matching criteria: the new unit test file, one `it` or `it.each` row per rule above. `npx vitest run test/<new file> --testTimeout 20000`.
- Merge, storage, constraints and visibility criteria: named tests in `test/server.test.ts`, `test/installer.test.ts` and `test/proxy.test.ts`; `npm test`. For the launch-site criterion also `grep -n -E "proxy\.(listTools|callTool)\(" -r src` and confirm each of the four lines passes the method's result.
- "No existing test case edited": `git diff -- test/` shows only added lines inside existing files, apart from imports and shared setup that the new tests need; say in the flight log exactly which existing lines changed, if any.
- Docker criteria: `npm run test:docker` once, with the reporter's per-test durations. Record the new case's duration and the suite total. Do **not** run `npm run test:docker:pressure`.
- Controls: for each, record the file checksums before (`sha256sum`), make the one edit, run the one named test and capture its failure, restore the edit, record the checksums again.
- Timing: the `Duration` line of `npm test` before and after.

## Implementation Guidance

1. **The matching module**
   - A new file under `src/proxy/` (the name is yours; `host-env.ts` would fit). Pure functions only, no I/O, no reading of `process.env` inside.
   - Two things are needed by callers: the variables to launch with (validates values and throws on an unusable one), and the names for display (must not throw). Shape them as you see fit, with one place that decides ownership.
   - Name validity: reuse the existing `ENV_NAME` pattern in `src/proxy/mcp-proxy.ts`. Exporting that constant is fine; nothing else in that file is expected to change. Value validity: the same three characters `validateEnv` rejects.
   - Ownership before validity, as DD1 says: find the longest slug that prefixes the name; if that is not this project, the variable is not this project's, whatever the remainder looks like.

2. **The one method on `Installer`**
   - `Installer` gets the environment object (default `process.env`) and a public method, since `App.callGenerated` must call it too. It builds the slug list from `this.registry.list()`, every record whatever its status.
   - It returns `{ ...server, env: { ...server.env, ...variables } }`. The spread order is the precedence of DD4.
   - `Installer`'s fifth positional parameter is `choose`, used by `test/integration/docker.test.ts`; add the environment after it, or introduce an options object, so that no existing call site needs editing.

3. **The four launch sites**
   - `src/install/installer.ts`: `connectMcp` (the `listTools` validation launch; the record keeps `spec`, the stored one; compute the launch spec before `closeProject`, so that an unusable value fails the call before anything is stopped) and the two `listTools` calls in `discoverMcp`. In `discoverMcp` the call to the method must sit inside the existing `try` blocks, so that an unusable value becomes a warning or a failed candidate like any other launch failure, and `servers.push(spec)` keeps pushing the stored spec.
   - `src/server.ts`: `callGenerated`, where `server` is found in `project.mcpServers`.
   - Nothing in `src/proxy/mcp-proxy.ts` needs to know about any of this.

4. **`App`**
   - `AppOptions.env`, passed to `Installer`. `describe` gets the names through `Installer` so that ownership is decided in one place.
   - `describe`: keep today's server line exactly as it is when nothing is overridden. Add the names a project receives (a project-level line is the natural place, since the variables apply to all its servers and must be visible before any server exists), and mark an overridden stored name on its server line.

5. **Tests**
   - `test/helpers.ts` already gives what is needed: `FakeUpstream.launches` holds each launch's full `server.env`; the fake `whoami` tool reports the names; `FakeDocker.calls` holds every exec.
   - New tests always pass an explicit environment object to `App` or `Installer`. Do not set or read `process.env` in tests. Existing tests keep reading the real one and are left alone; they would only notice a `demo__…` or `widget__…` variable set on the machine running them. Note that in the flight log.
   - A session opened by one launch is reused by later calls with the same launch spec (`McpProxy.session`). A test that connects and then calls can therefore pass on the connect's launch alone. Where a criterion is about one site, make that site's launch the only one, or assert on the number of launches as well as on the last one.
   - Collect log lines by passing `log` in `AppOptions`.
   - For the registry bytes, read `registry.json` from the test's data directory, as the existing test "disconnect_mcp_server stops the server, forgets its secrets and removes its tools" does.
   - Use a value that cannot occur by accident in any output, for example a long random-looking string, so that "does not contain" means something.

6. **The Docker case**
   - Build the second `App` inside the case with `loadConfig` called with the same data directory, name prefix and tool timeout as the block's `beforeAll`, plus `env`. Do not change `beforeAll` or the existing cases.
   - The block's shell server reports `$GREETING`; the existing case registers it with a stored `GREETING`. Register it again under its own name through the second `App`, with a stored `GREETING` that differs from the injected `gron__GREETING`, and assert on what the tool reports.
   - Write the script file again inside the case; do not rely on the previous case having left it.

7. **Controls, then the flight log**
   - Run the three controls after everything passes. Restore by re-applying the original text, not with `git checkout` or `git stash` (new files are untracked and the working tree holds uncommitted artifacts).
   - Flight log entry: changes made, how each criterion was verified, the three controls with their failing output, the Docker durations, and anything that deviated.

Rules for this leg: do not commit; do not kill processes by pattern (`pkill`, `killall`), and remove test containers only by exact name; do not write machine usernames or absolute home paths into code, tests or artifacts.

## Edge Cases
- **A project is being installed**: its record is put in the registry before discovery starts (`Installer.install`), so its slug is in the list when its probes launch.
- **A variable named `{slug}__PATH` or similar**: passed like any other. The operator named it.
- **Two slugs, only the shorter installed**: `a__b__KEY` goes to `a` as `b__KEY`. Accepted in DD1; test it and do not "fix" it.
- **The environment object has unrelated keys with `__`** (for example `npm_config__x`): ignored unless a slug prefixes them.
- **A stored spec with the same name and the same value as the environment**: the launch env is unchanged and so is the session key; `describe` may still mark it overridden.
- **`describe` for a `failed` or `installing` project**: still lists the names; nothing is launched.

## Files Affected
- `src/proxy/<new module>.ts` - new: matching and validation
- `src/proxy/mcp-proxy.ts` - at most: export the existing `ENV_NAME` constant
- `src/install/installer.ts` - constructor parameter, the launch-spec method, three launch sites
- `src/server.ts` - `AppOptions.env`, `callGenerated`, `describe`
- `test/<new file>.test.ts` - new: matching rules
- `test/server.test.ts`, `test/installer.test.ts`, `test/proxy.test.ts` - added tests
- `test/integration/docker.test.ts` - one added case
- `sorties/03-mcp-env-passthrough/flight-log.md` - leg entry

Not in this leg: `README.md`, `META_TOOLS`, the server instructions, the discovery warnings.

## Citation Audit
Checked against the working tree on 2026-11-15 (`main` at `5a3fedb` plus uncommitted artifacts only):
- `src/proxy/mcp-proxy.ts` — `const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;` (not exported today); `validateEnv` rejects `/[\r\n\u0000]/`.
- `src/install/installer.ts` — `connectMcp`: `await this.proxy.listTools(project.container, spec);`. `discoverMcp`: `await this.proxy.listTools(record.container, server)` inside a `try`, and `await this.proxy.listTools(record.container, spec, MCP_PROBE_SEC)` inside a `try`, followed by `servers.push(spec)`. Constructor: `cfg, docker, registry, proxy, choose = chooseToolchain`. `install` calls `this.registry.put(record)` before the build.
- `src/server.ts` — `callGenerated`: `this.proxy.callTool(project.container, server, tool.mcp.tool, args, this.cfg.toolTimeoutSec)`. `describe`: the line `` `  mcp server "${s.name}" (${s.origin}): ${s.argv.join(" ")}${env}` ``. `AppOptions` has `cfg`, `log`, `docker`, `proxy`. Constructor: `new Installer(this.cfg, this.docker, this.registry, this.proxy)`.
- `test/helpers.ts` — `FakeUpstream.launches: Launch[]`; `whoami` returns `` `${launch.server.name} env=${Object.keys(launch.server.env).join(",")}` ``.
- `test/proxy.test.ts` — `it("passes the environment through a private env file, never through argv", …)`.
- `test/server.test.ts` — `it("stores the environment but never prints its values", …)`; `it("disconnect_mcp_server stops the server, forgets its secrets and removes its tools", …)`.
- `test/integration/docker.test.ts` — first block's cases in order: install, timeout kill, clone failure, "proxies an MCP server running inside the sandbox", "uninstall removes the container and the volume"; `new Installer(cfg, docker, registry, new McpProxy(cfg, docker), () => ({…` passes `choose` as the fifth argument.
- `grep -n -E "proxy\.(listTools|callTool)\(" -r src` returns exactly four lines.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
