# Squawk 0061: `project_info` shows `network: unknown` for a sandbox made before ownership was recorded

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-24
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
Since mission 03 flight 04, a sandbox made before ownership was recorded is refused at the one gate. That includes the read-only inspect behind `project_info`'s network line, so the line reads `network: unknown`.
- The owner line further down explains the cause, but the network line itself does not.
- `unknown` reads like a Docker failure.
- Seen at flight 4's HAT on the operator's old `gron` sandbox.

## Evidence
- `src/server.ts:1500-1502`: `stateRead` is `this.docker.networkState(project.container).catch((): "unknown" => "unknown")`. A `SandboxRefusedError` with `reason: "before"` is folded into `unknown` like any other error.
- `src/server.ts:1095` (`describe`) renders it as `network: ${view}`.
- Flight 4's debrief (Architect interview, recommendation 2).

## Corrective Action
`src/server.ts`, the `project_info` case (`stateRead`): a `SandboxRefusedError` with `reason === "before"` from `networkState` maps to a new `"not-inspected"` view; any other error still maps to `"unknown"`. `describe` renders `"not-inspected"` as `network: not inspected (made before ownership was recorded; see the owner line)`. `SandboxRefusedError` is now imported from `./sandbox/ownership.js`.

## Verification
- `test/server.test.ts`, "refusal outcomes ... project_info", "network line: a sandbox made before ownership says it was not inspected and why; another error still says unknown": asserts the new line for a `before` refusal and `network: unknown` for a plain Error.
- `npm run typecheck`, `npm run build`: clean. `timeout 600 npm test`: 40 files passed, 2 skipped; 2961 tests passed, 72 skipped, 0 failed. `npm run test:slow`: 2 files, 115 passed.

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at mission 03 flight 04's debrief. Carry it to the next squawk turnaround, or to flight 5 if that flight touches `project_info`.
