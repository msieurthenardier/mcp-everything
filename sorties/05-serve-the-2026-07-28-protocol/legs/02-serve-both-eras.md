# Leg: serve-both-eras

**Status**: completed
**Flight**: [Serve the 2026-07-28 Protocol](../flight.md)

## Objective
Serve each connection in the revision its client opens with, `2026-07-28` or the 2025 handshake, by handing the SDK's `serveStdio` a factory from `App`; announce tool-list changes to every live server instance; write one diagnostics line per connection naming its revision; and document it.

## Context
- Flight decisions this leg implements: DD3's second step (the opt-in), DD4 (factory, set of live instances, one announcing method), DD5 (the SDK's cache defaults, kept), DD6 (no era-specific code for progress or instructions), DD8 (both eras tested in memory through the entry the process uses), DD9 (the diagnostics line). DD10's test from leg 1 must still pass.
- Charter criteria this leg proves: 1, 2 and 3. Criterion 4 is the HAT leg.
- **The proxy does not change in this leg.** It keeps the 2025 handshake with sandboxed servers (charter constraint). `src/proxy/mcp-proxy.ts` is touched only if a test here finds a defect, and then that is reported, not folded in.
- Tool names, tool inputs and the `<slug>__<NAME>` variables do not change. The Node floor does not change.
- What leg 1 left, read on the working tree on 2026-11-17: `src/entry.ts` exports `runEntry`, which takes a `serve: () => Promise<Serving>` and closes the handle after `app.shutdown()`; `src/index.ts` passes a `serve` that connects `app.server` to a `StdioServerTransport`; `App` constructs one v2 `Server` in its constructor, registers `"tools/list"` and `"tools/call"` on it, and calls `this.server.sendToolListChanged()` at eight places (the watcher in `start()`, and the `install_project`, `select_project_tools`, `discover_tools`, `connect_mcp_server`, `refresh_mcp`, `disconnect_mcp_server` and `uninstall_project` cases of `callTool`). Three tests read `app.server`: two connect it to an in-memory half, one replaces `a.server.sendToolListChanged`.
- Statements marked **measured** were observed by the Flight Director in a scratch directory outside the repository with the v2 packages at `2.4.0`; the flight log has each run. If one does not hold when the Developer meets it, that is a finding to report, not something to work around. Statements marked **read** are from the installed packages' type declarations or this repository.
- From earlier debriefs: for each new test, be able to name the source change that makes it fail; do not weaken an existing assertion.

## Inputs
- Branch `sortie/05-serve-the-2026-07-28-protocol` with leg 1 landed and uncommitted. `npm test`: 859 passed, 24 skipped (Flight Director's run after leg 1). `npm run typecheck` clean.
- `@modelcontextprotocol/server` and `@modelcontextprotocol/client` at `2.4.0`, one copy of `core`.
- **Read** (`node_modules/@modelcontextprotocol/server/dist/stdio.d.mts`): `serveStdio(factory, options?)` returns a `StdioServerHandle` with `close(): Promise<void>`, synchronously. Options: `legacy?: 'serve' | 'reject'` (default `'serve'`), `transport?`, `onerror?`, `maxSubscriptions?` (default 1024). The factory receives a context with `era: 'legacy' | 'modern'`.
- **Read** (client declarations): `ClientOptions.versionNegotiation` is `{ mode?: 'legacy' | 'auto' | { pin: string } }`, default `'legacy'`; `client.listen(filter)` opens a subscription; `client.getProtocolEra()` and `client.getNegotiatedProtocolVersion()` report what was reached.
- `.github/workflows/ci.yml`: floor 810, comment "831 tests pass as of 2026-11-16". Leg 1 added 26 tests.
- `README.md` has `## Configuration`, `### Projects that are MCP servers` and `## Limitations`, and says nothing about protocol revisions.

## Outputs
- `App` without `app.server`: a method that builds a server instance, a set of the live ones, one announcing method.
- A function that starts serving an `App` through `serveStdio`, taking an optional transport; `src/index.ts` using it.
- The diagnostics line.
- Tests for both eras, the fallback, the announcement set and the diagnostics line.
- README section and two notes; CI floor and comment.
- A script in the flight log entry (not a committed file) for the pipe check, with its output.

## Acceptance Criteria

**Serving**
- [x] AC1. `src/index.ts` serves through `serveStdio` with a factory from `App`, with `legacy` left at its default, and passes the returned handle to `runEntry` as the thing to close. No code in `src/` constructs a `StdioServerTransport` or calls `connect` on a `Server`.
- [x] AC2. The function that starts serving takes the `App` and an optional transport, and is the same function the tests call with one half of an in-memory pair. The process differs from the tests only in passing no transport.
- [x] AC3. `App` has no `server` property. It has a method that returns a new `Server` (same name, version, capabilities, instructions and the two handlers as today) and records it as live; an instance stops being live when it closes (its `onclose`). The number of live instances can be read from outside through a getter, `connections`, for tests; nothing assigns to it.
- [x] AC4. `App` has one public method, `announceToolListChanged()`, that announces a changed tool list: it calls `sendToolListChanged()` on every live instance and swallows each failure. The eight places that call `this.server.sendToolListChanged()` today call it as `this.announceToolListChanged()`, never through a captured reference (a test replaces it on the instance), and do nothing else differently. With no live instance it does nothing and does not throw.
- [x] AC5. `test/entry.test.ts` passes unchanged.

**Criterion 1: a `2026-07-28` client**
- [x] AC6. In memory, through the serving function, without `app.start()` (no watcher in these tests): a client constructed with `versionNegotiation: { mode: { pin: "2026-07-28" } }` connects; `getNegotiatedProtocolVersion()` is `"2026-07-28"` and `getProtocolEra()` is `"modern"`; `listTools()` returns the built-in tools and a seeded project's tool; `callTool` on that project's tool returns its output; the server's instructions are available to the client. The same holds for a client with `mode: "auto"`. On a raw `2026-07-28` half, the `tools/list` result carries `ttlMs` 0 and `cacheScope` `"private"` (DD5), so the pipe check is not the only place that is pinned.
- [x] AC7. A tool call with a progress token on a `2026-07-28` connection produces `notifications/progress` on the wire before the result. Asserted on the raw messages of a hand-driven in-memory half, not through the client's `onprogress` (which dropped one of two back-to-back notifications in planning).

**Criterion 2: a 2025 client**
- [x] AC8. In memory, through the serving function: a client with no negotiation option reports `"2025-11-25"` and era `"legacy"`, lists, calls, and reads the instructions. The existing tests "serves the tool list, executes calls and announces list changes" and "tells agents the route in the instructions and the descriptions of connect_mcp_server" make their connection through the serving function and pass with no assertion removed or loosened.
- [x] AC9. A raw `initialize` that asks for `2026-07-28` is answered with `protocolVersion: "2025-11-25"`. (This is the SDK's rule, stated in the README; the test pins it so that a later SDK that changes it is noticed.)
- [x] AC10. Every test that existed before this leg passes. Edits to them are limited to: connecting through the serving function where a test connected `app.server`; replacing the announcing method where the test "stops the sessions, discovers again, launches a server that had one, and says what it did" replaced `a.server.sendToolListChanged`. No assertion is removed or loosened.

**Criterion 3: tool-list changes**
- [x] AC11. A connected 2025 client receives `notifications/tools/list_changed` after `install_project` completes and after `uninstall_project`, without asking. The install is covered both ways: a call that waits for the job (the announcement is written before the call's answer), and a call that returns while the job is still running (the announcement is written later, when the job finishes). The new tests wait on a promise the notification handler resolves, never on a timer.
- [x] AC12. A connected `2026-07-28` client that has called `listen({ toolsListChanged: true })` receives it after each of the same two.
- [x] AC13. A connected `2026-07-28` client that has not subscribed receives none. The test states this as the revision's rule in its name, and asserts the absence without a sleep: after the change, it makes a further request on the same connection and checks that no notification arrived before that request's answer. The same test carries a positive control, so that it cannot pass because nothing was announced at all: `connections` is 1 for the unsubscribed client's `App` at the moment of the change, and the same change is delivered to a subscribed `2026-07-28` client on a second connection to the same `App`.
- [x] AC14. With two connections live at once (two calls of the serving function on two pairs, one 2025 client and one subscribed `2026-07-28` client), one change reaches both.
- [x] AC15. A client that sends `server/discover` and then `initialize` on the same connection (raw messages on an in-memory half): afterwards exactly one instance is live, and a change is announced on that connection exactly once.
- [x] AC16. After a client closes its connection the count of live instances is back to what it was, and a later announcement neither throws nor rejects. After the serving handle's `close()`, likewise.

**The diagnostics line (DD9)**
- [x] AC17. One line per connection goes through the `log` function `App` was given, naming the revision the connection is served in, in a fixed form: `connection: MCP protocol <revision>` (the entry prefixes `[mcp-everything] ` as it does for every line).
- [x] AC18. On a 2025 connection the line is written when the handshake completes (`oninitialized`) and names what was negotiated: `2025-11-25` for a default client, and `2025-06-18` for a raw `initialize` that asks for `2025-06-18`.
- [x] AC19. On a `2026-07-28` connection the line is written when the instance serves its first `tools/list` or `tools/call`, and not for `server/discover` alone: after a raw `server/discover` and nothing else, `log` has no connection line; after the first tool request it has one.
- [x] AC20. Each instance writes at most one line: after several requests on one connection, `log` holds exactly one connection line. A client that probes and falls back (AC15's exchange) produces exactly one, naming `2025-11-25`.
- [x] AC21. The revision in the line is read from the instance (`getNegotiatedProtocolVersion()`), never from text the client sent. If the getter returns nothing at the moment of writing, no line is written and nothing throws; tested by building an instance with the factory method and calling its `oninitialized` without connecting it, which is the one point where the closure can run with the getter undefined. (Dropping the guard would write `connection: MCP protocol undefined`.)
- [x] AC22. Every existing assertion on the whole of what was logged passes unchanged: in `test/server.test.ts`, "have removed old files and kept fresh ones when start returns; the reconciliation follows" and "log nothing when nothing was removed" (`expect(log).toEqual(...)`), and the `expect(lines).toEqual(...)` in `describe("an unusable value")`. None of them makes a connection, and the line is written only for a connection.

**The real pipe**
- [x] AC23. After `npm run build`, with `MCPE_DATA_DIR` set to a new temporary directory, the built entry is driven with raw JSON over a pipe three times, by the script in Implementation Guidance step 7. It checks named values and compares against no recorded output:
  - a. `server/discover` then an enveloped `tools/list`: `supportedVersions` contains `2026-07-28`; the list contains `install_project`; the result carries `ttlMs` equal to 0 and `cacheScope` equal to `private`; stderr has `connection: MCP protocol 2026-07-28` once.
  - b. `initialize` at `2025-11-25`, `notifications/initialized`, `tools/list`: `protocolVersion` is `2025-11-25`; the list contains `install_project`; the result has no `ttlMs`; stderr has `connection: MCP protocol 2025-11-25` once.
  - c. `initialize` asking for `2026-07-28`: answered `2025-11-25`.
  - In each, the process exits 0 after its stdin closes. The script prints PASS or FAIL for each check and exits non-zero on any FAIL; its text and its output are in the flight log entry.

**Documentation and the hosted check**
- [x] AC24. The README has a new section immediately before `## Configuration` that says, in the README's own plain style: which revisions are served (`2026-07-28`; and the 2025 handshake, negotiating up to `2025-11-25`); that the client's opening message decides, and that a client asking for `2026-07-28` through `initialize` is answered `2025-11-25` because that revision has no `initialize`; that in `2026-07-28` a client is told of a tool-list change only if it subscribed, and that tool listings are sent as not cacheable, so a client that asks again gets the current list; and that mcp-everything writes one line to stderr per connection naming the revision, with the line's form.
- [x] AC25. Under `### Projects that are MCP servers` and under `## Limitations`, the README says that mcp-everything speaks the 2025 handshake to a sandboxed server whatever revision its own client uses, and that a server which refuses that handshake cannot be proxied.
- [x] AC26. In `.github/workflows/ci.yml`, the floor is 810 plus the number of unit tests this flight added (26 from leg 1 plus this leg's), and the comment's count is 831 plus the same number, with today's date. Nothing else in the file changes.

**Nothing else changed**
- [x] AC27. `npm run typecheck`, `npm test` and `npm run build` pass; `npm test` passes 859 plus this leg's new tests and skips 24. `npm ls @modelcontextprotocol/sdk` is still empty. `src/proxy/`, `src/install/`, `src/sandbox/`, `src/toolgen/`, `src/registry.ts` and `package.json` are unchanged by this leg.
- [x] AC28. The duration line of three `npm test` runs is recorded after the leg. With leg 1's figures (1.74 s to 1.93 s before the flight), the flight's new unit tests are meant to add no more than 0.5 s; report the three as they are. No new test waits on a real timer for longer than 50 ms, and none sleeps to prove an absence.

## Verification Steps
- AC1 to AC4: read `src/index.ts`, `src/server.ts` and the serving function; `grep -n "StdioServerTransport\|\.connect(" src -r`; `grep -n "sendToolListChanged" src -r` shows it only inside the announcing method.
- AC5 to AC22: `timeout 120 npm test`; read the new tests; for each, name in the flight log the source edit that makes it fail, and say which ones were tried.
- AC10: `git diff -- test/server.test.ts` read line by line for the three tests named.
- AC23: run the script; paste its output into the flight log entry.
- AC24, AC25: read the README diff; `grep -n "^## \|^### " README.md` shows the new section immediately before `## Configuration`.
- AC26: `git diff -- .github/workflows/ci.yml`; the arithmetic written out in the flight log.
- AC27: `npm run typecheck && timeout 120 npm test && npm run build`; `npm ls @modelcontextprotocol/sdk`; `git status --short` compared with the list under Files Affected.
- AC28: three `Duration` lines.

## Implementation Guidance

1. **Set the leg `in-flight`. Record `npm test` (counts, duration).**

2. **`App`: factory, live set, announcing method** (`src/server.ts`).
   - Move the `new Server(...)` and the two `setRequestHandler` calls out of the constructor into a method. In it, add the instance to a `Set`, and set its `onclose` to delete it from the set.
   - **Measured**: under `serveStdio`, an `onclose` and an `oninitialized` assigned to the instance inside the factory both fire; `serveStdio` does not replace them.
   - The announcing method iterates over a copy of the set (an instance can close while it runs) and does `void s.sendToolListChanged().catch(() => {})` for each, as each site does today for the one server.
   - **Measured**: `sendToolListChanged()` on a `2026-07-28` instance with no subscription resolves and writes nothing; with a subscription it writes the notification with the subscription's id; on a 2025 instance it writes unasked. So the announcing method needs no knowledge of eras or subscriptions.
   - Replace the eight call sites. Remove the `server` property.

3. **The diagnostics line.**
   - One closure per instance that writes the line once (a boolean it closes over), reading `getNegotiatedProtocolVersion()` and returning without writing if that is undefined. Call it from `oninitialized` and at the top of both handlers. It needs no knowledge of the era: on a 2025 connection `oninitialized` comes first; on a `2026-07-28` connection `oninitialized` never fires and the first tool request writes it.
   - **Measured**: at factory time the getter is undefined in both eras; in `oninitialized` on a 2025 connection it is the negotiated version (`2025-06-18` when that was asked); inside a handler on a `2026-07-28` connection it is `2026-07-28`; an instance built for `server/discover` and then discarded on fallback closes without serving a tool request.

4. **The serving function** (suggested: in `src/entry.ts`, beside `runEntry`; the name is the Developer's).
   - `serveStdio((ctx) => app.<factory>(), transport ? { transport } : undefined)`, returning the handle. Do not pass `legacy`, and do not pass `onerror`: today a transport error on the one server is dropped (`Server.onerror` is unset), and this leg adds no new diagnostics beyond DD9's line. Read the SDK's source for what `serveStdio` does with an out-of-band error when no `onerror` is given, and record it in the flight log; if it does anything other than drop it (writes to stdout or stderr, throws), report that as a finding before landing.
   - `serveStdio` returns the handle synchronously; `runEntry`'s `serve` is `async`, so wrapping is trivial.
   - `src/index.ts` drops its `StdioServerTransport` import.

5. **Existing tests** (`test/server.test.ts`).
   - The two that connect `app.server`: replace `app.server.connect(serverSide)` with a call of the serving function with `serverSide`, and close the handle at the end of the test (or let the client's close do it, if that leaves no live instance; assert whichever is true once, in AC16's test).
   - **Measured**: `serveStdio(factory, { transport })` accepts one half of the client package's `InMemoryTransport` pair without a cast (tsc 7.0.2, strict).
   - The one that replaces `a.server.sendToolListChanged`: replace the announcing method on `a` instead.

6. **New tests** (suggested: a new `describe` in `test/server.test.ts` after `describe("over the MCP protocol")`, or a new file; reuse that file's `App` setup with `FakeDocker` and the seeded `demo` project).
   - A raw double here is the *client* side: a linked pair whose client half has `onmessage` set and `start()` called, sending JSON-RPC by hand and collecting what comes back. Envelope for a `2026-07-28` request, **measured**: in `params._meta`, the keys `io.modelcontextprotocol/protocolVersion` (`"2026-07-28"`), `io.modelcontextprotocol/clientCapabilities` (`{}`) and `io.modelcontextprotocol/clientInfo` (`{ name, version }`). `server/discover` takes the same envelope.
   - AC11: the existing test already drives `uninstall_project` and waits 20 ms with a real timer; that test stays as it is. For the new tests prefer awaiting the notification (a promise resolved by the handler) over a timer. For `install_project`, look at how `describe("install_project joining a running install")` and the installer tests complete an install with the Docker double; the announcement is in the job's `finally`, so a call that waits for the job sees it before its own answer, and only a call that returned "still installing" (a small `wait_seconds`, or a second call joining a running job) sees it afterwards. AC11 wants both.
   - New tests do not call `app.start()`, and each closes its client and its serving handle before it ends. **Checked at design review**: `onclose` has already fired when `await client.close()` resolves and when `await handle.close()` resolves, so `connections` can be read at once, with no timer.
   - AC13: **measured**: notifications on a connection are written before a later request's answer, so "request, then look" is a sound way to assert that none came.
   - AC15: after the fallback, read the live count, trigger a change, and count `notifications/tools/list_changed` messages on the raw half.
   - AC19: drive `server/discover` raw, look at `log`, then send an enveloped `tools/list`, look again.

7. **The pipe check** (AC23). Save this in a temporary directory outside the repository and run it with `bash <file>` from the repository root, after `npm run build`. It is not committed; paste its text and its output into the flight log.

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

   The Flight Director ran this script against leg 1's build on 2026-11-17 to test its plumbing: it printed PASS for the two checks leg 1 already meets (b's answers, c's answer) and FAIL for the four that need this leg, and exited 1. After this leg all six must print PASS and the last line must be `RESULT: PASS`. If the script has to change, say what changed and why, and keep each check as strict.

8. **README and CI.** Last. The README's sentences are short and concrete; match them. Count the flight's new unit tests as (passed now) minus 833.

9. **Flight log**: a `### serve-both-eras` entry under Leg Progress, with the runs, the script and its output, the test-by-test source edits, anything measured here that did not hold, and the CI arithmetic. Tick this leg's checkpoint in the flight spec. Set the leg `landed`. Do not commit.

## Edge Cases
- **An instance closes while an announcement is going out**: the copy of the set and the swallowed rejection cover it; AC16.
- **The factory is called twice for one connection** (probe, then fallback): the first instance's `onclose` fires before the second is built (**measured**), so the set holds one. AC15.
- **`oninitialized` and a tool request both call the line's closure**: the boolean makes it once. A 2025 client that sends a tool request without `notifications/initialized` still gets its line from the handler.
- **`announce` before any connection** (the watcher fires at 5 s whether or not a client has connected): nothing live, nothing done. AC4.
- **A `2026-07-28` client opens more than 1024 subscriptions**: the SDK's default limit answers in band. Not configured, not tested.
- **`handle.close()` when the connection already ended** (stdin closed first): **measured**: resolves, and resolves again on a second call. `test/entry.test.ts` covers the wiring's side.
- **The watcher's interval and a test**: tests that call the serving function do not need `app.start()`. Do not start the watcher in a test that asserts an exact count of announcements.
- **An install's progress when two instances are live, or after its connection closed**: the job keeps the progress callback of the call that started it, so progress goes only to that call's connection, and after that connection closes each send fails and is swallowed by the callback's own `catch`. That is today's behavior with one connection and is not changed or tested here.
- **An instance whose `onclose` never fires** would stay in the set. The leg relies on `onclose` firing, which the design review observed on client close, on handle close and on a discarded probe instance. Announcing to a dead instance is swallowed, so the cost would be bounded.
- **A test that leaves a live instance or an open pair**: close the handle in the test's cleanup, so that one test's instance cannot receive another's announcement through a shared `App`.

## Files Affected
- `src/server.ts` - factory, live set, announcing method, diagnostics line; `server` property removed
- `src/entry.ts` - the serving function (or a new module; the Developer's choice)
- `src/index.ts` - serve through it
- `test/server.test.ts` - three existing tests re-pointed; new tests (or a new test file for them)
- `README.md` - one new section, two notes
- `.github/workflows/ci.yml` - floor and comment
- `sorties/05-serve-the-2026-07-28-protocol/flight-log.md`, `flight.md` (leg 2 checkpoint only)

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.

---

## Citation Audit
2026-11-17, by the Flight Director and by the Developer's design review, against the working tree with leg 1 landed. Found as cited: the eight `sendToolListChanged` sites; `app.server` read at two places in `src/index.ts` and three in `test/server.test.ts`, and nowhere in `test/integration`; the four quoted test names and the `expect(lines).toEqual` in `describe("an unusable value")`; the floor 810 and the comment's 831 in `.github/workflows/ci.yml`; the three README headings; `runEntry` and `Serving` in `src/entry.ts`. One correction made before the review: a test name in AC22 was quoted from memory and was wrong. The design review re-ran the six v2 observations this leg leans on (in-memory `serveStdio`; the getter's value at factory time, in `oninitialized` and in a handler; the envelope keys and the discarded probe instance; subscription-gated announcements; the client's `pin` and `auto` modes; notifications arriving before a later request's answer) and confirmed each.

