# Sortie: Serve the 2026-07-28 Protocol

**Status**: in-flight

## Charter

> **Agreed with the operator on 2026-11-16.** Criterion 3 was reworded with the operator's agreement on 2026-11-17, after the Architect's first review. Sortie 04 was escalated into mission 02, so this is sortie 05.

### Outcome
A client that speaks the `2026-07-28` MCP revision is served in that revision by mcp-everything, and a client that speaks a 2025 revision works as it does today.

### Why Now
The operator saw mcp-everything reporting a 2025 protocol to a client that supports `2026-07-28`. mcp-everything is built on the v1 SDK (`@modelcontextprotocol/sdk`), whose newest release, `1.32.2`, ends at `2025-11-25`; the `2026-07-28` revision is implemented only by the v2 packages.

### Success Criteria
- [ ] A client that opens in `2026-07-28` connects, lists tools and calls a tool, and the connection is in that revision.
- [ ] A client that opens with the 2025 handshake negotiates `2025-11-25`, and the existing test suite passes.
- [ ] After an install or an uninstall, a connected 2025 client, and a `2026-07-28` client that has subscribed to tool-list changes, is told that the tool list changed.
  - *As first agreed: "a connected client learns that the tool list changed, in both revisions." In `2026-07-28` a client is told only if it subscribed (DD4, **measured**), so that wording could not hold for a client that does not.*
- [ ] Connected from the operator's GleepGlorp client, which supports `2026-07-28`, mcp-everything is served in `2026-07-28`. *(HAT leg.)*

### Constraints
- Tool names, tool inputs and the `<slug>__<NAME>` variables do not change.
- The Node floor stays at `>=22.12`.
- **The proxy side is out.** mcp-everything keeps opening sandboxed MCP servers with the 2025 handshake. *(Operator's decision at the charter gate, 2026-11-16. Negotiating `2026-07-28` with a sandboxed server needs a probe that starts the server a second time, which touches the hand-off of variables and is its own cluster of decisions.)*
- Snapshot or golden-file baselines are not committed (operator's standing rule).

---

## Pre-Flight

### Objective
Replace the v1 SDK with the v2 packages and serve both protocol eras from one stdio entry point. The server side moves from one hand-connected `Server` to a factory handed to the SDK's `serveStdio`, which reads a connection's opening message and pins the connection to the 2025 handshake or to `2026-07-28`. Tool listing, tool calls, progress and tool-list-changed announcements behave the same in both. The proxy that talks to sandboxed MCP servers moves to the v2 client and keeps the 2025 handshake. Before either change, the entry point's wiring is made testable and its shutdown order is pinned. The README states which revisions are served and the proxy's limit.

### Open Questions
- [x] Does moving to the v2 packages change what is on the wire by itself? → No; DD3 (measured)
- [x] Low-level `Server` or `McpServer`? → DD2
- [x] `serveStdio` builds instances from a factory, and `App` owns one `Server` today. Who owns the instances, and who announces a changed tool list? → DD4
- [x] What does `2026-07-28` require of a `tools/list` result, and who supplies it? → DD5
- [x] Do progress and tool-list-changed work in both eras? → DD6 (measured)
- [x] How are both eras tested without a real pipe? → DD8 (measured)
- [x] How does the proxy keep its three error outcomes with v1's `McpError` gone? → DD7 (measured)
- [x] Can the entry point's shutdown skip stopping proxied servers once the SDK's transport closes itself on stdin end? → No; DD10 (measured and read)
- [x] Does the operator want a diagnostics line that names the revision of each connection? → Yes; DD9 (operator, 2026-11-17)
- [x] Criterion 3 promises more than `2026-07-28` allows for a client that does not subscribe. Reword it? → Yes; reworded in the charter (operator, 2026-11-17)
- [x] Where does GleepGlorp show the revision it negotiated? → In its UI; the operator tests by hand against a build of the sortie's branch (operator, 2026-11-17)
- [ ] Does GleepGlorp subscribe to tool-list changes in `2026-07-28`? → Not known. It does not gate the flight: the HAT leg observes it, and with criterion 3 as reworded neither answer is a failure.

### Design Decisions

Statements of fact below are marked **measured** (observed by running something during planning; the flight log has what was run, on what, and how often), **read** (taken from the code at `main`, `d0b5324`, or from the v2 packages' type declarations at `2.4.0`, with the location) or **inferred** (reasoned, not observed).

**DD1 — Depend on `@modelcontextprotocol/server` and `@modelcontextprotocol/client` at `^2.4.0`; remove `@modelcontextprotocol/sdk`**
- **Read**: v1 `1.32.2` is the newest release of `@modelcontextprotocol/sdk` (npm registry, 2026-11-16) and its supported list ends at `2025-11-25`. The v2 packages declare `node >=20` and depend on `zod ^4.2.0`.
- **Measured**: the two packages install on Node 22.22.0, and a file that imports from both typechecks with TypeScript 7.0.2 under `strict` and `noUncheckedIndexedAccess`, with `skipLibCheck` off.
- No direct dependency on `@modelcontextprotocol/core`: v2 registers handlers by method string, so the schema constants the code imports today are not needed.
- Trade-off: a larger install. **Measured**: `node_modules/@modelcontextprotocol` is 6.3 MB with v1 and 16 MB with the two v2 packages and `core`.
- Whether the Developer uses the SDK's codemod (`@modelcontextprotocol/codemod`, **read**: it exists at `2.4.0`) or edits by hand is the Developer's choice: six source and test files, `package.json` and the lock file. The result is reviewed the same either way.

**DD2 — Keep the low-level `Server`**
- **Read**: the tool list comes from the registry at each request (`src/server.ts:373`), and tools appear and disappear while the process runs. `McpServer` registers tools ahead of time and answers unknown tool names itself.
- **Measured**: the v2 package still exports `Server`; `setRequestHandler("tools/list", …)` and `setRequestHandler("tools/call", …)` take the method name where v1 took a schema; the handler's second argument is a context whose `mcpReq.notify` replaces `extra.sendNotification`. What an unknown tool name returns stays the handler's decision (an `isError` result in the spike, in both eras). **Measured**: a handler that throws a plain `Error` reaches a v2 client as a `ProtocolError` with code `-32603` and the thrown message; the test double for a sandboxed server relies on a throw (`test/helpers.ts`, `fakeUpstream`).

**DD3 — Two steps: the package move changes nothing on the wire; serving `2026-07-28` is a separate opt-in**
- **Measured**: the built entry at `d0b5324` answers an `initialize` that asks for `2026-07-28` with `2025-11-25`. This reproduces the operator's report.
- **Read** (v2 support guide, through a fetched page that was read in part): a v2 `Server` connected by hand to a `StdioServerTransport` serves only the 2025 handshake.
- **Measured**: a v2 `Server` behind `serveStdio(factory)` with no options answers a 2025 `initialize` with `2025-11-25`, answers `server/discover` with `supportedVersions: ["2026-07-28"]`, and serves a first request that carries the `2026-07-28` envelope with no `server/discover` before it. An `initialize` that asks for `2026-07-28` is answered `2025-11-25`: the new revision has no `initialize`, and is entered only by the new opening.
- So leg 1 moves packages and keeps the hand connection, and its proof is that nothing a client can observe changed: the same answers on the wire, and the same text in tool results (DD7). Inside the process one thing does change in leg 1, which DD10 covers. Leg 2 switches the entry point to `serveStdio`.
- `legacy` stays at its default, `"serve"`. `"reject"` would break criterion 2.

**DD4 — `App` gives out servers from a factory, tracks the live ones, and announces through one method**
- **Read**: `App` constructs one `Server` in its constructor and exposes it as `app.server` (`src/server.ts:349`, `:368`). `src/index.ts:13` connects it; eight sites in `src/server.ts` call `this.server.sendToolListChanged()` (`:419`, `:733`, `:853`, `:917`, `:946`, `:963`, `:988`, `:996`).
- **Measured**: `serveStdio` calls the factory once for a connection. When a client sends `server/discover` and then falls back to `initialize` on the same connection, the factory is called a second time with `era: "legacy"`, and the first instance's `onclose` fires before that. After a `2026-07-28` opening, an `initialize` on the same connection is refused with `-32022`. An `onclose` that the factory assigned to the instance is what fired in those runs, so `serveStdio` does not replace it; that assignment is the removal hook below.
- The states an instance can be in, and what an announcement does in each:

  | State | How it is reached | An announcement |
  |-------|-------------------|-----------------|
  | none built | before the first message | does nothing |
  | pinned to the 2025 handshake | `initialize` | **measured**: `notifications/tools/list_changed` is written unasked |
  | pinned to `2026-07-28`, no subscription | an enveloped request or `server/discover` | **measured**: resolves and writes nothing |
  | pinned to `2026-07-28`, subscribed | `subscriptions/listen` with `toolsListChanged: true` | **measured**: the notification is written, carrying the subscription's id |
  | closed | the client hung up, or a probe instance was discarded | not reached: the instance is removed from the set when it closes |

- `App` gains a method that builds a `Server` with the two handlers and adds it to a set, removing it on close; and one method that announces a changed tool list to every instance in the set, swallowing failures as the eight sites do today. Both the removal and the swallowing are needed: an announcement can reach an instance that is closing. The eight sites call the announcing method through `this`, so a test can replace it as `test/server.test.ts:961` replaces `a.server.sendToolListChanged` today. `app.server` goes away, in leg 2; leg 1 keeps it.
- What the instances share. **Read**: the two handlers keep nothing between requests (`src/server.ts:373-393`); the progress callback is made per call and captures that call's context. Everything else is per `App` and already shared by every caller: the registry, the proxy, the watcher (`:417-423`) and the map of install jobs. An install job keeps the progress callback of the call that started it (`:728`), so if that call's connection has closed, the job's progress goes nowhere and its failure is swallowed; a later call that finds the job running gets the job's log through `project_info`, not progress. That is how one connection behaves today when a call is abandoned, and it is not changed. **Read**: `this.server` appears in `src/server.ts` at the construction (`:368`), the two handler registrations (`:373`, `:374`) and the eight announcing sites, and nowhere else; outside it, `app.server` is read only at `src/index.ts:13` and `:17`. **Inferred** from that: nothing else in `App` assumes one server.
- Trade-off: tests that reach for `app.server` change (**read**: `test/server.test.ts:574`, `:961`, `:1118`; these are the only reads outside `src/index.ts:13` and `:17`).

**DD5 — Tool listings are served as not cacheable**
- **Read** (spec changelog for `2026-07-28`, fetched and read in full by a subagent): a `tools/list` result must carry `ttlMs` and `cacheScope`.
- **Measured**: with a handler that returns only `{ tools }`, the SDK writes `resultType: "complete"`, `ttlMs: 0`, `cacheScope: "private"` and the server's identity in `_meta` on a `2026-07-28` connection, and writes only `{ tools }` on a 2025 connection.
- The SDK's defaults are kept as they are; no cache hint is configured.
- Source of truth: the registry file. **Read**: `tools/list` is answered from the registry's in-memory copy (`App.listTools`, `src/server.ts:446`; `Registry.list`, `src/registry.ts:182`). This process's own changes are in that copy at once. A change made by another process on the same registry reaches it when the watcher next re-reads the file, every 5 s (`src/server.ts:417-423`). So an answer can be up to 5 s behind another process's change. That is so today and is not changed.
- `ttlMs: 0` tells a client to add no staleness of its own. A longer value would let a `2026-07-28` client that has not subscribed keep a list that an install has since changed, with nothing to tell it.
- Trade-off: a `2026-07-28` client that honors `ttlMs` asks again whenever it needs the list. That is what every client does today.

**DD6 — Progress and instructions need no era-specific code**
- **Measured**: the progress token is at `request.params._meta.progressToken` in both eras, and notifications sent with `ctx.mcpReq.notify` are on the wire before the result in both.
- **Measured**: the server's instructions are in the `initialize` result and in the `server/discover` result.
- **Measured**, one run, and not relied on: the v2 client's `onprogress` callback received one of two progress notifications sent back to back, although both were on the wire; with 20 ms between them it received all three. No test here uses `onprogress` (**read**: search of `test/`).

**DD7 — The proxy moves to the v2 client and keeps the 2025 handshake** *(charter constraint)*
- The `Client` is constructed with no `versionNegotiation`. **Read** (`client` type declarations): the default mode is `"legacy"`, described as byte-identical to a client without the option. The `Transport` type the connector returns (`src/proxy/mcp-proxy.ts:7`, `:41`) is exported by the client package (**measured**: a type import of it compiled).
- **Read**: v1 has one error class, `McpError`, for failures the client raises itself and for errors a server sent, and the two share a code space: `ConnectionClosed` is `-32000` and `RequestTimeout` is `-32001`. v2 splits it into `SdkError` (raised locally, string codes) and `ProtocolError` (sent by the server, numeric codes).
- What the proxy does with an error today (**read**), and after the move:

  | Where | Today | With v2 |
  |-------|-------|---------|
  | Handshake (`:204`) | `McpError` with `RequestTimeout`: "no MCP handshake within N s". Anything else: the error's own text. | `SdkError` with `SdkErrorCode.RequestTimeout`: the same message. Anything else: the error's own text. |
  | `listTools` (`:303`) | One outcome: the error rises. | Unchanged. |
  | `callTool`, timed out (`:342`) | `McpError` with `RequestTimeout`: session closed, "timed out". | `SdkError` with `RequestTimeout`. |
  | `callTool`, server gone (`:347`) | `McpError` with `ConnectionClosed`, or an error that is not an `McpError`: session closed, "stopped while running", with stderr. | `SdkError` with `ConnectionClosed`, `SendFailed` or `NotConnected`, or an error that is neither `SdkError` nor `ProtocolError`. |
  | `callTool`, anything else | Any other `McpError`: "rejected the call", session kept. | Any `ProtocolError`, and any other `SdkError`. |

- **Measured**: a request that times out rejects with `SdkError`, code `SdkErrorCode.RequestTimeout`, for `connect` and for `callTool`. A server that exits during a call rejects with `SdkError`, code `SdkErrorCode.ConnectionClosed`, and the client's `onclose` fires. A call made after the server is gone rejects with a plain `Error` ("Not connected"), which is neither class and so lands in "server gone", as today. An error the server sent with code `-32000` or `-32001` rejects with `ProtocolError` carrying that code. An error answer to `initialize` rejects `connect` with `ProtocolError` carrying the server's whole message; a test relies on that text (`test/server.test.ts:1090-1100`).
- **One behavior changes, for the better.** Today a sandboxed server that answers a call with its own error `-32000` or `-32001` is taken for a closed connection or a timeout, and its session is closed. With v2 it is reported as "rejected the call" and the session is kept. Leg 1 has a test for each row of the table and one for this case, using the existing test double.
- **The text of a server's error is kept as it is today.** **Measured**: for an error a server sent, v1's message is `MCP error -32602: no such tool nope` and v2's is `no such tool nope`. The proxy passes the message into what the agent reads (`describeError`, `src/proxy/mcp-proxy.ts:158`; used at `:206` and in "rejected the call"). So the proxy writes a `ProtocolError` as `MCP error <code>: <message>`, and the agent goes on seeing the code. No test pins that prefix today (**read**: search of `src/` and `test/` for `MCP error`); leg 1 adds one. **Not measured**: the message text of v2's locally raised errors (`SdkError`), which appears after "stopped while running". That text follows v2's wording and is not pinned; tests assert on the proxy's own words.
- **Measured**: a tool result with `structuredContent` and no output schema passes through the v2 client unchanged (the `mixed` tool of `test/helpers.ts` returns one).
- **Measured**: with `stderr: "pipe"`, the v2 `StdioClientTransport` exposes `stderr` as a stream before it starts, and text the child wrote was read from it; the connector depends on that (`:133-137`).
- **Not measured**: whether the v2 client in its default mode differs from v1 in other ways the proxy can see, for example in how `listTools` pages (the proxy follows cursors itself, `:303`). The unit suite drives the proxy against the test double, and the Docker suite drives it against real servers through `docker exec`. Leg 1 needs both to pass. If Docker is not available when leg 1 is implemented, the leg is blocked; the Docker run is not waived.
- Limit, for the README: a sandboxed server that refuses the 2025 handshake cannot be proxied.

**DD8 — Both eras are tested in memory through the same entry the process uses**
- **Measured**: `serveStdio(factory, { transport })` accepts one half of an `InMemoryTransport` pair from the client package without a cast. A v2 `Client` on the other half reaches era `legacy` with no option, and era `modern` at `2026-07-28` with `versionNegotiation` set to `"auto"` or to `{ pin: "2026-07-28" }`. In each, a tool call, three progress notifications and a tool-list-changed notification arrived; in the modern era the last needs `client.listen({ toolsListChanged: true })` first.
- Act path: the test's client sends requests through the pair. Read path: `client.getNegotiatedProtocolVersion()`, `client.getProtocolEra()`, results of `listTools` and `callTool`, and a handler registered with `setNotificationHandler("notifications/tools/list_changed", …)`.
- The call that starts serving takes an optional transport, so that the process and the tests run the same code and the process differs only by using its own stdin and stdout.
- Test code that moves with the packages, beyond imports (**read**): `fakeUpstream` in `test/helpers.ts` builds v1 `Server` objects with schema-keyed handlers; `dead()` in `test/installer.test.ts:511-515` closes one half of an in-memory pair; `test/server.test.ts:1090-1100` speaks raw JSON on one half and answers `initialize` with an error; `test/server.test.ts:6` and `:571` register a notification handler by schema. Both halves of a pair must come from the same package.
- What this leaves untested by the suite: the real pipe. Leg 2 checks the built entry with raw JSON over a pipe, as planning did, from a script written out in the leg artifact so that the run can be repeated, which checks named values in the answers and keeps no recorded output to compare against, and the HAT leg checks it with the operator's client. No test starts `dist/index.js`: a test that depends on a build can pass against a stale one.

**DD9 — One diagnostics line per connection names the revision** *(confirmed by the operator, 2026-11-17)*
- mcp-everything writes one line to stderr naming the revision a connection is served in.
- Rationale: it is the only place the revision can be read without trusting a client's own display, and "which protocol is it speaking" is the question this sortie began with.
- Where the revision is read, and when the line is written. **Measured** under `serveStdio`: at the time the factory runs, `getNegotiatedProtocolVersion()` is undefined in both eras. On a 2025 connection the instance's `oninitialized` fires once the handshake is done, and the getter then returns what was negotiated (`2025-06-18` when that was asked for, `2025-11-25` otherwise). On a `2026-07-28` connection `oninitialized` does not fire, and the getter returns `2026-07-28` inside a request handler. An instance built for a `server/discover` probe and then discarded never reaches a tool request.
- So: a 2025 instance writes its line from `oninitialized`; a `2026-07-28` instance writes it when it serves its first `tools/list` or `tools/call`. Each instance writes at most one line, and a client that probes and falls back produces one line, for the revision it ended in. A connection that closes before either point writes none.
- It goes through the `log` function `App` is given, so a test reads it without capturing stderr. **Read**: `test/server.test.ts:1215` and `:1226` assert the whole of `log` with no connection made; the line is written only for a connection, so those assertions do not change.
- Trade-off: one more line of diagnostics per connection, and a flag on each instance to write it once.

**DD10 — The entry point's wiring moves into a function that can be tested, and the shutdown order is pinned before anything under it changes**
- **Read**: `src/index.ts` runs `main()` when imported, so nothing in it is tested; `test/shutdown.test.ts` covers `boundedShutdown` alone. On `stdin` end, `SIGINT` or `SIGTERM` the bounded shutdown starts a 15 s timer that is not unref'd, then awaits `app.shutdown()`, which stops the watcher and the proxied servers, then `app.server.close()` (`src/index.ts:13-25`), and exits only when that settles or the timer fires. The v1 transport does not react to stdin ending.
- **Read** (search of the built files of the v2 server and core packages): no `process.exit`, `process.kill`, `process.on` or `process.once`; no signal name; no `.unref(`. The only uses of `process` are `process.stdin` and `process.stdout`, and the stdio transport listens on its input for `data`, `end`, `close` and `error`.
- **Measured**, one run each, with a timer keeping the process alive as proxied servers would. Under `serveStdio`: when stdin ended, the pinned instance closed, the process stayed alive, the program's own `end` listener ran, and `close()` on the handle resolved, twice. With a v2 `Server` connected by hand to a v2 `StdioServerTransport`, which is leg 1's arrangement: the server's `onclose` fired in the same millisecond as the program's own `end` listener, the process stayed alive, and `server.close()` 300 ms later resolved.
- So leg 1 already changes what happens inside the process when stdin ends: the v2 transport closes the server itself, where v1's did nothing. In neither arrangement was the SDK observed to end the process or to get ahead of the stop, and the search found nothing in it that could. What the design rests on is this program's own timer: the bounded shutdown sets it in the same `end` event, and it keeps the process alive until the stop settles or the deadline passes. (The spike process that exited by itself had nothing else alive; it shows nothing about this one.)
- The wiring moves out of `main()` into a function that takes what it touches: the input stream, the signal source, `exit`, the `App`, and the function that starts serving. The handle is closed after `app.shutdown()` whether or not that rejected. Today a rejection there skips `app.server.close()`.
- The test of the order needs: a proxy double that records when `closeAll` runs and can be held open; a serving double that closes itself when the input ends; fake timers. It asserts that `closeAll` runs before `exit(0)`, that `exit` is called once, that a rejecting `closeAll` still closes the handle and exits, and that a `closeAll` that never settles exits 1 at the deadline. Because the package move already changes the transport's behavior, the extraction and this test are the first step of leg 1, written while the code is still on v1. The test passes there, after the package move, and after leg 2's switch to `serveStdio`. The serving double stands for all three; the SDK's real transport on a real stdin is covered by the pipe runs (DD8), not by this test.

### Prerequisites
- [x] The v2 packages install and typecheck on this project's Node and TypeScript (**measured**, DD1).
- [x] The unit suite passes at `d0b5324`: 833 passed, 24 skipped, 1.74 s (**measured**, one run).
- [x] Docker answers on the planning machine (**measured**: `docker info`, server 29.8.2). The Docker-gated suite needs it.
- [x] The operator's GleepGlorp client is at hand for the HAT leg and shows the negotiated revision in its UI (operator, 2026-11-17). The operator points it at a build of the sortie's branch and tests by hand.
- [ ] Whether GleepGlorp subscribes to tool-list changes in `2026-07-28` is not known. If it does not, it is not told of an install, by the revision's rule. The HAT records which; under criterion 3 as reworded, neither is a failure. *(Observed at the HAT; does not gate the flight.)*
- [ ] **Inferred, to be confirmed at the HAT; does not gate the flight** (the divert below covers it): GleepGlorp opens with `server/discover` or with an enveloped request, as the revision defines. If it asks for `2026-07-28` through `initialize`, it is answered `2025-11-25` (DD3) and no server on this SDK can meet criterion 4.

### Pre-Flight Checklist
- [x] All open questions resolved, except one that the HAT observes and that does not gate the flight
- [x] Design decisions documented
- [x] Prerequisites verified, except the two that the HAT observes
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach

**Leg 1, the package move.** In this order. First, on v1: the entry point's wiring moves out of `main()` into a testable function, and the shutdown order gets its test (DD10). Then `package.json` and the lock file drop `@modelcontextprotocol/sdk` and gain the two v2 packages. Imports move in `src/server.ts`, `src/index.ts` and `src/proxy/mcp-proxy.ts`, and in `test/helpers.ts`, `test/server.test.ts` and `test/installer.test.ts`. Handlers are registered by method name; the progress callback uses the handler context; the proxy's error handling follows DD7's table, with a test for each row, and keeps the text of a server's error. The server is still one `app.server` connected by hand to a `StdioServerTransport`, so nothing a client can observe changes. `src/install/detect.ts:71` and `src/install/recipes.ts:212` match any `@modelcontextprotocol/` dependency and are not touched.

**Leg 2, both eras.** `App` gets the factory, the set of live instances and the one announcing method (DD4); a small function starts serving through `serveStdio` and takes an optional transport (DD8); the entry uses it and closes the returned handle where it closes `app.server` today (`src/index.ts:17`). The diagnostics line is added (DD9). Tests cover criteria 1 to 3 in both eras, the client that probes and falls back, and the diagnostics line in each era and after a fallback. Last, as its own step: the README gains a section, placed before `## Configuration`, on the revisions served and how a connection's revision is chosen; the proxy's limit goes under `### Projects that are MCP servers` and `## Limitations` (**read**: all three headings exist; the README says nothing about protocol revisions today). In `.github/workflows/ci.yml` the floor and the count in its comment each rise by the number of tests the flight adds, which keeps today's margin without choosing between the comment's 831 and the 833 measured here.

**If leg 2 is too large when it is designed**, the README and CI step becomes a third autonomous leg. That is past the sortie's soft limit of two legs and a HAT, so the operator is told at that point, not afterwards.

**Shutdown.** See DD10.

**HAT leg.** The operator builds the sortie's branch (`npm run build`), points GleepGlorp at that build's `dist/index.js`, and reads the revision in GleepGlorp's UI. That reading settles criterion 4. If GleepGlorp shows the server's stderr, the diagnostics line of DD9 is read beside it, so that the client's display and the server's own account can be compared; if it does not, the comparison is skipped and said to be skipped. The operator then installs and uninstalls a project and records whether GleepGlorp's tool list follows without a reconnect. That is recorded as what was seen. It does not show whether GleepGlorp subscribes: with `ttlMs: 0` a client may simply ask again.

### Checkpoints
- [x] Leg 1: the shutdown order test passes on v1 and again after the package move; `npm ls @modelcontextprotocol/sdk` is empty; typecheck, unit suite and Docker suite pass; the built entry still answers `initialize` with `2025-11-25`
- [x] Leg 2: the shutdown order test still passes after the switch to `serveStdio`; `npm ls @modelcontextprotocol/sdk` is still empty; a pinned `2026-07-28` client and a 2025 client both list, call and hear a tool-list change, in memory; the built entry answers `server/discover` over a pipe
- [ ] HAT: against a build of the sortie's branch, GleepGlorp's UI shows `2026-07-28`; where GleepGlorp shows the server's stderr, the diagnostics line names the same revision

### Adaptation Criteria

**Divert if**:
- The v2 client, in its default mode, behaves differently from v1 against a real sandboxed server in a way that needs a decision and not a rename.
- `App` turns out to hold state that cannot be shared between the instances of one connection.
- GleepGlorp opens with `initialize`. The sortie then lands with criteria 1 to 3, and criterion 4 is reworded with the operator.

**Acceptable variations**:
- Using the codemod or not.
- The names of the new methods and of the function that starts serving.
- Test edits in leg 1 beyond imports, where v2 renamed an API a test calls, provided no assertion is weakened.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `sdk-v2-packages` - Make the entry wiring testable and pin the shutdown order; then move server, proxy and tests from `@modelcontextprotocol/sdk` to the v2 packages with nothing a client can observe changed
- [x] `serve-both-eras` - Serve through `serveStdio` from a factory; announce tool-list changes to every live instance; the diagnostics line; tests for both eras; README and CI floor
- [ ] `hat-and-alignment` - Guided HAT (human acceptance test) session with the operator's GleepGlorp client, with iterative fixes

---

## Post-Flight

### Completion Checklist
- [ ] All legs completed
- [ ] Code merged
- [ ] Tests passing
- [ ] Documentation updated

### Verification

| Criterion | How it is shown |
|-----------|-----------------|
| 1. A `2026-07-28` client connects, lists and calls | Unit suite, in memory through `serveStdio`: a client pinned to `2026-07-28` reports that revision, lists the tools and gets a tool's result. Once over a real pipe against the built entry, with raw JSON. |
| 2. A 2025 client is unchanged | Unit suite: a client with no negotiation option reports `2025-11-25`. The tests that exist at `d0b5324` pass, with edits limited to what DD4 and the v2 renames force and no assertion weakened. Docker suite passes. |
| 3. Tool-list changes reach a client in both revisions | Unit suite: after an install and after an uninstall, a 2025 client receives the notification unasked, and a `2026-07-28` client that subscribed receives it. A `2026-07-28` client that did not subscribe receives none, which the test states as the revision's rule. |
| 4. GleepGlorp | HAT leg: the operator connects GleepGlorp to a build of the sortie's branch and reads `2026-07-28` in its UI. Where GleepGlorp shows the server's stderr, the diagnostics line (DD9) is compared with it. |

**Time budgets**, set here as sortie 02's debrief asked: the new unit tests add no more than 0.5 s to a 1.74 s suite, read from the duration line of one `npm test` run before and one after. No Docker case is added; the Docker suite (about 154 s at its last recorded run) is run once by the Developer in leg 1 and once on the final tree at review.

**Not covered, and stated as such**: a client that probes with `server/discover` and falls back to `initialize` on the same connection is covered by one in-memory test of the announcement set (DD4) but not against a real client; Windows; a sandboxed server that refuses the 2025 handshake (DD7's limit, documented, not tested).
