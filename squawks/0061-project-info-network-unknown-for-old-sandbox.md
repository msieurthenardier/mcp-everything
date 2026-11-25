# Squawk 0061: `project_info` shows `network: unknown` for a sandbox made before ownership was recorded

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-24
**Completed**: —

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
*(to be filled in on completion)*: for a refusal whose reason is `before`, `project_info`'s network line says the network was not inspected and why. For example: `network: not inspected (made before ownership was recorded; see the owner line)`. Other errors still give `unknown`.

## Verification
*(to be filled in on completion)*: a `test/server.test.ts` case for `project_info` on a `before` sandbox asserting the new network line, plus the existing `unknown` case for an ordinary Docker error.

## Sign-Off
*(to be filled in on completion)*

## Disposition
Logged at mission 03 flight 04's debrief. Carry it to the next squawk turnaround, or to flight 5 if that flight touches `project_info`.
