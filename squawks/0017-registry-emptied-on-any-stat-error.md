# Squawk 0017: The registry is emptied in memory on any stat error, not only a missing file

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
`Registry.refresh` treats every failure of `statSync` as "the file is gone" and empties the in-memory registry. A missing file is meant to do that, and a test covers it. A permissions or I/O error is not the file being gone, and it is neither reported nor logged: the caller sees an empty project list. Finding 6b of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Empty the registry only when the error is `ENOENT`; rethrow anything else, as the unreadable-file branch below it already does.

## Evidence
- `src/registry.ts:Registry.refresh` — `try { stat = fs.statSync(this.file); } catch { … this.projects = new Map(); this.mtimeMs = -1; return true; }` — a bare `catch`.
- Run on 2026-11-15 against `dist/registry.js` in a scratch directory: with the directory set to mode 000, `refresh()` left `list()` empty.
- Read: `mutate()` calls `refresh()` and a throw there already happens for a corrupt file (`test/registry.test.ts`, the unreadable case); the watcher in `src/server.ts` catches a throw from `refresh()`.

## Corrective Action
`Registry.refresh` in `src/registry.ts` now empties the in-memory registry only when `statSync` fails with `ENOENT`. Any other error throws `Registry file <path> could not be examined: <message>`, in the same style as the unreadable-file branch, and leaves the in-memory projects untouched.

## Verification
Callers checked before the change: `mutate()` calls `refresh()` inside `try/finally`, so a throw still releases the lock (same as the corrupt-file case). `Server.start` catches and logs; the 5s watcher catches and ignores; `callTool` catches and returns `Error: ...`; `Installer.install` lets it reject, as it already does for a corrupt file. No caller crashes or leaks a lock that it did not before; only an error message changes.

Test first: added "throws on a stat error other than ENOENT and keeps the records it has" to `test/registry.test.ts` (spies on `fs.statSync` for the registry path to throw `EACCES`, restored in `finally`). It failed before the fix. After: `npx vitest run --testTimeout 20000` gave 350 passed, 17 skipped (was 349); `npm run typecheck` clean. The existing file-disappears case passes unchanged.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
