# Squawk 0049: A data directory that cannot be made still prints a stack trace at startup

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-19
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
Squawk 0027 made configuration errors at startup print one line without a stack, through `ConfigError`, and covered a data directory that cannot be made or read where `loadInstallationId` meets it. But the entry makes the data directory itself before `App` is built, with a plain `fs.mkdirSync`, so an `MCPE_DATA_DIR` that cannot be created (a path under a file, a parent without write permission) fails there first, as a plain `Error`, and the operator gets the stack trace 0027 removed everywhere else. Found by the Reviewer of the 2026-11-19 second turnaround, outside that batch's diff. Read, not run.

Throw a `ConfigError` naming the directory and the cause when `prepareDataDir` cannot make it, as the id module does for the same condition. Exit status stays 1.

## Evidence
- `src/index.ts`, `main` — `prepareDataDir(cfg.dataDir);` before `new App(…)`.
- `src/server.ts`, `prepareDataDir` — `fs.mkdirSync(dir, { recursive: true, mode: 0o700 });`, no `try`.
- `src/errors.ts`, `formatFatal` — prints the stack for anything that is not a `ConfigError`.

## Corrective Action
`src/server.ts`, `prepareDataDir`: the `fs.mkdirSync` is wrapped in `try`/`catch` and a failure throws `ConfigError("Cannot make the data directory <dir>: <cause>")` (`ConfigError` imported from `./errors.js`). `formatFatal` already prints a `ConfigError` on one line without a stack; the entry's exit status is unchanged.

## Verification
- `test/installation.test.ts`, "prepareDataDir: a data directory that cannot be made is a ConfigError": a path under a regular file throws `ConfigError` naming the directory, and `formatFatal` gives the one line with no stack.
- `npm run typecheck`, `npm run build`: clean. `timeout 600 npm test`: 40 files passed, 2 skipped; 2961 tests passed, 72 skipped, 0 failed. `npm run test:slow`: 2 files, 115 passed.

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.
