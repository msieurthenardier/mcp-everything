# Squawk 0047: Three loose ends in the serving tests

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: 2026-11-17

## Report
In `test/serving.test.ts`, added by sortie 05: a `setImmediate` wait that orders nothing (the stub has already emitted its progress when it runs); the last test builds an instance with `app.createServer()` and never closes it, so it stays in the app's live set until the app is dropped; and one assertion that a count is 1 straight after a waited install returns, which leans on the in-memory transport's microtask order and would be the first to break on a library change. Remove the wait, close the instance (or say in the test why it cannot be closed: an unconnected instance has no transport to close), and make the third wait on the notification as the tests beside it do. Tests only; no assertion is weakened.

## Evidence
- `test/serving.test.ts` — `await new Promise((res) => setImmediate(res));`
- `test/serving.test.ts` — `const s = app.createServer();` in the last test, with no `close`.
- `test/serving.test.ts`, the test of a 2025 client and an install that waited — `count()` asserted with `toBe(1)` immediately after `callTool` resolves.
- Read by the debrief's Developer, not mutated. Debrief, Technical 6.

## Corrective Action
Only `test/serving.test.ts` changed.
1. The `setImmediate` wait before `s.open()` in the progress test is removed. The squawk's premise held: the stub emits its progress synchronously before it awaits the gate, so the wait ordered nothing. Without it the file passed five runs in a row. Property before and after: every progress notification reaches the wire before the call's result, and the messages are "cloning", "building" (unchanged).
2. The last test ("is not written ... negotiated nothing") still does not close its instance, and now says why in a comment. I tried `await s.close()` followed by `expect(app.connections).toBe(0)`: it failed with 1, because an instance that was never connected has no transport, so `onclose` never fires and the instance stays in the live set. Nothing leaks to another test: `app` is rebuilt in `beforeEach`. Assertions are unchanged (no throw from `oninitialized`, no connection line).
3. The test "reaches a 2025 client before the answer of an install that waited for its job" no longer asserts `count() === 1` straight after `callTool` resolves. The name claims an order (notification before the answer), so waiting for the notification after the answer would have weakened it. It now drives the 2025 handshake by hand on the `raw()` helper (`initialize("2025-11-25")`, `notifications/initialized`, then `tools/call` of `install_project`) and reads the order off the wire: exactly one `notifications/tools/list_changed` in the received messages, and its index is below the answer's index. Property before: one notification had been handled by the time the call resolved (which leaned on the transport's microtask order). After: the notification is received before the answer, as a fact about the arrival order of messages, with no dependence on when a handler runs. One difference to name: the test no longer goes through the SDK client class; the 2025 era is still what is spoken, and other tests keep the real-client path.

## Verification
- `for i in 1 2 3 4 5` of `timeout 120 npx vitest run test/serving.test.ts`: with only the `setImmediate` removed, 5 of 5 runs 24 passed. With all three changes, 5 of 5 runs 24 passed.
- Close attempt for loose end 2: failed as described above (expected 1 to be 0), which is why it is a comment.
- Mutations in `src/server.ts`, each undone by editing (md5 of `src/server.ts` is back to its starting value):
  - 3: removed the `announceToolListChanged()` in the install job's `finally`: the changed test fails (and three other list-change tests).
  - 1: `callTool(name, args, undefined)` in the `tools/call` handler (no progress sent): the progress test fails (1 failed, 23 passed).
  - 2: dropped the `if (version === undefined) return;` guard in `noteConnection`: the "negotiated nothing" test fails (1 failed, 23 passed).
- Final: `npm run typecheck` clean; `timeout 120 npm test` 915 passed, 24 skipped (unchanged); `npm run build` clean.


## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it confirmed no assertion was weakened: the rewritten test still proves the announcement is on the wire before the install's answer (delaying the announcement by 100 ms failed it), a 2025 client is still covered through the real `Client` elsewhere in the file, and the comment about an unconnected instance is accurate.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048.
