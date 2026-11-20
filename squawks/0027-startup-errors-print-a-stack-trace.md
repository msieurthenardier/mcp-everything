# Squawk 0027: A configuration error at startup is followed by a stack trace

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
When mcp-everything refuses to start because a setting is invalid, the one line the operator needs is followed by seven lines of stack, including the absolute path it is installed at, in the client's log. The message is correct and the process exits with status 1; the noise is the defect. Raised by the Reviewer of the 2026-11-16 squawk turnaround (squawk 0015 made an invalid `MCPE_NAME_PREFIX` a startup error) and carried into the [flight 01 debrief](../missions/01-maintenance/flights/01-ci-gate/flight-debrief.md).

For an error that reports an invalid setting, print the message without the stack. Keep the stack for anything unexpected, where it is the only clue. The configuration errors are plain `Error` today, so they need a way to be told apart (their own error class is the obvious one). Exit status and message text do not change.

Added on 2026-11-16, at the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md): that flight added a startup error of the same kind. An `installation-id` file that does not hold a valid id, or a data directory that cannot be made or read, throws a plain `Error` from `loadInstallationId` (`src/installation.ts`) when `App` is constructed, and its message, which tells the operator what to do, is followed by the same stack. Cover it with the configuration errors. Read, not run.

## Evidence
- `src/index.ts` — `main().catch((e) => { process.stderr.write(`[mcp-everything] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`); process.exit(1); });`
- `src/config.ts` — three `throw new Error(…)` sites: two for `MCPE_EXTRA_HOSTS`, one in `parseNamePrefix`.
- Run on 2026-11-16: `MCPE_NAME_PREFIX=Bad- node dist/index.js </dev/null` writes `[mcp-everything] fatal: Error: MCPE_NAME_PREFIX="Bad-" is not valid: use 1-31 characters from [a-z0-9_.-], starting with a letter or digit.` and then seven `    at …` lines, the first three naming files under the installation directory.

## Corrective Action
A `ConfigError` class (new `src/errors.ts`) now marks errors that report an invalid setting or an unusable data directory. The three `throw`s in `src/config.ts` (two for `MCPE_EXTRA_HOSTS`, one in `parseNamePrefix`) and the two id-file errors in `loadInstallationId` (invalid file; directory or file that cannot be made or read) throw it. `src/errors.ts` also holds `formatFatal`, which `src/index.ts`'s fatal handler now calls: a `ConfigError` prints as one line, anything else keeps its stack (or `String(e)` if not an `Error`). A formatter in its own module keeps the handler testable without spawning the process. Message text and exit status 1 are unchanged; the one line still reads `[mcp-everything] fatal: Error: <message>`, identical to the first line printed before (the `Error: ` prefix is kept deliberately), so only the stack lines are gone.

## Verification
- Tests: `test/errors.test.ts` (formatter: ConfigError is one line with the old `Error: ` prefix, other errors keep the stack, non-Error values print as strings); `test/config.test.ts` and `test/installation.test.ts` show each throw site throws `ConfigError`. Proved to bite: with the `MCPE_EXTRA_HOSTS` invalid-host throw reverted to `Error` and the formatter's ConfigError branch disabled, the config test and the formatter test failed; both undone by editing. `npm run typecheck` clean; `npm test`: 929 passed, 24 skipped.
- End to end on a build in a scratch worktree (this checkout's `dist/` untouched; worktree removed):
  - `MCPE_NAME_PREFIX=Bad- node dist/index.js </dev/null` printed one line, `[mcp-everything] fatal: Error: MCPE_NAME_PREFIX="Bad-" is not valid: use 1-31 characters from [a-z0-9_.-], starting with a letter or digit.`, exit 1.
  - `MCPE_DATA_DIR=<scratch dir holding installation-id "bad"> node dist/index.js </dev/null` printed one line, `[mcp-everything] fatal: Error: The installation id file <dir>/installation-id does not hold a valid id (eight lowercase hexadecimal characters). Restore it from a backup or, if no sandbox belongs to this data directory, delete it so a new one is made.`, exit 1.
  - `MCPE_EXTRA_HOSTS=x=svn` printed one line, `... fatal: Error: MCPE_EXTRA_HOSTS: "x" must be =github or =gitlab`, exit 1.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: all three `src/config.ts` throws and both `loadInstallationId` errors use `ConfigError`; message text, the `Error: ` prefix and exit status are unchanged; unexpected errors keep their stack. Reverting the class failed five tests and a stack-printing formatter failed the formatter test. The Reviewer noted that `prepareDataDir`, which runs before the id module, still throws a plain `Error`; it is outside this squawk's Report and is logged as squawk [0049](0049-unmakeable-data-directory-prints-a-stack-trace.md).
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
