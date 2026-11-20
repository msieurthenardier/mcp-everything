# Squawk 0049: A data directory that cannot be made still prints a stack trace at startup

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-19
**Completed**: —

## Report
Squawk 0027 made configuration errors at startup print one line without a stack, through `ConfigError`, and covered a data directory that cannot be made or read where `loadInstallationId` meets it. But the entry makes the data directory itself before `App` is built, with a plain `fs.mkdirSync`, so an `MCPE_DATA_DIR` that cannot be created (a path under a file, a parent without write permission) fails there first, as a plain `Error`, and the operator gets the stack trace 0027 removed everywhere else. Found by the Reviewer of the 2026-11-19 second turnaround, outside that batch's diff. Read, not run.

Throw a `ConfigError` naming the directory and the cause when `prepareDataDir` cannot make it, as the id module does for the same condition. Exit status stays 1.

## Evidence
- `src/index.ts`, `main` — `prepareDataDir(cfg.dataDir);` before `new App(…)`.
- `src/server.ts`, `prepareDataDir` — `fs.mkdirSync(dir, { recursive: true, mode: 0o700 });`, no `try`.
- `src/errors.ts`, `formatFatal` — prints the stack for anything that is not a `ConfigError`.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
