# Squawk 0005: The Reviewer's prompt does not carry the rule for the fork-pressure cases

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

## Report
The operator ruled during sortie 02's review that the fork-pressure integration cases are too slow for every review and are to be run only when the watchdog code is touched. That rule is recorded in sortie 02's flight log and, as guidance for developers, in the README. It is not in the place a review is actually driven from: the Review prompt in the project's crew file. A Reviewer spawned from that prompt has no way to know the cases exist, that the default Docker suite skips them, or when they are required. Raised in the sortie 02 debrief (Recommendation 1).

Add the rule to the crew file's Review prompt: run `npm run test:docker:pressure` when the diff touches the watchdog script, its tests, or the images sandboxes run on; otherwise do not. The debrief notes that an image or shell update is the likeliest way to break the guard without touching the script, which is why images are in the trigger list.

## Evidence
- `.flightops/agent-crews/leg-execution.md` — `### Reviewer: Review` prompt: five numbered evaluation points and the signal instructions; no project-specific test guidance
- `sorties/02-watchdog-survives-fork-failure/flight-log.md` — "Standing instruction from the operator, for later flights"
- `README.md`, `## Development` — "`npm run test:docker` skips the fork-pressure cases; run them with `npm run test:docker:pressure` when the idle watchdog (the sandbox entrypoint script) or its tests change."
- `.flightops/README.md` — crew files are project-specific and not overwritten by plugin sync

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)* Expected: the Review prompt states the rule; the crew file still has its `## Crew`, `## Interaction Protocol` and `## Prompts` sections with every prompt in a fenced block.

## Sign-Off
*(written at completion)*
**Reviewer**:
**Verdict**:
**Commit**:
