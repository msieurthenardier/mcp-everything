# Squawk 0027: A configuration error at startup is followed by a stack trace

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
When mcp-everything refuses to start because a setting is invalid, the one line the operator needs is followed by seven lines of stack, including the absolute path it is installed at, in the client's log. The message is correct and the process exits with status 1; the noise is the defect. Raised by the Reviewer of the 2026-11-16 squawk turnaround (squawk 0015 made an invalid `MCPE_NAME_PREFIX` a startup error) and carried into the [flight 01 debrief](../missions/01-maintenance/flights/01-ci-gate/flight-debrief.md).

For an error that reports an invalid setting, print the message without the stack. Keep the stack for anything unexpected, where it is the only clue. The configuration errors are plain `Error` today, so they need a way to be told apart (their own error class is the obvious one). Exit status and message text do not change.

## Evidence
- `src/index.ts` — `main().catch((e) => { process.stderr.write(`[mcp-everything] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });`
- `src/config.ts` — three `throw new Error(…)` sites: two for `MCPE_EXTRA_HOSTS`, one in `parseNamePrefix`.
- Run on 2026-11-16: `MCPE_NAME_PREFIX=Bad- node dist/index.js </dev/null` writes `[mcp-everything] fatal: Error: MCPE_NAME_PREFIX="Bad-" is not valid: use 1-31 characters from [a-z0-9_.-], starting with a letter or digit.` and then seven `    at …` lines, the first three naming files under the installation directory.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
