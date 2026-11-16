# Leg: bounded-shutdown

**Status**: completed
**Flight**: [Install Failure and Interruption Paths](../flight.md)

## Objective
Make the server process exit within a fixed time after it is told to stop, whatever closing the proxied servers does, and make a second stop signal do nothing.

## Context
- Finding 4c of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md), as restated in the flight's Technical Approach.
- Flight decisions that bind this leg: shutdown is bounded by a short deadline; a second signal does not start a second shutdown; **an install in flight is not waited for** (the previous leg's reconciliation cleans up after it). The deadline's length is an acceptable variation.
- Legs 1 and 2 landed. This leg does not depend on their code. One thing leg 2 added matters for the hand check below: `App.start()` now reconciles stale installs in the data directory it is given, which is one more reason that check must never run against the real one.
- The operator's live mcp-everything instance runs from this checkout's `dist/` and `node_modules/`. Never run `npm install`, `npm ci` or `npm run build` here.

Ground truth, read on 2026-11-16:

- `src/index.ts:13-18`: the handler is
  `const shutdown = () => { void app.shutdown().then(() => app.server.close()).finally(() => process.exit(0)); };`
  registered for `process.stdin` `end`, `SIGINT` and `SIGTERM` (`index.ts:20-22`). There is no timer: if `app.shutdown()` never settles, `process.exit` is never reached. Each further signal calls `app.shutdown()` again.
- `App.shutdown` (`src/server.ts`, `async shutdown()`): stops the registry watcher and awaits `proxy.closeAll()`.
- `McpProxy.closeAll` (`src/proxy/mcp-proxy.ts:310`) closes every session in parallel. `closeSession` (`:231`) awaits `session.client.close()` (no limit of its own) and then `kill` (`:137`), a `docker exec` with `timeoutSec: 10` (the host-side backstop in `Docker.execOnce` adds 15 s).
- `src/index.ts` runs `main()` when imported and connects a stdio transport, so no unit test imports it. Nothing in `test/` covers the handler.
- `tsconfig.build.json` builds `src/` only; `npx tsc -p tsconfig.build.json --outDir <dir>` writes a build elsewhere without touching `dist/` (flight 01 used this).

## Inputs
- Legs 1 and 2 landed, uncommitted, in the working tree.

## Outputs
- A small new module (for example `src/shutdown.ts`) holding the bounded, run-once shutdown, with unit tests (`test/shutdown.test.ts`).
- `src/index.ts` using it.

## Acceptance Criteria
- [x] The shutdown logic is a function that takes what it needs as arguments (the close step, the exit function, the deadline, a logger) and does not touch `process` itself, so it is tested without a real process.
- [x] **Normal stop**: when the close step settles before the deadline, exit is called once with code 0, and the deadline timer is cleared (no second exit call when time passes).
- [x] **Close step rejects**: exit is called once with code 0, as today.
- [x] **Hung close**: when the close step never settles, exit is called once with code 1 when the deadline passes and not before, and one line is logged saying shutdown did not finish within that time.
- [x] **Second signal**: calling the handler again while the first shutdown is pending, or after it finished, does not call the close step again and does not arm a second timer.
- [x] The deadline is one named constant, 15 seconds, with a comment saying what it is measured against (the 10-second limit of the proxy's kill step).
- [x] `src/index.ts` registers that one handler for `stdin` `end`, `SIGINT` and `SIGTERM`; its close step is `app.shutdown()` followed by `app.server.close()`, as today; nothing else in `main()` changes.
- [x] An install in flight is not awaited, and nothing is added to `App.shutdown`.
- [x] `npm run typecheck` is clean. `npx vitest run --testTimeout 20000` passes with more passed than before this leg and the same number skipped.
- [x] By hand, once, on a scratch build outside the repository (see Verification): the process exits with code 0 within two seconds of one `SIGTERM`, and the same when two `SIGTERM`s are sent 100 ms apart.

## Verification Steps
- `npm run typecheck`; `npx vitest run --testTimeout 20000`; record the counts.
- The unit cases use vitest's fake timers; none waits 15 real seconds. Confirm by the file's run time.
- The hand check. Everything goes in the scratch directory you were given, never in the repository:
  1. `npx tsc -p tsconfig.build.json --outDir <scratch>/shutdown-build`
  2. `ln -s "$PWD/node_modules" <scratch>/node_modules` (read-only use; ES module resolution walks up from the build directory and finds it).
  3. Copy `package.json` to `<scratch>/package.json` if the build needs `"type": "module"` or reads its version from it.
  4. Start it with its **own data directory and name prefix**, stdin held open, for example:
     `MCPE_DATA_DIR=<scratch>/shutdown-data MCPE_NAME_PREFIX=mcpe-it-shutdown- node <scratch>/shutdown-build/index.js < <(sleep 30) & pid=$!`
     **Never start it without `MCPE_DATA_DIR` pointing into the scratch directory.** Without it the process would open the operator's real registry.
  5. `sleep 1; kill -TERM $pid; wait $pid; echo $?` prints 0, promptly. Repeat with `kill -TERM $pid; sleep 0.1; kill -TERM $pid 2>/dev/null`.
  6. Remove the scratch build, the symlink and the data directory.
  Record the commands and their results in the flight log. If the scratch build cannot be made to run, say why and record that the wiring in `src/index.ts` was verified by reading only.
- `git diff --stat`: only the files under Files Affected, on top of the earlier legs'.

## Implementation Guidance

1. **The function.** Something like `boundedShutdown(opts: { close: () => Promise<unknown>; exit: (code: number) => void; deadlineMs: number; log?: (line: string) => void }): () => void`. The returned handler: if already started, return. Otherwise mark started, arm a timer for `deadlineMs` whose callback logs and calls `exit(1)`, and run `close()`; when it settles either way, clear the timer and call `exit(0)`. Guard against both paths calling `exit` (in tests `exit` returns). A `close` that throws synchronously counts as a rejection.
2. **Do not `unref` the timer.** It must fire even when the hung close step holds nothing that keeps the event loop alive.
3. **`src/index.ts`**: build the handler once after the transport is connected, with `process.exit`, the constant, and the same stderr logger `main()` already uses.
4. **Tests** in `test/shutdown.test.ts` with `vi.useFakeTimers()`: one case per behavior in the criteria. For "not before", advance to one millisecond short of the deadline and assert no exit.
5. **README**: nothing describes shutdown today (`grep -n "shutdown\|SIGTERM" README.md` finds nothing). Add nothing.
6. **Flight log**: under Leg Progress, as the earlier legs did.

## Edge Cases
- **The close step settles after the deadline fired**: `exit(1)` was already called; do not call `exit(0)` as well. (In production `process.exit` does not return, so this only shows in tests.)
- **The handler is called from three sources** (`stdin` end and two signals) in quick succession when a client closes the pipe and signals: one shutdown.
- **`app.server.close()` hangs instead of `app.shutdown()`**: it is inside the same close step, so the same deadline covers it.
- **Exit code 1 on the deadline** is new. It tells whoever started the process that the stop was not clean; a clean stop still exits 0.

## Files Affected
- `src/shutdown.ts` — new
- `src/index.ts` — the handler
- `test/shutdown.test.ts` — new

## Out of Scope
- Waiting for, cancelling or logging installs in flight.
- A limit inside `McpProxy.closeSession` or on `client.close()`.
- Squawk 0027 (the stack trace printed by `main().catch`), which touches the same file. Leave `main().catch` as it is.

## Citation Audit
Checked on 2026-11-16 by reading: `src/index.ts:13-18`, `:20-22`; `src/proxy/mcp-proxy.ts:137`, `:231`, `:310`. Re-checked against the working tree after leg 2 landed: neither file was touched by legs 1 or 2. No drift.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
