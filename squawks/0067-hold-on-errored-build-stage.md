# Squawk 0067: A check after the build that could not run does not hold the project

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
If `runScanners` throws at the build stage (for example, Docker fails to answer the volume inspect), the throw reaches `settleFailure`. The record ends up `failed` with no `scan.build`, so `assertNotBlocked` does not hold it, and the failed-install advice tells the agent to repair it with `sandbox_exec` and run `discover_tools`. That would publish output that was never checked.

The operator decided at mission 03's debrief that a stage that could not run holds the project as a block does. The rule that a failed scanner never blocks stays for individual scanners.

## Evidence
- `src/install/installer.ts:615-621`: the comment that accepts the throw path, and the `runScanners` call over the install's own volume.
- `missions/03-vetted-and-contained-installs/mission-debrief.md`, "Decisions at this Debrief".
- `src/scan/types.ts`, `buildReport`: holds only `decision.verdict === "block"`.

## Corrective Action
In `src/install/installer.ts`, `finishInstall` now wraps the build stage's `runScanners` and `decide` in a try/catch. A throw stores `scan.build` with one `failed` outcome (`name: "after-build"`, `kind: "builtin"`, error from `oneLine(cleanTerminalText(message), 300)`) and a decision:
- **Under `block`:** verdict `"block"`, reason "the check after the build could not run (<message>)". It goes through the existing block ending (offline, `failed`, held).
- **Under `warn`:** `decide` over the failed outcome gives verdict `"build"`, and the install continues with the failure reported.

The comment at the call was rewritten, and `ScanDecision` was added to the imports. `docs/checking.md` (after "Only checks that ran or came out incomplete count…") now states the exception for a stage that cannot run. No new verdict kind and no new field.

## Verification
In `test/installer.test.ts`, the old test ("reaches settleFailure: … not held") became `describe("a throw out of the stage")` with two cases, using a scripted refusal that rises out of `runScanners`:
- under `block`: `failed`, `network` false (record and file), `scan.build` holds one `after-build` failed check with a `block` decision, `assertNotBlocked` throws, and `rediscover` is refused;
- under `warn`: `ready`, with the `after-build` failed check and a `build` verdict stored (record and file).

Both pass in isolation (`npx vitest run test/installer.test.ts -t "a throw out of the stage"`). `npm run typecheck` and `npm run build` are clean. `npm test`: 2959 passed, 72 skipped, 0 failed on the last two runs. One earlier run had one failure in `test/scan-sarif.test.ts` (the 2.8 MB document case near line 244), which was not seen again on three reruns and is outside this change. `npm run test:slow`: 115 passed.

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at the routine maintenance of 2026-11-25, from mission 03's debrief (follow-up A).
