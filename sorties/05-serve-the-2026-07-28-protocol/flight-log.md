# Flight Log: Serve the 2026-07-28 Protocol

**Flight**: [Serve the 2026-07-28 Protocol](flight.md)

## Summary
In flight. Both autonomous legs are completed, reviewed and committed: mcp-everything is on the v2 SDK packages and serves each connection in the revision its client opens with. The HAT leg with the operator's GleepGlorp client remains. Charter agreed 2026-11-16; criterion 3 reworded and the spec approved by the operator on 2026-11-17.

---

## Leg Progress

### sdk-v2-packages
**Status**: completed
**Started**: 2026-11-17
**Completed**: 2026-11-17

#### Changes Made
- New `src/entry.ts` (`runEntry`): starts serving, then builds the bounded shutdown (`app.shutdown()`, then, in a `finally`, the handle's `close()`) and registers the `end`, `SIGINT` and `SIGTERM` listeners. `src/index.ts` is composition only. New `test/entry.test.ts` (20 tests: 10 cases, each against a transport that closes itself on `end` and one that does not).
- `package.json` and `package-lock.json`: `@modelcontextprotocol/sdk` out; `@modelcontextprotocol/server` and `@modelcontextprotocol/client` `^2.4.0` in. Nothing else in `package.json` changed.
- `src/server.ts`: v2 `Server`, handlers by method name (`"tools/list"`, `"tools/call"`), progress through `ctx.mcpReq.notify` (failure still swallowed); `CallToolResult` and `Tool` as type-only imports from the server package. `listTools()` result is cast to `Tool[]` for the list handler (the method returns loose records).
- `src/index.ts`: `StdioServerTransport` from `@modelcontextprotocol/server/stdio`.
- `src/proxy/mcp-proxy.ts`: v2 `Client`, `StdioClientTransport`, `Transport`, `SdkError`, `SdkErrorCode`, `ProtocolError`; `callTool` loses the middle argument; `describeError` renders a `ProtocolError` as `MCP error <code>: <message>`; `callTool` decides timed out / gone (SdkError `ConnectionClosed`, `SendFailed`, `NotConnected`, or neither class) / rejected, and the "rejected" line uses `describeError`. The handshake's timeout test is `SdkError` + `RequestTimeout`.
- Tests: `test/helpers.ts` (`fakeUpstream` on the v2 `Server`, method names, `InMemoryTransport` from the client package), `test/server.test.ts` and `test/installer.test.ts` (imports; `setNotificationHandler` by method name; one added assertion of `2025-11-25` from `getNegotiatedProtocolVersion()`; one added `MCP error -32000: rejected key` assertion in the protocol-error test), `test/proxy.test.ts` (6 new tests, a `rawUpstream` double).
- Flight spec: leg-1 checkpoint ticked (the Legs-list entry is left to the Flight Director).

#### Notes
- **Baseline (measured, `d0b5324` code, v1)**: `npm test` three runs, each `833 passed | 24 skipped (857)`; Duration 1.93 s, 1.74 s, 1.74 s. Container ids before everything: `mcpe-ha_googlehome` `665f39adfe00`, `mcpe-rea` `7b144f977711`, `mcpe-cowsay` `fd587c938d43`, `mcpe-gron` `fb6814b6904c`.
- **v1 run of the entry test (measured, step 2, `@modelcontextprotocol/sdk` installed, no v2 package present, `package.json` untouched)**: `timeout 120 npx vitest run test/entry.test.ts` gave `Test Files 1 passed (1)`, `Tests 20 passed (20)`. (A first run had 2 failures from a bug in my test double, which reset its own record of listener counts; fixed in the test, no source change, then the 20 passed.)
- **Installed (measured, `npm ls`)**: `@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0` (one copy, deduped under both). `npm ls @modelcontextprotocol/sdk` prints `(empty)`. `npm ci` succeeded (it ran `prepare`, so the build passed on the finished tree) and `npm ls` was clean afterwards.
- **Names checked against the declarations (read)**: `SdkErrorCode.NotConnected`, `.SendFailed`, `.ConnectionClosed`, `.RequestTimeout` exist as the leg says (string codes). `Tool`, `CallToolResult`, `Server` come from `@modelcontextprotocol/server`; `Client`, `InMemoryTransport`, `ProtocolError`, `SdkError`, `SdkErrorCode`, `Transport` from `@modelcontextprotocol/client`. An `InMemoryTransport` pair from the client package connects to the v2 `Server` with no cast (typecheck clean).
- **Mutations of `src/entry.ts` (AC4)**. Tried (measured; each applied and undone by editing, no git checkout/restore/stash; after the last undo the file's 20 tests passed again):
  - AC3/d (closeAll rejects still closes and exits 0): replace the `try { await app.shutdown() } finally { await serving.close() }` with the two awaits in sequence, no `finally`. Fails the two "still closes the handle and exits 0 when closeAll rejects" tests.
  - a, f (order; exit not while held; close after closeAll settled): call `serving.close()` before `app.shutdown()`. 12 of 20 fail. And run both in parallel (`Promise.all`): 10 of 20 fail.
  - b (exactly one exit): build a new `boundedShutdown` on every trigger. Fails the two "exits exactly once" tests.
  - h (serving before listeners; one of each): register the three listeners before calling `serve()`. Fails the two "registers its listeners after serving has started" tests. Dropping the `SIGTERM` registration fails the `SIGTERM` tests and that same test.
  - Not tried, named (inferred): c is the same registration lines (drop the `SIGINT` line); e (exit 1 at the deadline, with the log line): ignore `deadlineMs` or not pass `log` to `boundedShutdown`; g (`selfClosed` true when `closeAll` starts): the test reads the proxy double's record at `closeAll`'s start, so it fails if the wiring registered its `end` listener before the double's, which the order of `serve()` and registration prevents; i: have the close of the handle be awaited outside `boundedShutdown`'s rejection handling.
- **Mutations of `src/proxy/mcp-proxy.ts` for the new tests (measured, applied and undone by editing)**:
  - AC13 plain-error test: change `neither || (...)` to just the `SdkError` test (no "neither class" branch). Fails that test alone.
  - AC13 gone-during-call test: leave `SdkErrorCode.ConnectionClosed` out of `GONE_CODES`. Fails that test and, as well, the existing "drops a session whose container was replaced under its name" test.
  - AC15: treat a numeric `code` of -32000 or -32001 as gone. Fails both AC15 tests, one each.
  - AC16/AC17: delete the `ProtocolError` line of `describeError`. Fails the AC16 exact-text test, both AC15 tests, the AC17 test, and the existing "documents a limit: a server that puts its variable in a protocol error" test (through the added assertion).
  - AC16: make the "rejected" line read `e.message` again. Fails the exact-text test and both AC15 tests.
  - AC9 added assertion: not mutated (inferred: fails if the client negotiated another version).
- **AC16 code (measured)**: the double's plain `throw new Error("no such tool nope")` reaches the proxy as code `-32603`; the exact text asserted is `MCP server "srv" rejected the call to "nope": MCP error -32603: no such tool nope`.
- **AC13 gone-during-call (measured)**: asserted text begins `MCP server "srv" stopped while running "add": `, then the client's own text, then `--- server stderr ---` and the double's tail. `proxy.size` 0; no kill is asserted. The plain-error test saw `pipe broke` in the text, size 0, one kill, and the next call launched again, as the leg measured.
- **AC18, the one tool-result text difference (measured by the Flight Director, read here)**: an error the client raised itself reads `Request timed out`, `Connection closed`, `Not connected` on v2, where v1 read `MCP error -32001: Request timed out` and `MCP error -32000: Connection closed`. No test pins them. (This leg's own tests only pin the proxy's words around them.)
- **AC21, the built entry over a pipe (measured, `MCPE_DATA_DIR` a fresh temporary directory each run, `npm run build` first)**: on v1, `initialize` at `2026-07-28` answered `protocolVersion: "2025-11-25"`; at `2025-11-25` then `notifications/initialized` and `tools/list` it answered the 16 built-in tools (`search_projects` ... `uninstall_project`); exit 0 on stdin closing both times. After the move to v2 (fresh build): the same, and the recorded outputs of the two runs are byte-identical (`diff` empty). Caveat: the "before" run was taken after the step-2 extraction (still on v1), not on the untouched `d0b5324` code, because I ran it after writing `src/entry.ts`; `dist/` had been built from the extracted code.
- **Docker suite (measured)**: `timeout 900 npm run test:docker` gave `Test Files 1 passed (1)`, `Tests 22 passed | 2 skipped (24)`, Duration 207.40 s (longer than the leg's 150 s guess). Containers before and after, identical: `mcpe-ha_googlehome` `665f39adfe00`, `mcpe-rea` `7b144f977711`, `mcpe-cowsay` `fd587c938d43`, `mcpe-gron` `fb6814b6904c`. No container was removed or restarted by me. The pressure suite was not run.
- **Final unit run (measured)**: `npm run typecheck` clean; `npm test` `859 passed | 24 skipped (883)` (833 + 20 entry + 6 proxy); `npm run build` clean.
- **Durations of `npm test` (measured, indicative, not averaged)**: before the first change: 1.93 s, 1.74 s, 1.74 s. After the last: 2.11 s, 1.74 s, 1.74 s. (The suite after is 26 tests larger; 20 of them are the new file.)
- **Existing tests (read of the diff)**: no deleted or skipped; edits to existing tests are imports, `fakeUpstream`'s v2 names, `setNotificationHandler` by method name, and the two added assertions.
- **Not anticipated by the leg**: (1) `listTools()` returns loose records, so v2's typed `tools/list` handler needed a cast to `Tool[]` in `src/server.ts`; `fakeUpstream`'s tool list needed a `Tool[]` annotation. (2) `runEntry`'s `deadlineMs` is optional and defaults to `SHUTDOWN_DEADLINE_MS`; `src/index.ts` passes it explicitly. (3) `npm ci` leaves `node_modules` freshly rebuilt; nothing else to report.
- Documentation that this leg may have made wrong (not edited, per the instructions): none found; the README and CI belong to leg 2.

### serve-both-eras
**Status**: completed
**Started**: 2026-11-17
**Completed**: 2026-11-17

#### Changes Made
- `src/server.ts`: `app.server` removed. `createServer()` builds a `Server` (same name, version, capabilities, instructions and the two handlers), adds it to a private `live` set and removes it in its `onclose`; `get connections()` is the set's size; `announceToolListChanged()` calls `sendToolListChanged()` on a copy of the set, each failure swallowed. The eight sites call `this.announceToolListChanged()`. One closure per instance (`noteConnection`) writes `connection: MCP protocol <revision>` once, from `getNegotiatedProtocolVersion()`, and writes nothing when that is undefined; called from `oninitialized` and at the top of both handlers.
- `src/entry.ts`: `serveApp(app, transport?)` returns `serveStdio(() => app.createServer(), transport ? { transport } : undefined)`. `legacy` and `onerror` not passed. `src/index.ts`: `serve: async () => serveApp(app)`; no `StdioServerTransport` import. (`grep -n "StdioServerTransport\|\.connect(" src -r` finds only the proxy's client connect; `grep -n sendToolListChanged src -r` finds only the announcing method.)
- `test/server.test.ts`: the two tests that connected `app.server` now call `serveApp(app, serverSide)`, connect the client, and close the handle at the end; the refresh test replaces `a.announceToolListChanged`. No assertion removed or loosened.
- New `test/serving.test.ts`: 21 tests (a raw client half for hand-sent JSON-RPC; real clients through `serveApp` over an in-memory pair).
- `README.md`: new `## Protocol revisions` immediately before `## Configuration`; a note under `### Projects that are MCP servers` and a bullet under `## Limitations`. `.github/workflows/ci.yml`: floor and comment. `flight.md`: leg-2 checkpoint ticked only.

#### Notes
- **Test counts (measured)**: before this leg's changes `859 passed | 24 skipped (883)`, Duration 1.78 s. After: `880 passed | 24 skipped (904)`: 21 new, none skipped. `npm run typecheck` clean, `npm run build` clean, `npm ls @modelcontextprotocol/sdk` prints `(empty)`.
- **`npm test` Duration, three runs after (measured, indicative)**: 1.88 s, 1.93 s, 1.90 s. Before (this leg's first run): 1.78 s; leg 1's earlier figures were 1.74 s to 2.11 s. No new test uses a timer: waits are on promises the notification handler resolves, or on a later answer (`setImmediate` once, in the progress test, to let the call start before the stub's gate opens; not a timer wait). The mutations below that fail by waiting do so at the 5 s vitest test timeout, only under the mutation.
- **What `serveStdio` does with an out-of-band error given no `onerror` (read, `node_modules/@modelcontextprotocol/server/dist/stdio.mjs`)**: `reportError` is `try { options.onerror?.(error) } catch {}`, so with no `onerror` the error is dropped; `wire.onerror` calls it and then forwards to the pinned or probing instance's `channel.onerror`, which is the `Server`'s `onerror`, unset here, so dropped; a failed `wire.start()` is reported the same way, then the rejection is caught by `started.catch(() => {})`. Nothing writes to stdout or stderr and nothing throws. Matches today's behaviour. No finding.
- **Source edits that make each new test fail**. Tried (measured; applied and undone by editing a script that restores the file; each run was `test/serving.test.ts` and `test/server.test.ts`):
  - Remove the `onclose` that deletes from the set: fails "are counted from a connection's start to its end" and the probe-and-fall-back announcement test (a second live instance).
  - Remove the `if (written) return;` guard: fails the four once-only tests (default client; 2026-07-28 first request; probe and fall back; the announcement test, which also asserts the line).
  - Remove `if (version === undefined) return;`: fails "is not written, and nothing throws, when the instance has negotiated nothing" alone.
  - Remove `server.oninitialized = noteConnection;`: fails "names what a 2025 handshake negotiated, here 2025-06-18" alone (the default-client test still passes, since a handler writes the line).
  - Announce to only the first live instance (`.slice(0, 1)`): fails "is told to a 2026-07-28 client only if it subscribed ..." and "reaches a 2025 client and a subscribed 2026-07-28 client at once", each by waiting out the 5 s test timeout.
  - Pass `legacy: "reject"` in `serveApp`: fails 13 tests, every one that uses a 2025 client or probes and falls back, the two existing protocol tests included. (My first try of this edit changed the no-transport branch and failed nothing, since tests pass a transport; it was redone on the branch tests use.)
  - Not tried, named (inferred): the 2026-07-28 client tests (pinned and auto) fail if `serveApp` ignores the factory's era or `legacy` is `'reject'` only for 2025 (the last is the one tried above, for 2025); the `ttlMs`/`cacheScope` test fails if the SDK stops sending them (an SDK change, not a source edit here); the progress test fails if `ctx.mcpReq.notify` is removed from the `tools/call` handler (no progress on the wire); the "no connection live" announcement test fails if `announceToolListChanged` throws on an empty set (it cannot with the loop as written); the raw initialize-at-2026-07-28 test fails only on an SDK change; the three install/uninstall tests for 2025 clients fail if the `finally` of `install` or the uninstall case stops calling `announceToolListChanged`; "subscribed 2026-07-28 client" ones likewise; "is told to a 2026-07-28 client only if it subscribed" fails if the SDK began to send to unsubscribed clients (not a source edit here). The unsubscribed-absence assertion is made with a raw half so the client library cannot drop the notification before the test sees it.
- **The pipe script, as run (measured; saved under a `mktemp -d` outside the repository, `bash <file>` from the repository root after `npm run build`; `MCPE_DATA_DIR` a fresh directory inside the script; unchanged from the leg)**:

```sh
set -u
W=$(mktemp -d); MCPE_DATA_DIR=$(mktemp -d); export MCPE_DATA_DIR; FAIL=0
ENV='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"pipe-check","version":"1"}}'
# run <case> <revision>: messages on stdin; prints the exit status and how many diagnostics lines name the revision
run() { ( cat; sleep 1 ) | node dist/index.js >"$W/$1.out" 2>"$W/$1.err"; rc=$?; echo "exit=$rc lines=$(grep -c "connection: MCP protocol $2" "$W/$1.err")"; }
# answers <case> <kind>: named values from the answers, on one line
answers() { node -e '
  const [file, kind] = process.argv.slice(1);
  const msgs = require("fs").readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const r = (id) => msgs.find((m) => m.id === id)?.result;
  const has = (x) => (x?.tools ?? []).some((t) => t.name === "install_project");
  const out = kind === "modern" ? [(r(1)?.supportedVersions ?? []).includes("2026-07-28"), has(r(2)), r(2)?.ttlMs, r(2)?.cacheScope]
    : kind === "legacy" ? [r(1)?.protocolVersion, has(r(2)), "ttlMs" in (r(2) ?? {})]
    : [r(1)?.protocolVersion];
  console.log(out.join(" "));
' "$W/$1.out" "$2"; }
expect() { if [ "$2" = "$3" ]; then echo "PASS $1: $2"; else echo "FAIL $1: got '$2', want '$3'"; FAIL=1; fi; }
init() { printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$1\",\"capabilities\":{},\"clientInfo\":{\"name\":\"pipe-check\",\"version\":\"1\"}}}" '{"jsonrpc":"2.0","method":"notifications/initialized"}'; }

expect "a process" "$(printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{$ENV}}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{$ENV}}" | run a 2026-07-28)" "exit=0 lines=1"
expect "a answers (2026-07-28 supported, install_project listed, ttlMs, cacheScope)" "$(answers a modern)" "true true 0 private"
expect "b process" "$({ init 2025-11-25; echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; } | run b 2025-11-25)" "exit=0 lines=1"
expect "b answers (protocolVersion, install_project listed, ttlMs present)" "$(answers b legacy)" "2025-11-25 true false"
expect "c process" "$(init 2026-07-28 | run c 2025-11-25)" "exit=0 lines=1"
expect "c answers (protocolVersion)" "$(answers c asked)" "2025-11-25"
rm -rf "$W" "$MCPE_DATA_DIR"
if [ "$FAIL" = 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit "$FAIL"
```

  Output (exit 0; the text holds no machine path):

```
PASS a process: exit=0 lines=1
PASS a answers (2026-07-28 supported, install_project listed, ttlMs, cacheScope): true true 0 private
PASS b process: exit=0 lines=1
PASS b answers (protocolVersion, install_project listed, ttlMs present): 2025-11-25 true false
PASS c process: exit=0 lines=1
PASS c answers (protocolVersion): 2025-11-25
RESULT: PASS
```

- **CI arithmetic**: flight's new unit tests = 880 passed now - 833 (baseline of `d0b5324`) = 47 (26 from leg 1 + 21 here). Floor 810 + 47 = 857. Comment 831 + 47 = 878, dated 2026-11-17. Nothing else in the file changed. (The comment's 878 is two below the 880 that pass: the old comment's 831 was already two below the 833 measured at baseline. The leg's rule was followed as written.)
- **Existing tests (read of the diff)**: the three edits of `test/server.test.ts` named in AC10 and nothing else this leg touched; leg 1's earlier edits are in the file too.
- **AC13 as written (read)**: "`connections` is 1 for the unsubscribed client's `App` at the moment of the change" and "the same change is delivered to a subscribed client on a second connection to the same `App`" cannot both hold for one change. The test does it in two steps: change with one connection live (count 1, nothing arrives before a later answer), then a subscribed client joins (count 2) and a second change reaches it, and the first connection still sees none.
- **Not anticipated by the leg**: (1) an instance built with `createServer()` and never connected has no transport, so `close()` on it does not fire `onclose` and it stays in the set; the AC21 test therefore does not assert a count after closing it. In the process every instance is built by the SDK for a connection, so this cannot happen there. (2) `Transport` is exported by `@modelcontextprotocol/server`, so `serveApp` types its argument without a cast. (3) A first draft of a mutation script of mine hung on a stray `cat` waiting on stdin; no source was changed by it and it was stopped. (4) The pipe script's case c needs `notifications/initialized` in `init` to get its one diagnostics line; it has it.
- **Documentation this leg may have made wrong**: none found. The README states only what the tests and the pipe check show; the claim that a client opening with `server/discover` or with the envelope is served in `2026-07-28` rests on those tests and run (a).

#### After review
Tests added after the Reviewer's confirmation (10). No file of `src/` changed. Each mutation was applied and undone by editing; "measured" means run in this round.
- `test/proxy.test.ts` "treats a malformed tools/call result as a rejected call, keeps the session, and reuses the launch". Mutation: add `SdkErrorCode.InvalidResult` to `GONE_CODES`. Fails (measured).
- `test/proxy.test.ts` "closes the session when a tools/list answer is malformed". Mutation: none tried; it pins an existing outcome (inferred: it fails if `listTools` stopped closing the session).
- `test/serving.test.ts` "is written for a 2026-07-28 connection whose first tool request is tools/call, once". Mutation: remove `noteConnection()` from the `tools/call` handler. Fails (measured).
- `test/serving.test.ts` "sees that the server's tool list can change" (2025, `getServerCapabilities()`) and "is told in server/discover that the server's tool list can change" (raw). Mutation: `tools: { listChanged: true }` to `tools: {}`. Both fail (measured), with four existing subscription tests.
- `announceToolListChanged()` sites, coverage before this round (measured, removing one call at a time, full `npm test`): the `install` `finally` (4 failures), `refresh_mcp` (1), `uninstall_project` (3) were covered; the watcher in `start()`, `select_project_tools`, `discover_tools`, `connect_mcp_server`, `disconnect_mcp_server` were covered by nothing (885 passed). Tests added, each failing alone when its call is removed (measured):
  - `test/server.test.ts` "announces a tool list change when another process changes the registry, and not when nothing changed" (watcher; fake `setInterval` only, a second `Registry` on the same directory writes, the file's mtime is moved forward 5 s).
  - "select_project_tools announces a tool list change once per change".
  - "discover_tools announces a tool list change once".
  - "connect_mcp_server announces a tool list change once".
  - "disconnect_mcp_server announces a tool list change once".
- CI: floor 857 to 867, comment 878 to 888 (for 890 passing).

---

## Decisions

---

## Deviations

### A second behaviour of the proxy changes, not one
**Planned**: DD7 said one behaviour of `McpProxy` changes with the move to the v2 client.
**Actual**: Two change. The second: a sandboxed server that answers `tools/call` with a malformed result (raw upstream returning `{content: "bad"}`) makes the v2 client raise an `SdkError` with code `INVALID_RESULT` ("Invalid result for tools/call"). That code is not in `GONE_CODES`, so `callTool` reports `MCP server "srv" rejected the call to "add"` and keeps the session (measured: `proxy.size` stays 1, the next call reuses the same launch, launch count 1). On v1 the same answer raised a ZodError, which was not an `McpError`, so the session was closed and the call was reported as "stopped while running" (read: this half is the Reviewer's reading of v1; I did not reinstall v1 and cannot show it here). `listTools()` with a malformed `tools/list` answer (`{tools: "bad"}`) still closes the session and says `failed to list its tools` (measured), which is that method's one outcome; nothing changes there.
**Reason**: The new outcome follows DD7's table: any other `SdkError` is a rejected call and the server is alive. The Flight Director decided it stands. Tests: two in `test/proxy.test.ts` (see After review).

---

## Anomalies

---

## Session Notes

### Flight Director Notes
- 2026-11-17, execution start. `/mission-control:agentic-workflow sortie 05`. Crew file `.flightops/agent-crews/leg-execution.md` loaded and found well-formed (Crew, Interaction Protocol, Prompts, each prompt fenced). Developer and Reviewer run on Sonnet, as it assigns. Branch `sortie/05-serve-the-2026-07-28-protocol` cut from `main` at `d0b5324`; status set to `in-flight`. Three legs: two autonomous, one HAT. No flight briefing: this project has not written one for any flight.
- The operator's sandboxes before any run, read with `docker ps -a`: `mcpe-ha_googlehome` `665f39adfe00`, `mcpe-rea` `7b144f977711`, `mcpe-cowsay` `fd587c938d43`, `mcpe-gron` `fb6814b6904c`.
- Leg 1 (`sdk-v2-packages`) designed. **Risk tier: high.** It changes how the proxy classifies errors from a shared dependency (an interface with existing consumers), and it changes what the process does at shutdown (a lifecycle). So it gets a Developer design review before implementation.
- Read while designing leg 1, and narrower than the spec's DD7 table says: `listTools` does not let the error rise as it is. It closes the session and throws `failed to list its tools: <text>` (`McpProxy.listTools` in `src/proxy/mcp-proxy.ts`). Still one outcome; the leg states it exactly (AC17), and the text rule of DD7 applies there too.
- Measured while designing leg 1 (scratch directory, v2 `2.4.0`, one run): the v2 client's own errors read `Request timed out`, `Connection closed` and `Not connected`, where v1's read `MCP error -32001: Request timed out` and `MCP error -32000: Connection closed`. The spec left this text unmeasured and unpinned. Leg 1 keeps it unpinned and does not restore the prefix for errors no server sent (AC18); this is the one difference in tool-result text the leg makes. v2's `callTool` takes `(params, options)`, without v1's middle argument.
- Leg 1 design review (Developer, Sonnet): **approve with changes**, no high issue. Every quoted test name and code fragment was found as quoted; no consumer of the v1 SDK was missing from the leg. Four medium issues, all taken as recommended: the plain-`Error` test of AC13 had no way to be written, since the client's `onclose` retires a dead session before a second call can reach it (now a transport whose `send` throws, measured: the v2 client rejects with that same plain `Error` and `onclose` does not fire); `npm install` would run `prepare` on a tree that does not compile mid-move (now `--ignore-scripts`); nothing asserted that serving starts before the listeners are registered (AC4h); and the serving double's self-close could not be told from the wiring's `close()` (now two records). Low: one copy of `core` is now required, since the proxy tells the error classes apart with `instanceof`; no kill is asserted for a server that dies mid-call; timings are three runs and indicative; the pipe check is also run on v1 first.
- **No second design review of leg 1.** The changes are test recipes and verification steps that the reviewer itself recommended; no criterion's meaning changed and no design decision moved. Leg 1 set to `ready`. `[HANDOFF:review-needed]` for the leg design is closed by this note.
- Leg 1 landed (`[LAND:leg]` from the Developer, Sonnet). Checked by the Flight Director on the working tree: `npm test` 859 passed, 24 skipped; `npm run typecheck` clean; `git status` shows the files the leg names and no others. The Developer's own Docker run (22 passed, 2 skipped, 207 s) and its reading of the four container ids are taken from its report and its log entry, not repeated. Its one caveat is accepted: the "before" pipe check was taken on v1 after the entry extraction, not on the untouched tree; planning's run 1 was on the untouched tree and gave the same answer to the same `initialize`.
- Leg 2 (`serve-both-eras`) designed. **Risk tier: high**: it removes `app.server` (a property tests and the entry read) and introduces a lifecycle (instances that become live and stop being live). Developer design review before implementation.
- Decided in leg 2's design, within DD9: the line's text is `connection: MCP protocol <revision>`, and it does not name the client. The client's name is text the client sent; the revision is read from the SDK, which chose it from its own list. The line is written by one closure per instance, called from `oninitialized` and from both handlers, so the code needs no knowledge of eras.
- Decided in leg 2's design, within DD4: the count of live instances is readable from outside, for tests of the set (AC3, AC15, AC16).
- Leg 2 design review (Developer, Sonnet): **approve with changes**, no high issue. With the v2 packages now installed, it re-ran the six planning observations the leg leans on and confirmed all six. Four medium issues, all taken: AC13 could pass because nothing was announced at all (now carries a positive control); the announcing method had no fixed name or visibility although an existing test must replace it (now public, `announceToolListChanged`; the count is a getter, `connections`); AC21 had no way to be tested (now: call `oninitialized` on an unconnected instance); the pipe script printed values and left the judging to the reader (rewritten to print PASS or FAIL per check and exit non-zero). Low, taken: an install's announcement comes before the answer of a call that waited for it, not after, as the leg had said; new tests wait on a promise and never start the watcher.
- Decided, on the review's question: `serveStdio` is given no `onerror`. A transport error is dropped today, and this sortie adds one diagnostics line, not two. The Developer reads what the SDK does by default and reports if it is anything but dropping.
- The rewritten pipe script was run by the Flight Director against leg 1's build: PASS on the two checks leg 1 already meets, FAIL on the four that need leg 2, exit 1. So its plumbing is known to work and its failures are known to be reachable.
- **No second design review of leg 2**, for the same reason as leg 1: the changes are names, test recipes and a script, all as the reviewer recommended or asked. Leg 2 set to `ready`.
- The review judged leg 2 large but one leg, and advised against a split. Kept as one; the README and CI step stays last.
- Leg 2 landed (`[LAND:leg]` from the Developer, Sonnet). Checked by the Flight Director on the working tree: `npm test` 880 passed, 24 skipped, 1.87 s; `npm run typecheck` and `npm run build` clean; the pipe script, run from the Flight Director's own copy after that build, printed six PASS and `RESULT: PASS`; a search of the sortie's artifacts, `src`, `test`, the README and the workflow for a home path or a username found none.
- Accepted from leg 2: AC13 was met in two steps and not one (a change with one connection live, then a second change after a subscribed client joined, the first connection still hearing none). The criterion as the Flight Director wrote it asked for one live connection and a second connection at the same change, which cannot both be true; the Developer's reading keeps both the absence and the positive control. Accepted also: the hosted check's comment says 878 where 880 pass locally, because the leg's rule adds to the old comment's 831, which was already two under the local count.
- Both autonomous legs are landed and uncommitted. Next: one Reviewer (Sonnet) on all of it, with the Docker suite run once on the final tree, as the spec's time budget set.
- Seen while checking: a `node dist/index.js` from this checkout is running on this machine, started before the flight (the operator's own mcp-everything, serving this session's client). Each `npm run build` in this flight has replaced the `dist/` it was started from, and leg 1 removed the v1 SDK from `node_modules`. A running Node process keeps the modules it has loaded, so it goes on as it was; the next time the operator's client starts it, it will be the branch's build. That is what the HAT leg wants, and the operator is told so.
- Flight review, first pass (Reviewer, Sonnet): **`[HANDOFF:confirmed]`**, no blocking issue. It ran typecheck, the unit suite (880 passed), the build, the pipe script (six PASS) and the Docker suite once on the final tree (22 passed, 2 skipped, 280 s; the operator's four container ids the same before and after), and broke the source in about thirty ways, each caught. Three non-blocking notes: a second difference in the proxy that no artifact recorded (a malformed `tools/call` result is now a rejected call with the session kept, where v1 closed the session); a README sentence tested for `tools/list` and not for `tools/call`; and source lines whose removal failed no test (the announcement after a rediscovery, the `listChanged` capability).
- **Decision by the Flight Director on the malformed-result difference: it stands.** It is what DD7's table says for an `SdkError` it does not name, and the server is alive, so keeping its session is the more accurate outcome. What was wrong was the spec's sentence that one behavior changes. Recorded under Deviations; pinned by a test. The operator is told.
- Fix round (Developer, Sonnet): tests and artifacts only, no change under `src/`. Ten tests. By removing each of the eight announcement calls in turn it found five covered by no test (the watcher, `select_project_tools`, `discover_tools`, `connect_mcp_server`, `disconnect_mcp_server`); each now has one. The Reviewer had thought these gaps older than the flight; the flight rewrote the lines, so they were closed here and not logged as squawks.
- Flight review, second pass, on the fix round only (Reviewer, Sonnet): **`[HANDOFF:confirmed]`**. Every one of the ten tests failed under at least one mutation; three repeat runs of the three files were identical; `src/` byte-identical before and after. Final counts: `npm test` 890 passed, 24 skipped.
- A note on two numbers, since the Reviewer found them confusing: the hosted check's floor went 810 to 857 in leg 2 and 857 to 867 in the fix round; against `main` the diff is 810 to 867, and the comment's count 831 to 888. Fifty-seven unit tests were added in all (833 to 890).
- Two review cycles, of the three allowed. Leg statuses set to `completed`; the two legs ticked in the spec. Commit and draft pull request next. The flight stays `in-flight`: the HAT leg is not done.
- Committed by a Developer as `eed2610` on the sortie's branch, one commit, the message given by the Flight Director. Pushed; draft pull request #20 opened with the two legs checked and the HAT leg open.
- HAT leg (`hat-and-alignment`) designed and set `in-flight`: interactive, no crew spawned, low risk. `dist/` was rebuilt after the commit (two source files carried newer timestamps than the build, from the reviewers' mutations, which were undone by editing) and the pipe script re-run on it: `RESULT: PASS`. The operator is guided one step at a time.
- HAT, step 1, first attempt. The operator asked how to point the client at the branch and was given the `npx` form with `#sortie/05-serve-the-2026-07-28-protocol` (or `#eed2610`), neither run by the Flight Director, and the checkout's `dist/index.js`. GleepGlorp then showed: version `0.4.0`, protocol `2025-11-25`, offers tools. That does not yet tell a stale build from a client that opened with `initialize`: `main` and the branch both say `0.4.0`.
- The operator asked for the minor version to be raised on the branch, so that the build can be told apart. **Classed as a fix, not a feature**, said out loud: it changes four version values and no behavior, on one surface. Made inline by a Developer (`0.4.0` to `0.5.0`), committed and pushed at once, since the operator fetches the branch from GitHub.

### 2026-11-16: planning

- The operator reported that mcp-everything "is reporting as an older protocol from 2025". Qualified as a sortie; charter agreed the same day with the proxy side out (operator's choice) and GleepGlorp named as the client that supports `2026-07-28`.
- Order of planning: the spec was drafted and sent to the Architect before the operator's open-ended input and the crew interview, which were folded into the approval walk. Reason: the design rests on measurements, and the two questions that are the operator's (DD9, and where GleepGlorp shows the revision) do not change the structure.
- No upstream reconnaissance report: no prior artifact enumerates this work.

**What was measured, on what, and how often.** All of it by the Flight Director, in a scratch directory outside the repository, on Linux under WSL2, Node 22.22.0, with `@modelcontextprotocol/server`, `client` and `core` `2.4.0` and TypeScript `7.0.2`. One run each unless a count is given. Nothing in the repository was changed.

| # | What was run | Observed |
|---|--------------|----------|
| 1 | The built entry at `d0b5324` with a temporary data directory; one `initialize` asking for `2026-07-28` piped in | Answered `protocolVersion: "2025-11-25"`; exit 0 |
| 2 | A spike server: v2 low-level `Server` behind `serveStdio(factory)`, two tools, progress, a tool that grows the list and announces it. Raw JSON over a pipe: `initialize` at `2025-11-25` | `2025-11-25`, instructions in the result; two progress notifications before the result |
| 3 | Same, `initialize` asking for `2026-07-28` | Answered `2025-11-25` |
| 4 | Same, `server/discover` then enveloped `tools/call` and `tools/list` | `supportedVersions: ["2026-07-28"]`, instructions in the result; progress before the result; `tools/list` carried `resultType`, `ttlMs: 0`, `cacheScope: "private"`, `_meta` with the server's identity |
| 5 | Same, enveloped `tools/list` with no `server/discover` first | Served; factory called once with `era: "modern"` |
| 6 | Same, `server/discover` then `initialize` | Factory called with `modern`, that instance's `onclose` fired, factory called with `legacy`; the later announcement was written unasked |
| 7 | Same, `subscriptions/listen` with `toolsListChanged: true`, then the growing tool | Acknowledged; `notifications/tools/list_changed` written with the subscription's id |
| 8 | Same as 5, then the growing tool, with no subscription | `sendToolListChanged()` resolved; nothing written |
| 9 | Same, enveloped request, then `initialize` | `-32022`, supported `["2026-07-28"]` |
| 10 | Same, envelope naming `2027-01-01` | `-32022`, supported `["2026-07-28"]` |
| 11 | In every pipe run, stdin closed at the end | The spike process exited 0 by itself |
| 12 | v2 `Client` over stdio against the spike server, in modes default, `"auto"` and `{ pin: "2026-07-28" }` | Eras `legacy`, `modern`, `modern`; versions `2025-11-25`, `2026-07-28`, `2026-07-28`; tools listed, tool called, `listChanged.tools.onChanged` fired once in each |
| 13 | In 12, two progress notifications sent back to back | `onprogress` received one in each mode; runs 2 and 4 show both on the wire |
| 14 | In memory: `serveStdio(factory, { transport })` on one half of the client package's `InMemoryTransport` pair, v2 `Client` on the other, three modes; ticks 20 ms apart; `client.listen` in the modern era | Same eras and versions as 12; three ticks received; one list-changed received; factory called once in each |
| 15 | In 14, a tool call with a 50 ms timeout against a 400 ms tool | `SdkError`, code `REQUEST_TIMEOUT`, equal to `SdkErrorCode.RequestTimeout` |
| 16 | v2 `Client` over stdio against a script that answers `initialize` and exits on `tools/call` | `SdkError`, code `CONNECTION_CLOSED`; `onclose` fired |
| 17 | v2 `Client.connect` with a 300 ms timeout against a process that never answers | `SdkError`, code `REQUEST_TIMEOUT` |
| 18 | The v1 `Client` from this repository's `node_modules` (`1.32.2`) over stdio against the spike server | Connected, listed, called, read the instructions |
| 19 | `tsc` `7.0.2` on the in-memory spike, `strict`, `noUncheckedIndexedAccess`, `skipLibCheck` off, with and without a cast on the transport | Exit 0 both times |
| 20 | `npm test` at `d0b5324` | 833 passed, 24 skipped, 1.74 s |
| 21 | `du -sh` of `node_modules/@modelcontextprotocol` here and in the scratch directory | 6.3 MB and 16 MB |
| 22 | `docker info` | Server 29.8.2 |

**Measured after the Architect's first review**, same scratch directory and versions, one run each:

| # | What was run | Observed |
|---|--------------|----------|
| 23 | A v2 server behind `serveStdio`, with a timer keeping the process alive and its own listener on stdin's `end`; one `initialize` piped in, then stdin closed | The instance's `onclose` fired; the process stayed alive; the program's own `end` listener ran 300 ms of work; `handle.close()` resolved twice; exit 0 after the timer was cleared |
| 24 | Search of the built files of the v2 `server` and `core` packages for `process.exit(` | None |
| 25 | In memory, v2 client against a v2 `Server` whose `tools/call` handler throws a plain `Error` | `ProtocolError`, code `-32603`, message the thrown text |
| 26 | Same pair, a tool result with `structuredContent` and no output schema | Returned unchanged |
| 27 | In memory, v2 client against a raw double that answers `tools/call` with error `-32000`, then `-32001` | `ProtocolError` with that code both times; not `SdkError` |
| 28 | In memory, v2 client against a raw double that answers `initialize` with error `-32000` and a two-line message | `connect` rejected with `ProtocolError`, code `-32000`, both lines in the message |
| 29 | v2 `StdioClientTransport` with `stderr: "pipe"` against a child that writes a line to stderr, answers `initialize` and exits on `tools/call` | `stderr` was a stream before start and the line was read from it; first call `SdkError` `CONNECTION_CLOSED`; a second call rejected with a plain `Error`, "Not connected" |

**Read after the review**: `Registry.list` returns the in-memory copy and only `refresh` re-reads the file (`src/registry.ts:44`, `:182`); the v1 codes `ConnectionClosed = -32000` and `RequestTimeout = -32001` (`node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`).

**Architect, cycle 1 (2026-11-16): approve with changes.** Every citation of this repository was checked and found correct; three were imprecise (a file count, a missing `:17`, a floor with no number). Three medium issues, all taken:
- DD7 described three outcomes where the proxy has three only in `callTool`, and its mapping left some `SdkError` codes without a home. Now a table, with the one behavior that changes named and measured (27).
- The shutdown paragraph argued from a spike that shows nothing about this process, and its test could not be written against a module that runs on import. Now DD10: the argument rests on the bounded shutdown's timer, the SDK's side is measured (23, 24), and the wiring is extracted first.
- Wording beyond the evidence, three places: DD4's "no per-connection state" cited two handlers for a claim about `App`; DD5's "maximum staleness: none" was wrong, since `tools/list` is answered from a copy that is up to 5 s behind another process's change; and criterion 3 promises a notification that `2026-07-28` gives only to a client that subscribed. The first two are corrected in the spec. The third is the charter's, so a rewording is proposed to the operator and not made.
- Low: the Docker run in leg 1 is required and not waived; the README has no section on protocol today, so the spec now says where the new text goes.
- The two-leg split was found sound, with leg 2 to begin with the entry wiring and its test.

**What was read and not run.** The v2 migration guide and the page on supporting `2026-07-28` were fetched by a subagent, which read about the first half of each verbatim and the rest through a summary; the specification's changelog for `2026-07-28` was read in full. Claims in the spec that rest on those pages say so. The spike's files are not kept.

### 2026-11-17: planning, continued

The operator answered the three questions left open by the first review:
- Criterion 3 is reworded as proposed. The charter now carries the new wording, with the first wording kept beneath it.
- GleepGlorp shows the negotiated revision in its UI, and the operator will test by hand against a build of the sortie's branch. Whether it subscribes to tool-list changes is still not known; the HAT leg observes it, and under the reworded criterion neither answer is a failure.
- The diagnostics line of DD9 is confirmed.

These are answers to questions, not approval of the spec. The spec goes to the Architect a second and last time, then to the operator for approval.

**Measured after the Architect's second review**, same scratch directory and versions as before, one run each:

| # | What was run | Observed |
|---|--------------|----------|
| 30 | Search of the built `.mjs` files of the v2 `server` and `core` packages for uses of `process`, for `SIGINT` and `SIGTERM`, and for `.unref(` | `process.stdin` once, `process.stdout` twice, nothing else; no signal name; no `.unref(`. The stdio transport adds listeners for `data`, `end`, `close` and `error` on its input |
| 31 | A v2 `Server` connected by hand to a v2 `StdioServerTransport`, with a timer keeping the process alive and its own listener on stdin's `end` that waits 300 ms and calls `server.close()`; one `initialize` piped in, then stdin closed | The server's `onclose` fired in the same millisecond as the program's own listener; the process stayed alive; `server.close()` resolved; exit 0 after the timer was cleared |
| 32 | The same server, `initialize` asking for `2025-06-18`, with `oninitialized` set | `oninitialized` fired; `getNegotiatedProtocolVersion()` returned `2025-06-18` |
| 33 | A v2 `Server` behind `serveStdio`, logging the getter at factory time, in `oninitialized` and in `tools/list`; `initialize` at `2025-06-18` then `tools/list` | Undefined at factory time; `oninitialized` fired with `2025-06-18`; the same in the handler |
| 34 | Same, `server/discover` then an enveloped `tools/list` | Undefined at factory time; `oninitialized` did not fire; `2026-07-28` in the handler |
| 35 | Same, `server/discover`, then `initialize` and `tools/list` | Instance 1 (`modern`) closed with no tool request; instance 2 (`legacy`) fired `oninitialized` with `2025-11-25` |
| 36 | In memory, a raw double answering `tools/call` with error `-32602`, message "no such tool nope": the v2 client, then the v1 client from this repository's `node_modules` | v2: `ProtocolError`, message `no such tool nope`. v1: `McpError`, message `MCP error -32602: no such tool nope` |

In 31 to 35 the `onclose` that fired was one the program assigned to the instance, in 33 to 35 from inside the factory.

**Architect, cycle 2 (2026-11-17): approve with changes, no blocker.** Every cycle-1 issue was found resolved. Citations in DD4, DD7, DD8 and DD10 were checked against the code and found correct. Eight issues, all taken:
- Medium: leg 1 keeps the hand connection but on v2's transport, whose behavior at stdin end had not been measured, while the shutdown test arrived only in leg 2. Measured (31): the v2 transport does close the server at stdin end. The extraction and the test are now the first step of leg 1, on v1.
- Medium: leg 2 had outgrown its slot. DD10 moved to leg 1; the README and CI floor are an explicit last step, with a stated fallback to a third leg that the operator is told about.
- Medium: DD9 did not say where the line gets the revision, and a line written at factory time would name `2026-07-28` for a probe that ends in 2025. Measured (32 to 35); the line is now written from `oninitialized` or at the first tool request, one per connection.
- Lower: the HAT paragraph concluded "subscribes" from a list that follows, which `ttlMs: 0` does not allow, and assumed GleepGlorp shows the server's stderr. Both reworded; the stderr comparison is now optional. DD10's "cannot" is now "was not observed to", with the wider search (30). The text of a server's error would have lost its `MCP error <code>:` prefix (36); the proxy now keeps it. The factory's `onclose` is stated as the removal hook. The CI floor rises by the tests added.
- "The Architect's reading agrees" was removed from DD4 as an appeal to a reviewer; the search it stood for is cited in its place.

That was the second of two cycles. The Architect did not read the README; its three headings were checked by the Flight Director (`:174`, `:536`, `:562`). The spec goes to the operator for approval.

**Sortie gate, re-checked on the designed flight**: one cluster of decisions (how the two eras are served from one entry); two legs and a HAT. Holds.

**Operator approval (2026-11-17)**: the operator approved the spec as it stood after the second review and asked for execution. Status set to `ready`.
