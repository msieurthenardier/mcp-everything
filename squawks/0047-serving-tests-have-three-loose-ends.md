# Squawk 0047: Three loose ends in the serving tests

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: —

## Report
In `test/serving.test.ts`, added by sortie 05: a `setImmediate` wait that orders nothing (the stub has already emitted its progress when it runs); the last test builds an instance with `app.createServer()` and never closes it, so it stays in the app's live set until the app is dropped; and one assertion that a count is 1 straight after a waited install returns, which leans on the in-memory transport's microtask order and would be the first to break on a library change. Remove the wait, close the instance (or say in the test why it cannot be closed: an unconnected instance has no transport to close), and make the third wait on the notification as the tests beside it do. Tests only; no assertion is weakened.

## Evidence
- `test/serving.test.ts` — `await new Promise((res) => setImmediate(res));`
- `test/serving.test.ts` — `const s = app.createServer();` in the last test, with no `close`.
- `test/serving.test.ts`, the test of a 2025 client and an install that waited — `count()` asserted with `toBe(1)` immediately after `callTool` resolves.
- Read by the debrief's Developer, not mutated. Debrief, Technical 6.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
