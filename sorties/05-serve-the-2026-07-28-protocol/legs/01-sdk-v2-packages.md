# Leg: sdk-v2-packages

**Status**: completed
**Flight**: [Serve the 2026-07-28 Protocol](../flight.md)

## Objective
Make the entry point's wiring testable and pin its shutdown order, then move the server, the proxy and the tests from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, with nothing a client can observe changed.

## Context
- Flight decisions this leg implements: DD1 (the packages), DD2 (the low-level `Server`, handlers by method name), DD3's first step (the hand connection stays), DD7 (the proxy's errors), DD10 (entry wiring and shutdown order), and the parts of DD8 that concern the test doubles.
- **This leg does not serve `2026-07-28`.** No `serveStdio`, no factory, no set of instances, no diagnostics line, no README or CI change. Those are leg 2. `App` keeps one `readonly server`, and `app.server` is still what tests and the entry connect.
- The order inside the leg matters and is part of the acceptance: step 1 is done and its test run **while the code is still on v1**. Nothing is committed between steps (the flight commits once, after review), so the proof that the test passed on v1 is the Developer's run, recorded in the flight log with the command and the counts.
- Statements marked **measured** were observed by the Flight Director in a scratch directory outside the repository with the v2 packages at `2.4.0` on Node 22.22.0; the flight log has each run. They are not a substitute for the tests below. If an observation here does not hold when the Developer meets it, that is a finding to report, not something to work around.
- From earlier debriefs: for each new test, be able to name the source change that makes it fail; do not weaken an existing assertion to get a test through.

## Inputs
- Branch `sortie/05-serve-the-2026-07-28-protocol`, cut from `main` at `d0b5324`. The only changes on it are this sortie's artifacts.
- `npm test` at `d0b5324`: 833 passed, 24 skipped, 1.74 s (one run by the Flight Director, 2026-11-16).
- `package.json` depends on `@modelcontextprotocol/sdk` `^1.32.2`. `tsconfig.json` has `skipLibCheck: true` and includes `src` and `test`, so `npm run typecheck` covers the test files, the Docker suite's file among them.
- Docker answers on this machine (server 29.8.2). Four sandboxes of the operator's exist and must be the same after the Docker suite has run. Names and container ids, read on 2026-11-17: `mcpe-ha_googlehome` `665f39adfe00`, `mcpe-rea` `7b144f977711`, `mcpe-cowsay` `fd587c938d43`, `mcpe-gron` `fb6814b6904c`. The Docker suite uses its own prefix and data directory and has a guard on every removal (`mayRemove` in `test/integration/docker.test.ts`).
- Network access to the npm registry, for `npm install`.

## Outputs
- A new source module that holds the entry wiring as an exported function, and a new test file for it. `src/index.ts` reduced to composition.
- `package.json` and `package-lock.json` on the two v2 packages; `@modelcontextprotocol/sdk` gone.
- `src/server.ts`, `src/index.ts`, `src/proxy/mcp-proxy.ts`, `test/helpers.ts`, `test/server.test.ts`, `test/installer.test.ts` importing from the v2 packages.
- The proxy's error handling per DD7, with tests in `test/proxy.test.ts`.
- A flight-log entry for the leg with the runs listed under Verification Steps.

## Acceptance Criteria

**Entry wiring and shutdown order (done first, on v1)**
- [x] AC1. The wiring that `main()` in `src/index.ts` does after constructing the `App` (start serving, build the bounded shutdown, register the `end` listener on the input and the two signal listeners) lives in an exported function of a module that does nothing when imported. The function takes everything it touches as arguments: the input stream, the signal source, `exit`, the app, the function that starts serving and returns something with `close()`, the deadline, and `log`. `src/index.ts` still loads the configuration, prepares the data directory, constructs the `App`, calls `app.start()`, and calls that function with `process.stdin`, `process`, `process.exit`, and a serving function that connects `app.server` to a `StdioServerTransport` and closes `app.server`.
- [x] AC2. The order is unchanged: serving starts before the listeners are registered; on a trigger, `app.shutdown()` runs first and the serving handle is closed after it; `exit` is called after both.
- [x] AC3. The serving handle is closed after `app.shutdown()` **also when `app.shutdown()` rejected**. (Today a rejection skips `app.server.close()`: `src/index.ts`, `close: async () => { await app.shutdown(); await app.server.close(); }`.)
- [x] AC4. A new test file drives the function with: an event emitter as the input, an event emitter as the signal source, a recording `exit`, fake timers, a real `App` built on a temporary data directory with the Docker double and a proxy whose `closeAll` records when it ran and can be held open or made to reject, and a serving double. The serving double keeps two separate records: a flag `selfClosed`, which it sets itself when the input emits `end` (standing for the v2 transport), and a list of the calls made to its handle's `close()` (which only the wiring makes). The self-close is never counted as a `close()` call. It asserts each of:
  - a. after `end`, `closeAll` has run before `exit(0)` is called, and `exit` is not called while `closeAll` is held open;
  - b. `exit` is called exactly once when `end`, `SIGINT` and `SIGTERM` all arrive;
  - c. `SIGINT` alone and `SIGTERM` alone each do what `end` does;
  - d. a `closeAll` that rejects still leads to the handle's `close()` being called and to `exit(0)`;
  - e. a `closeAll` that never settles leads to `exit(1)` at the deadline and not before, with the bounded shutdown's log line;
  - f. the handle's `close()` is called after `closeAll` has settled, not before;
  - g. a to f hold with a serving double that sets `selfClosed` on `end` and with one that does not, and in the first case `selfClosed` is already true when `closeAll` starts (the double's `end` listener is registered first, as the transport's is);
  - h. when the serving function is called, the input has no `end` listener and the signal source has no `SIGINT` or `SIGTERM` listener (the double records the three `listenerCount`s at that moment); after the function resolves, each has one;
  - i. a handle whose `close()` rejects, after a `closeAll` that resolved, still leads to `exit(0)`.
- [x] AC5. The tests of AC4 pass with `@modelcontextprotocol/sdk` still installed and no v2 package present. The flight log records that run: the command, and the passed count for the file.

**The packages**
- [x] AC6. `npm ls @modelcontextprotocol/core` shows exactly one installed copy, shared by the server and client packages (the proxy tells the SDK's error classes apart with `instanceof`, which a second copy would defeat). `package.json` lists `@modelcontextprotocol/server` and `@modelcontextprotocol/client` at `^2.4.0` under `dependencies`, does not list `@modelcontextprotocol/sdk` or `@modelcontextprotocol/core`, and is otherwise unchanged (`engines.node` is still `>=22.12`; no script changes). `npm ls @modelcontextprotocol/sdk` reports nothing installed. `package-lock.json` matches (`npm ci` succeeds).
- [x] AC7. No file under `src/` or `test/` imports from `@modelcontextprotocol/sdk`. The string still appears in `test/detect.test.ts` as fixture data, and `src/install/detect.ts` and `src/install/recipes.ts` are unchanged.

**The server side**
- [x] AC8. `App` still constructs one `Server` (the low-level class, from `@modelcontextprotocol/server`) with the same name, version, capabilities and instructions, and exposes it as `app.server`. The two handlers are registered by method name (`"tools/list"`, `"tools/call"`). The progress callback sends through the handler's context (`ctx.mcpReq.notify`) with the same `method` and `params` as today, and still swallows a failed send.
- [x] AC9. The test "serves the tool list, executes calls and announces list changes" (`test/server.test.ts`, in `describe("over the MCP protocol")`) and the test "tells agents the route in the instructions and the descriptions of connect_mcp_server" (same file, in a nested describe further down) pass with a v2 `Client` and a v2 in-memory pair, with no assertion removed or loosened. A client constructed with no negotiation option reports `2025-11-25` from `getNegotiatedProtocolVersion()`; one assertion of that is added to the first of these tests.

**The proxy side (DD7)**
- [x] AC10. The proxy's `Client` is the v2 class, constructed with no `versionNegotiation` option, and `StdioClientTransport` and the `Transport` type come from the v2 client package. `dockerConnector` still passes `stderr: "pipe"` and still reads the child's stderr from `transport.stderr`.
- [x] AC11. Handshake: a `connect` that times out gives the reason `no MCP handshake within <N>s`, as today (existing test "reports a server that never completes the handshake…" passes unchanged). Any other handshake failure gives the error's own text.
- [x] AC12. `callTool` that times out: the session is closed and the error is `MCP tool "<tool>" timed out after <N>s; the server was stopped and will restart on the next call.` (existing test at "stops a server whose tool call times out…" passes unchanged).
- [x] AC13. `callTool` when the server is gone: the session is closed and the error begins `MCP server "<name>" stopped while running "<tool>": `, with the stderr tail when there is one. This is the outcome for a locally raised connection failure (v2 `SdkError` with code `ConnectionClosed`, `SendFailed` or `NotConnected`) and for any error that is neither an `SdkError` nor a `ProtocolError`. Two new tests:
  - a server that goes away during a call (the double closes its half when the call arrives). Assert the error's text and that `proxy.size` is 0 afterwards. Do **not** assert a kill: the client's `onclose` has already removed the session from the map by the time the `catch` runs, so `closeSession` returns early and issues none. That is so today and is not to be "fixed" here.
  - an error that is neither class: a connector that returns the fake upstream's client half with its `send` wrapped to throw a plain `Error("pipe broke")` when the message's method is `tools/call`. **Measured**: the v2 client rejects that call with the same plain `Error`, and `onclose` does not fire, so the session is still in the map. Assert the "stopped while running" text with `pipe broke` in it, `proxy.size` 0, one kill, and that the next call launches again.
- [x] AC14. `callTool`, anything else: the session is kept and the error is `MCP server "<name>" rejected the call to "<tool>": <text>`. This is the outcome for every `ProtocolError` and for every `SdkError` not named in AC11 to AC13. The existing test "surfaces upstream tool errors without tearing the session down" passes unchanged.
- [x] AC15. **The one changed behavior.** A server that answers `tools/call` with its own error of code `-32000`, and one that answers with `-32001`, is reported as "rejected the call" and its session is kept: the next call on the same server reaches the same launch. A new test covers each code, with a raw in-memory double (as `test/server.test.ts` builds one for `initialize`), and checks the number of launches.
- [x] AC16. **The text of a server's error is as it is today.** Wherever the proxy puts an error's text into a message (`describeError`, and the "rejected the call" line), an error the server sent is written `MCP error <code>: <message>`, which is what v1 put in `message`. A new test asserts the exact text for a rejected call (`MCP server "srv" rejected the call to "nope": MCP error -32603: no such tool nope`, if `-32603` is the code the double's throw produces; assert the code the run shows and say so in the flight log) and for a handshake refused with an error (the existing test "documents a limit: a server that puts its variable in a protocol error…" passes unchanged, and one assertion is added there or beside it for the `MCP error -32000: ` prefix in the tool result).
- [x] AC17. `listTools` has one outcome, as today: the session is closed and the error is `MCP server "<name>" failed to list its tools: <text>`. A new test covers it with a server-sent error and asserts the text, prefix included.
- [x] AC18. The text of an error the client raised itself is whatever v2 gives it, and no test pins it beyond the proxy's own words. (**Measured**: v2 gives `Request timed out`, `Connection closed`, `Not connected`; v1 gave `MCP error -32001: Request timed out` and `MCP error -32000: Connection closed`. The prefix is deliberately not restored for these: no server sent them.) The flight log records this as the one difference in tool-result text that the leg makes.

**Nothing else changed**
- [x] AC19. `npm run typecheck`, `npm test` and `npm run build` pass. `npm test` passes no fewer than 833 tests plus the tests this leg adds, and skips 24. No test that existed at `d0b5324` is deleted, skipped or has an assertion weakened; an edit to an existing test is limited to imports, to the v2 name of an API the test calls, and to the additions named above.
- [x] AC20. `npm run test:docker` passes, run once. Afterwards the operator's four sandboxes have the names and container ids listed under Inputs. If Docker does not answer, the leg is blocked: signal `[BLOCKED:docker-unavailable]`; do not land without the run.
- [x] AC21. Before the package move and again after it, each time after a fresh `npm run build`: the built entry, given an `initialize` that asks for `2026-07-28`, answers `protocolVersion: "2025-11-25"`; given `initialize` at `2025-11-25`, `notifications/initialized` and `tools/list`, it answers with the built-in tools; and it exits 0 when its stdin closes. Run with `MCPE_DATA_DIR` set to a new temporary directory (check `src/config.ts` for the variable's exact name), never the operator's own data directory. The two runs' answers are the same; both are recorded in the flight log.
- [x] AC22. The duration line of `npm test` is recorded in the flight log from three runs before the leg's first change and three after its last. The flight's budget for new unit tests is 0.5 s over both legs; one run's noise is of that order, so the figures are indicative and the three are reported as they are, not averaged into a verdict.

## Verification Steps
- AC1 to AC3: read the new module and `src/index.ts`; `git diff main -- src/index.ts`.
- AC4, AC5: before touching `package.json`, `timeout 120 npx vitest run <the new test file>`; record the output's counts. For each of a to g, name in the flight log the edit to the new module that makes it fail (for AC3/d: awaiting `shutdown()` and `close()` in sequence without a `finally`).
- AC6, AC7: `npm ls @modelcontextprotocol/sdk`; `npm ls @modelcontextprotocol/core`; `npm ci` in a clean state, or `npm ls` with no errors; `grep -rn "@modelcontextprotocol/sdk" src test`; `git diff main -- package.json`.
- AC8 to AC18: `timeout 120 npm test`; read the diff of `test/`.
- AC19: `npm run typecheck && timeout 120 npm test && npm run build`; `git diff main --stat -- test` and a read of every changed line in a test that existed before.
- AC20: `docker ps -a --format '{{.Names}} {{.ID}}' | grep mcpe-` before and after; `timeout 900 npm run test:docker`.
- AC21: after `npm run build`, pipe the messages into `node dist/index.js` with the temporary data directory and read stdout; `echo $?`.
- AC22: the `Duration` line of three `npm test` runs before and three after.

## Implementation Guidance

1. **Record the baseline.** `npm test` three times (counts and duration), the four container ids, and, after `npm run build`, the pipe check of AC21 on the code as it is (`dist/` may be stale before the build). Set the leg's status to `in-flight`.

2. **Extract the entry wiring, on v1.**
   - A new module (suggested: `src/entry.ts`, exporting one function; the names are the Developer's). It imports `boundedShutdown` from `src/shutdown.ts` and nothing from the SDK. Its app argument can be typed as the part of `App` it uses (`shutdown(): Promise<void>`); its serving argument as `() => Promise<{ close(): Promise<void> }>`.
   - The close passed to `boundedShutdown` is `app.shutdown()` followed, in a `finally`, by the handle's `close()`. `boundedShutdown` already exits 0 when its `close` rejects, so a rejection from either still ends in `exit(0)`.
   - `src/index.ts` keeps its `main().catch(...)` and its two `process.stderr.write` log functions. It must stay free of anything worth testing.
   - Write the test file (suggested: `test/entry.test.ts`). `test/shutdown.test.ts` shows the fake-timer pattern for `boundedShutdown`; `test/server.test.ts` shows how an `App` is built on a temporary directory with `FakeDocker` and a replaced proxy. `App.shutdown()` is `this.stop(); await this.proxy.closeAll();`.
   - The proxy double: subclass `McpProxy` and override `closeAll`, or spy on it. A test that holds `closeAll` open must release it in its own cleanup, and one that makes it reject must restore it, because the file's cleanup will call `app.shutdown()` like `test/server.test.ts` does. Nothing in `App` starts a timer before `start()`, and the wiring function does not need `start()` to have been called.
   - Run it. Record the run. Only then go on.

3. **Move the packages.** `npm uninstall --ignore-scripts @modelcontextprotocol/sdk` and `npm install --ignore-scripts @modelcontextprotocol/server@^2.4.0 @modelcontextprotocol/client@^2.4.0`. `package.json` has `"prepare": "npm run build"`, and `src/` does not compile between these two commands and the edits of steps 4 to 6, so the scripts are skipped here. `npm ci` at the end runs `prepare` on the finished tree and must pass. The SDK's codemod (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`) may be used or not; if it is, read every line it changed, and revert anything it changed outside the six files and `package.json`.

4. **Server side** (`src/server.ts`, `src/index.ts`).
   - `Server` from `@modelcontextprotocol/server`; `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. The `CallToolResult` type is used in `src/server.ts`; find where v2 exports it (the server package re-exports the protocol types) and keep the import type-only.
   - **Measured**: `server.setRequestHandler("tools/list", async () => ({ tools }))` and `server.setRequestHandler("tools/call", async (request, ctx) => …)`; the progress token is at `request.params._meta?.progressToken`; `ctx.mcpReq.notify({ method: "notifications/progress", params })` returns a promise. `sendToolListChanged()`, `connect(transport)`, `close()`, `onclose` exist on the v2 `Server`.
   - The eight `this.server.sendToolListChanged()` sites do not change in this leg.

5. **Proxy side** (`src/proxy/mcp-proxy.ts`).
   - `Client`, type `Transport`, `SdkError`, `SdkErrorCode`, `ProtocolError` from `@modelcontextprotocol/client`; `StdioClientTransport` from `@modelcontextprotocol/client/stdio`.
   - **Measured**: v2's `callTool` takes `(params, options)`; v1's took `(params, resultSchema, options)`, and the proxy passes `undefined` in the middle today. `listTools(params, options)` and `connect(transport, { timeout })` kept their shapes.
   - **Measured** error shapes: a timed-out request rejects with `SdkError` whose `code` equals `SdkErrorCode.RequestTimeout`, for `connect`, `callTool` and `listTools`; a server that goes away mid-call rejects with `SdkError`, `SdkErrorCode.ConnectionClosed`, and `client.onclose` fires; a call after that rejects with a plain `Error("Not connected")`; an error the server sent rejects with `ProtocolError` whose numeric `code` and bare `message` are the server's; an error answer to `initialize` rejects `connect` with `ProtocolError` too.
   - Check the names `SdkErrorCode.SendFailed` and `SdkErrorCode.NotConnected` against the package's type declarations before using them. If a name differs or is missing, use what the declarations have, and record it.
   - Give `describeError` the one place that renders a `ProtocolError` as `MCP error <code>: <message>`, and make the "rejected the call" line use it (it reads `e.message` directly today).
   - The decision in `callTool` reads best as three questions in order: timed out? gone (the three `SdkError` codes, or neither class)? otherwise rejected.

6. **Tests that move** (`test/helpers.ts`, `test/server.test.ts`, `test/installer.test.ts`).
   - `fakeUpstream` builds a v1 `Server` per launch with schema-keyed handlers: move to the v2 `Server` and method names. Its default branch throws a plain `Error`; **measured**: a v2 client receives that as `ProtocolError`, code `-32603`, message the thrown text. `test/proxy.test.ts` asserts `/rejected the call to "nope".*no such tool nope/`, which holds.
   - `InMemoryTransport` comes from `@modelcontextprotocol/client` (**measured**: `createLinkedPair()` exists there, and a v2 `Server` connects to one half). Both halves of a pair must come from the same package. If a half does not satisfy the `Transport` type the server package expects without a cast, report it; the Flight Director compiled this pairing without one.
   - `test/server.test.ts` registers the list-changed handler by schema: v2 takes the method name, `client.setNotificationHandler("notifications/tools/list_changed", …)`.
   - `dead()` in `test/installer.test.ts` closes one half of a pair before the client connects, and the raw double in `test/server.test.ts` answers `initialize` by hand: both should work unchanged apart from the import. If either behaves differently on v2, that is a finding.
   - The `mixed` tool returns `structuredContent` with no output schema; **measured**: the v2 client passes it through.

7. **New proxy tests** (AC13, AC15, AC16, AC17), in `test/proxy.test.ts`, beside the tests they extend. A raw double is a linked pair whose server half has `onmessage` set and `start()` called, answering `initialize` with a result and the method under test with an error.

8. **Run everything**: typecheck, unit suite, build, the pipe check of AC21, then the Docker suite once, then the container ids.

9. **Flight log**: an entry under Leg Progress in the format of `.flightops/ARTIFACTS.md`, with the runs above, the one difference of AC18, anything measured here that did not hold, and for each new test the source change that makes it fail. Set the leg's status to `landed`. Do not commit.

## Edge Cases
- **`end` arrives twice, or `end` and a signal together**: `boundedShutdown` runs `close` once; AC4b.
- **The handle is already closed when the shutdown closes it**: with the v2 transport the server has closed itself on `end` by then (**measured**: `server.close()` afterwards resolves). The wiring must not treat a rejection there as fatal either; the bounded shutdown exits 0 on a rejected close.
- **`app.shutdown()` rejects and `close()` rejects too**: the first rejection is what `boundedShutdown` sees; either way exit 0. Not worth a separate branch.
- **A `ProtocolError` whose code is `-32000` or `-32001`**: must not be compared against the SDK's timeout or closed codes. Those are string codes on `SdkError` now; the classes are checked, not the numbers.
- **An `SdkError` with a code this leg does not name** (for example a capability error): lands in "rejected the call", session kept, per DD7's table.
- **`client.close()` on a client whose `connect` failed**: `attempt` already swallows its failure; keep that.
- **The codemod rewriting `test/detect.test.ts`'s fixture strings or `src/install/*`**: revert; those are data about other projects.
- **`npm install` pulling a v2 release newer than `2.4.0`**: the range allows it. Record the installed versions in the flight log. If a measured behavior differs on the newer release, report it.

## Files Affected
- `src/entry.ts` *(new; name is the Developer's)* - the entry wiring
- `src/index.ts` - composition only; v2 transport import
- `src/server.ts` - v2 `Server`, handlers by method name, progress through the context
- `src/proxy/mcp-proxy.ts` - v2 client, error handling per DD7, error text
- `test/entry.test.ts` *(new)* - shutdown order
- `test/helpers.ts` - `fakeUpstream` on v2
- `test/server.test.ts`, `test/installer.test.ts` - imports and the v2 names of APIs they call; the added assertions
- `test/proxy.test.ts` - new tests for AC13, AC15, AC16, AC17
- `package.json`, `package-lock.json`
- `sorties/05-serve-the-2026-07-28-protocol/flight-log.md`

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.

---

## Citation Audit
2026-11-17, by the Flight Director and by the Developer's design review, against the branch at `d0b5324`. Citations here are by symbol or quoted text, not by line. Checked and found as quoted: the `close` in `src/index.ts`; `boundedShutdown` and `App.shutdown`; the six files that import the v1 SDK, and that no other file under `src/` or `test/` does; the four existing test names in `test/proxy.test.ts` and `test/server.test.ts`; the `/rejected the call to "nope".*no such tool nope/` assertion; `dead()` and the raw `initialize` double; `MCPE_DATA_DIR`; `describeError` and the "rejected the call" line reading `e.message`; `get size()` on `McpProxy`. One correction made: the second test of AC9 is in a nested describe, not in `describe("over the MCP protocol")`. No use of `McpError` or `ErrorCode` exists outside `src/proxy/mcp-proxy.ts`, and no test contains `MCP error`, `Connection closed` or `Request timed out`.
